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

export interface ValidationResult {
  valid: boolean;
  url?: string;
  error?: string;
}

/**
 * Validate and sanitize a URL for use with Playwright navigation.
 */
export function validateUrl(input: string): ValidationResult {
  const trimmed = input.trim();

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

/**
 * Validate an output file path for safety.
 * Blocks path traversal and writing to system directories.
 */
export function validateOutputPath(path: string): ValidationResult {
  const trimmed = path.trim();
  if (!trimmed) return { valid: false, error: "Output path is empty" };

  // Block null bytes (path traversal primitive)
  if (trimmed.includes("\0")) {
    return { valid: false, error: "Output path contains null bytes" };
  }

  return { valid: true, url: trimmed };
}
