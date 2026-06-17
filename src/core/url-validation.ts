/**
 * URL validation for CLI and MCP inputs.
 *
 * Ensures URLs are safe to pass to Playwright's page.goto().
 * Blocks dangerous protocols and validates structure.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

const BLOCKED_PROTOCOLS = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "blob:",
]);

export interface UrlValidationOptions {
  /**
   * Local CLI workflows use file: URLs for fixtures and offline reports.
   * Remote-control surfaces such as MCP should disable them so an agent cannot
   * turn a browser navigation tool into a local file disclosure primitive.
   */
  allowFileUrls?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  url?: string;
  error?: string;
}

/**
 * Validate and sanitize a URL for use with Playwright navigation.
 */
export function validateUrl(
  input: string,
  options: UrlValidationOptions = {},
): ValidationResult {
  const trimmed = input.trim();
  const allowFileUrls = options.allowFileUrls ?? true;

  if (!trimmed) {
    return { valid: false, error: "URL is empty" };
  }

  // Block obviously dangerous protocols before parsing
  const lower = trimmed.toLowerCase();
  for (const proto of BLOCKED_PROTOCOLS) {
    if (lower.startsWith(proto)) {
      return { valid: false, error: `Blocked protocol: ${proto}` };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `Invalid URL: "${trimmed}"` };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      valid: false,
      error: `Unsupported protocol "${parsed.protocol}" — only http:, https:, and file: are allowed`,
    };
  }

  if (parsed.protocol === "file:" && !allowFileUrls) {
    return { valid: false, error: "file: URLs are not allowed in this surface" };
  }

  // For http/https, require a hostname
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) {
    return { valid: false, error: "URL is missing a hostname" };
  }

  // Block credentials in URLs (potential phishing)
  if (parsed.username || parsed.password) {
    return { valid: false, error: "URLs with embedded credentials are not allowed" };
  }

  return { valid: true, url: parsed.href };
}
