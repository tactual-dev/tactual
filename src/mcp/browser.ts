/**
 * Compat re-export. The browser pool lives in `src/core/browser.ts` now
 * so CLI can use it too. Kept here so existing `src/mcp/*` imports keep
 * resolving; prefer the core import for new code.
 */
export { getSharedBrowser, closeSharedBrowser } from "../core/browser.js";
