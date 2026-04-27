/**
 * Shared helpers for building Playwright launch + context options and
 * applying anti-detection init scripts. Deduplicates the stealth/device/
 * storage setup that CLI and MCP each reimplemented with subtle drift.
 *
 * Invariant: "stealth" here always means the full triple — override
 * navigator.webdriver, spoof plugins, and override languages. Earlier
 * code had partial stealth (just webdriver) in some places and full
 * stealth in others; the partial variant is easier to detect and worse
 * than nothing for consumers who asked for stealth. Converge on full.
 */

import type { Browser, BrowserContext } from "playwright";
import { resolve as resolvePath, relative as relativePath, isAbsolute } from "path";

/** UA we impersonate under stealth. Chrome-on-Windows because that's the
 *  most common real-traffic fingerprint and the least suspicious default
 *  for sites running bot-detection rules keyed on rare UAs. */
export const STEALTH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface LaunchOptionsInput {
  /** Default true. CLI can override via --no-headless. MCP is always headless. */
  headless?: boolean;
  /** Use an installed browser channel instead of bundled Chromium. */
  channel?: string;
}

export function buildLaunchOptions(opts: LaunchOptionsInput): Record<string, unknown> {
  const out: Record<string, unknown> = { headless: opts.headless !== false };
  if (opts.channel) out.channel = opts.channel;
  return out;
}

export interface ContextOptionsInput {
  stealth?: boolean;
  /** Explicit UA — overrides stealth's default UA if both are set. */
  userAgent?: string;
  /** Playwright storageState file path (for authenticated pages). */
  storageState?: string;
  /**
   * When true, reject storageState paths that resolve outside the current
   * working directory. MCP tools pass true (untrusted input). CLI passes
   * false (user explicitly wrote the flag). Centralized here so both
   * surfaces behave the same way when they opt into restriction.
   */
  restrictStorageStateToCwd?: boolean;
  /** Playwright device name, e.g. "iPhone 14". Resolved via pw.devices. */
  device?: string;
}

export interface ContextOptionsResult {
  options: Record<string, unknown>;
  /** Non-fatal validation problem — caller decides whether to surface as error. */
  error?: string;
}

/**
 * Build BrowserContext options. Pass in a live Playwright module so the
 * `devices` registry is available without this module taking a hard
 * dependency on playwright (keeps it importable in tests that stub pw).
 */
export function buildContextOptions(
  input: ContextOptionsInput,
  pw: { devices: Record<string, Record<string, unknown>> },
): ContextOptionsResult {
  const options: Record<string, unknown> = {};

  if (input.stealth) {
    options.userAgent = STEALTH_USER_AGENT;
    options.viewport = { width: 1440, height: 900 };
    options.locale = "en-US";
    options.timezoneId = "America/New_York";
  }

  // Explicit userAgent wins over stealth UA so users can opt into stealth
  // defaults but override one knob.
  if (input.userAgent) options.userAgent = input.userAgent;

  if (input.storageState) {
    if (input.restrictStorageStateToCwd) {
      const resolved = resolvePath(input.storageState);
      const rel = relativePath(process.cwd(), resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return {
          options,
          error: "storageState path must be within the current working directory",
        };
      }
      options.storageState = resolved;
    } else {
      options.storageState = input.storageState;
    }
  }

  if (input.device) {
    const dev = pw.devices[input.device];
    if (!dev) {
      return { options, error: `Unknown device: ${input.device}` };
    }
    Object.assign(options, dev);
  }

  return { options };
}

/**
 * Apply anti-detection init scripts. Caller must pass a context created
 * with stealth-friendly options (see buildContextOptions). Safe to call
 * multiple times; Playwright accumulates init scripts.
 */
export async function applyStealthInit(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5].map((i) => ({ name: `Plugin ${i}` })),
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });
}

/**
 * Convenience: acquire a browser. We can use the shared pool unless the
 * caller wants something the pool can't provide — a specific `channel`
 * (e.g., real Chrome instead of bundled Chromium) or headed mode. Stealth
 * alone is context-layer (UA override, init script, viewport) and doesn't
 * need a fresh launch, so those calls ride the pool and skip the ~2s
 * relaunch overhead per request.
 */
export interface AcquiredBrowser {
  browser: Browser;
  /** True if we launched this browser ourselves and caller must close it. */
  owned: boolean;
}

export async function acquireBrowser(
  input: { channel?: string; stealth?: boolean; headless?: boolean },
  opts: { useSharedPool: boolean },
): Promise<AcquiredBrowser> {
  const needsFreshLaunch =
    !opts.useSharedPool ||
    Boolean(input.channel) ||
    input.headless === false;
  if (needsFreshLaunch) {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch(buildLaunchOptions(input));
    return { browser, owned: true };
  }
  const { getSharedBrowser } = await import("./browser.js");
  return { browser: await getSharedBrowser(), owned: false };
}
