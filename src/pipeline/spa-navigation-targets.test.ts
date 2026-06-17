import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { runAnalyzeUrl } from "./analyze-url.js";

const DISTRACTOR_LINKS = Array.from(
  { length: 18 },
  (_, i) => `<a href="#nav-${i}">Workspace nav ${i + 1}</a>`,
).join("\n");

function difficultSpaHtml(frameUrl: string): string {
  return `<!DOCTYPE html>
<html><body>
<main>
  <h1>Admin shell</h1>
  <nav aria-label="Workspace navigation">
    ${DISTRACTOR_LINKS}
  </nav>

  <button
    id="billing-trigger"
    aria-controls="billing-panel"
    aria-expanded="true"
    aria-haspopup="dialog"
  >Open billing tools</button>
  <section id="billing-panel" role="region" aria-label="Billing tools">
    <h2>Billing tools</h2>
    <button>Rotate invoice token</button>
  </section>

  <div role="tablist" aria-label="Account sections">
    <button role="tab" aria-selected="true">Overview</button>
    <button role="tab" aria-selected="false">Usage</button>
    <button role="tab" aria-selected="false">Invoices</button>
  </div>

  <label id="assignee-label">Assignee</label>
  <div
    role="combobox"
    aria-labelledby="assignee-label"
    aria-expanded="true"
    aria-activedescendant="active-assignee"
    tabindex="0"
  >
    <div id="active-assignee" role="button">Assign to Ada</div>
  </div>

  <iframe src="${frameUrl}" title="Embedded checkout"></iframe>
</main>
<script>
  setTimeout(() => history.replaceState({}, "", "/ready"), 50);
</script>
</body></html>`;
}

const LAZY_FRAME_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h2>Embedded checkout</h2>
  <div style="height: 850px;">Frame prelude</div>
  <div id="frame-lazy-zone" style="height: 40px;"></div>
</main>
<script>
  let added = 0;
  const zone = document.getElementById("frame-lazy-zone");
  new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || added >= 1) return;
    added++;
    const button = document.createElement("button");
    button.textContent = "Authorize embedded payment";
    document.querySelector("main").appendChild(button);
  }).observe(zone);
</script>
</body></html>`;

async function withFixtureServer<T>(
  fn: (urls: { frameUrl: string; mainUrl: string }) => Promise<T>,
): Promise<T> {
  const frameServer = createServer((req, res) => {
    if (req.url === "/frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(LAZY_FRAME_HTML);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  let frameListening = false;
  let mainServer: Server | undefined;
  let mainListening = false;

  try {
    const frameOrigin = await listenServer(frameServer);
    frameListening = true;
    const frameUrl = `${frameOrigin}/frame`;
    mainServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(difficultSpaHtml(frameUrl));
    });
    const mainOrigin = await listenServer(mainServer);
    mainListening = true;

    return await fn({ frameUrl, mainUrl: `${mainOrigin}/` });
  } finally {
    await Promise.all([
      mainListening && mainServer ? closeServer(mainServer) : Promise.resolve(),
      frameListening ? closeServer(frameServer) : Promise.resolve(),
    ]);
  }
}

function listenServer(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("difficult SPA navigation targets", () => {
  it("recovers and models paths through relationship, active-descendant, composite, and lazy-frame targets", async () => {
    await withFixtureServer(async ({ frameUrl, mainUrl }) => {
      const pipelineResult = await runAnalyzeUrl({
        url: mainUrl,
        profileId: "generic-mobile-web-sr-v0",
        waitForSelector: "main",
        detectRoutes: true,
        descendFrames: true,
        autoScroll: true,
        checkVisibility: false,
        timeout: 10000,
      });

      const state = pipelineResult.result.states[0];
      const byName = new Map(state.targets.map((target) => [target.name, target]));
      expect(byName.has("Rotate invoice token")).toBe(true);
      expect(byName.has("Invoices")).toBe(true);
      expect(byName.has("Assign to Ada")).toBe(true);
      expect(byName.has("Authorize embedded payment")).toBe(true);

      const billingTrigger = byName.get("Open billing tools") as
        | (typeof state.targets)[number]
        | undefined;
      const billingRelationships = (billingTrigger as Record<string, unknown> | undefined)
        ?._ariaRelationships as
        | { controls?: Array<{ name?: string; role?: string }> }
        | undefined;
      expect(billingRelationships?.controls?.[0]).toMatchObject({
        name: "Billing tools",
        role: "region",
      });

      const assigneeCombobox = byName.get("Assignee") as
        | (typeof state.targets)[number]
        | undefined;
      const assigneeRelationships = (assigneeCombobox as Record<string, unknown> | undefined)
        ?._ariaRelationships as
        | { activeDescendant?: { name?: string; role?: string } }
        | undefined;
      expect(assigneeRelationships?.activeDescendant).toMatchObject({
        name: "Assign to Ada",
        role: "button",
      });

      const frameTarget = byName.get("Authorize embedded payment") as
        | (typeof state.targets)[number]
        | undefined;
      expect((frameTarget as Record<string, unknown> | undefined)?._frame).toMatchObject({
        name: expect.any(String),
        url: frameUrl,
      });
      expect(new URL(frameUrl).origin).not.toBe(new URL(mainUrl).origin);

      const findingByTargetId = new Map(
        pipelineResult.result.findings.map((finding) => [finding.targetId, finding]),
      );
      const activeFinding = findingByTargetId.get(byName.get("Assign to Ada")!.id);
      const tabFinding = findingByTargetId.get(byName.get("Invoices")!.id);
      const billingFinding = findingByTargetId.get(byName.get("Rotate invoice token")!.id);
      const frameFinding = findingByTargetId.get(frameTarget!.id);

      for (const finding of [activeFinding, tabFinding, billingFinding, frameFinding]) {
        expect(finding).toBeDefined();
        expect(finding!.bestPath.length).toBeGreaterThan(0);
        expect(finding!.scores.reachability).toBeGreaterThan(0);
        expect(finding!.severity).not.toBe("severe");
      }
      expect(tabFinding?.bestPath.some((step) => step.startsWith("touchExplore:"))).toBe(true);

      expect(pipelineResult.routeChanges?.some((event) => event.kind === "replaceState")).toBe(true);
      expect(pipelineResult.result.diagnostics.some((d) => d.code === "auto-scrolled")).toBe(true);
      expect(pipelineResult.result.diagnostics.some((d) => d.code === "frames-descended")).toBe(true);
    });
  }, 30000);
});
