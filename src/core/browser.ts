/**
 * Browser pool — reuses a single Chromium instance across tool calls.
 * Eliminates ~2s browser launch overhead per call. Each consumer creates
 * an isolated BrowserContext (separate cookies/storage) via newContext().
 *
 * Originally lived under src/mcp/; moved to core so long-lived surfaces can
 * opt into pooling without forcing one-shot CLI commands to keep Node alive.
 */

let _browserPromise: Promise<import("playwright").Browser> | null = null;

export async function getSharedBrowser(): Promise<import("playwright").Browser> {
  if (!_browserPromise) {
    _browserPromise = import("playwright").then((pw) => pw.chromium.launch());
    // If the browser crashes or disconnects, reset so it relaunches next call.
    _browserPromise
      .then((b) => {
        b.on("disconnected", () => {
          _browserPromise = null;
        });
      })
      .catch(() => {
        _browserPromise = null;
      });
  }
  return _browserPromise;
}

/** Close the shared browser pool (for clean HTTP server shutdown). */
export async function closeSharedBrowser(): Promise<void> {
  if (_browserPromise) {
    const p = _browserPromise;
    _browserPromise = null;
    try {
      (await p).close();
    } catch {
      /* already closed */
    }
  }
}
