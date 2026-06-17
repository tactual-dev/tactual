import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { runAnalyzeUrl } from "./analyze-url.js";

const PARENT_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Combined SPA</h1>
  <button id="route">push</button>
  <iframe src="http://tactual.test/embed" title="Embedded"></iframe>
  <div id="lazy-zone" style="height: 200px;"></div>
</main>
<div id="spacer" style="height: 1200px;"></div>
<script>
  document.getElementById('route').addEventListener('click', () =>
    history.pushState({}, '', '/dashboard'));
  setTimeout(() => history.replaceState({}, '', '/ready'), 250);
  let added = 0;
  const zone = document.getElementById('lazy-zone');
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || added >= 2) return;
    added++;
    const h = document.createElement('h2');
    h.textContent = 'Lazy h ' + added;
    document.body.appendChild(h);
    const spacer = document.createElement('div');
    spacer.style.height = '600px';
    document.body.appendChild(spacer);
    document.body.appendChild(zone);
  }, { threshold: 0 }).observe(zone);
</script>
</body></html>`;

const EMBED_HTML = `<!DOCTYPE html>
<html><body>
<h2>Embed heading</h2>
<button>Embed button</button>
</body></html>`;

async function withFixtureServer<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((req, res) => {
    if (req.url === "/embed") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(EMBED_HTML);
      return;
    }

    const body = PARENT_HTML.replace("http://tactual.test/embed", "/embed");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("SPA crawl integration: routes + frames + auto-scroll", () => {
  it("exercises runAnalyzeUrl end-to-end for route, iframe, and lazy-content capture", async () => {
    await withFixtureServer(async (url) => {
      const pipelineResult = await runAnalyzeUrl({
        url,
        profileId: "generic-mobile-web-sr-v0",
        waitForSelector: "main",
        detectRoutes: true,
        descendFrames: true,
        autoScroll: true,
        timeout: 10000,
      });

      const state = pipelineResult.result.states[0];
      expect(state.targets.some((t) => t.kind === "heading" && t.name?.startsWith("Lazy h"))).toBe(true);

      const embedTargets = state.targets.filter((t) => {
        const f = (t as Record<string, unknown>)._frame as { url?: string } | undefined;
        return f?.url?.endsWith("/embed");
      });
      expect(embedTargets.some((t) => t.kind === "heading" && t.name === "Embed heading")).toBe(true);
      expect(embedTargets.some((t) => t.kind === "button" && t.name === "Embed button")).toBe(true);

      expect(pipelineResult.routeChanges?.some((e) => e.kind === "replaceState")).toBe(true);
      expect(pipelineResult.result.diagnostics.some((d) => d.code === "spa-route-changes")).toBe(true);
      expect(pipelineResult.result.diagnostics.some((d) => d.code === "frames-descended")).toBe(true);
      expect(pipelineResult.result.diagnostics.some((d) => d.code === "auto-scrolled")).toBe(true);
    });
  }, 30000);

  it("runAnalyzeUrl options object accepts all three flags without type error", () => {
    // Compile-time check via Parameters<>; if this file typechecks, the
    // surfaces compose at the option-object level. The runAnalyzeUrl call
    // is gated behind a never-true condition so we don't actually launch a
    // browser here.
    const opts: Parameters<typeof runAnalyzeUrl>[0] = {
      url: "http://tactual.test/",
      detectRoutes: true,
      descendFrames: true,
      autoScroll: true,
    };
    expect(opts.url).toBe("http://tactual.test/");
  });
});
