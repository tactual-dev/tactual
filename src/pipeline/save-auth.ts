/**
 * Pipeline: authenticate with a web app and save Playwright storageState
 * for later analyze_url runs. Shared across CLI and MCP.
 *
 * Step shapes are the canonical structure. CLI flags build the array;
 * MCP accepts the array directly (that's how its schema was already
 * shaped). Four step types:
 *
 *   { click: string }       — click by role/name/text, fallback to selector
 *   { fill: [string,string] } — fill(selector, value)
 *   { wait: number }        — waitForTimeout (ms, capped at 60s)
 *   { waitForUrl: string }  — page.waitForURL('**<pattern>**')
 *
 * Unknown step shapes error out rather than being silently skipped.
 */

import type { Browser, BrowserContext } from "playwright";
import { resolve as resolvePath, relative as relativePath, isAbsolute } from "path";
import { z } from "zod";
import { validateUrl } from "../core/url-validation.js";
import { acquireBrowser } from "../core/context-options.js";

export type AuthStep =
  | { click: string }
  | { fill: [string, string] }
  | { wait: number }
  | { waitForUrl: string };

const AuthStepSchema = z.union([
  z.object({ click: z.string().min(1) }).strict(),
  z.object({ fill: z.tuple([z.string().min(1), z.string()]) }).strict(),
  z.object({ wait: z.number().nonnegative() }).strict(),
  z.object({ waitForUrl: z.string().min(1) }).strict(),
]);

const AuthStepsSchema = z.array(AuthStepSchema);

export interface SaveAuthOptions {
  url: string;
  steps: AuthStep[] | Record<string, unknown>[];
  outputPath?: string;
  timeout?: number;
  /** MCP callers pass true; CLI passes false (explicit path choice). */
  restrictOutputToCwd?: boolean;
  /** File mode for the saved JSON. Defaults to 0o600. */
  fileMode?: number;
  /** Long-lived MCP/server callers can opt into the shared browser pool. */
  useSharedBrowserPool?: boolean;
}

export interface SaveAuthResult {
  saved: string;
  cookies: number;
  origins: number;
  currentUrl: string;
  message: string;
}

export class SaveAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid-url"
      | "invalid-step"
      | "invalid-output-path"
      | "runtime",
    message: string,
  ) {
    super(message);
    this.name = "SaveAuthError";
  }
}

export async function runSaveAuth(
  opts: SaveAuthOptions,
): Promise<SaveAuthResult> {
  const urlCheck = validateUrl(opts.url);
  if (!urlCheck.valid) {
    throw new SaveAuthError("invalid-url", `Invalid URL: ${urlCheck.error}`);
  }

  const outputPath = opts.outputPath ?? "tactual-auth.json";
  const resolved = resolvePath(outputPath);
  if (opts.restrictOutputToCwd) {
    const rel = relativePath(process.cwd(), resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new SaveAuthError(
        "invalid-output-path",
        `Invalid outputPath: must be within the current working directory (${process.cwd()}). Resolved: ${resolved}`,
      );
    }
  }

  const timeout = opts.timeout ?? 30000;
  const steps = parseAuthSteps(opts.steps);
  const fs = await import("fs/promises");

  const { browser, owned } = await acquireBrowser(
    {},
    { useSharedPool: opts.useSharedBrowserPool === true },
  );
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(urlCheck.url!, { waitUntil: "domcontentloaded", timeout });
    await page.waitForTimeout(2000);

    for (const step of steps) {
      if ("click" in step) {
        const target = step.click;
        const byRole = page
          .getByRole("button", { name: target })
          .or(page.getByRole("link", { name: target }))
          .or(page.getByText(target, { exact: false }));
        const exists = (await byRole.count()) > 0;
        if (exists) {
          await byRole.first().click({ timeout });
        } else {
          await page.click(target, { timeout });
        }
      } else if ("fill" in step) {
        await page.fill(step.fill[0], step.fill[1]);
      } else if ("wait" in step) {
        await page.waitForTimeout(Math.min(step.wait, 60000));
      } else if ("waitForUrl" in step) {
        await page.waitForURL(`**${step.waitForUrl}**`, { timeout });
      }
    }

    await page.waitForTimeout(2000);

    const state = await context.storageState();
    await fs.writeFile(resolved, JSON.stringify(state, null, 2), {
      mode: opts.fileMode ?? 0o600,
    });

    const cookieCount = state.cookies?.length ?? 0;
    const originCount = state.origins?.length ?? 0;
    return {
      saved: outputPath,
      cookies: cookieCount,
      origins: originCount,
      currentUrl: page.url(),
      message: `Auth state saved. Pass storageState="${outputPath}" to analyze-url/analyze_url.`,
    };
  } finally {
    await context?.close().catch(() => {});
    if (owned) await closeBrowser(browser);
  }
}

async function closeBrowser(b: Browser): Promise<void> {
  await b.close().catch(() => {});
}

function parseAuthSteps(steps: AuthStep[] | Record<string, unknown>[]): AuthStep[] {
  const parsed = AuthStepsSchema.safeParse(steps);
  if (parsed.success) return parsed.data;

  const firstIssue = parsed.error.issues[0];
  const path = firstIssue.path.length > 0 ? ` at steps.${firstIssue.path.join(".")}` : "";
  throw new SaveAuthError(
    "invalid-step",
    `${firstIssue.message}${path}. Valid step types: click, fill, wait, waitForUrl.`,
  );
}

/**
 * Build a step array from CLI-style flags. Order: fills, then click,
 * then waitForUrl. The scalar flags support one click and one URL wait.
 */
export function stepsFromCliFlags(opts: {
  fill?: string[];
  click?: string;
  waitForUrl?: string;
}): AuthStep[] {
  const steps: AuthStep[] = [];
  if (opts.fill) {
    for (const pair of opts.fill) {
      const [selector, value] = pair.split("=", 2);
      if (selector && value !== undefined) {
        steps.push({ fill: [selector, value] });
      }
    }
  }
  if (opts.click) steps.push({ click: opts.click });
  if (opts.waitForUrl) steps.push({ waitForUrl: opts.waitForUrl });
  return steps;
}
