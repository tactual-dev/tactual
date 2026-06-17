import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { cdpAxTreeToAriaYaml, type CDPAXNode } from "./cdp-ax-serializer.js";

const CALIBRATION_FRAME_HTML = `<!DOCTYPE html>
<html><body>
<main>
  <h1>Main title</h1>
  <h2>Section title</h2>
  <h3>Subsection title</h3>
  <button>Primary action</button>
  <a href="#help">Help link</a>
  <label for="name">Full name</label><input id="name" value="Ada Lovelace" />
  <label><input type="checkbox" checked /> Subscribe</label>
  <div role="checkbox" aria-label="Some selected" aria-checked="mixed" tabindex="0"></div>
  <button disabled>Disabled action</button>
  <button aria-expanded="true">Open drawer</button>
  <button aria-expanded="false">Closed drawer</button>
  <div role="tablist">
    <button role="tab" aria-selected="true">Details</button>
    <button role="tab" aria-selected="false">Activity</button>
  </div>
  <button aria-pressed="true">Bold</button>
  <label for="volume">Volume</label><input id="volume" type="range" min="0" max="100" value="75" />
  <label for="qty">Quantity</label><input id="qty" type="number" value="3" />
  <select aria-label="Country">
    <option>Canada</option>
    <option selected>United States</option>
  </select>
  <ul><li>First item</li><li>Second item</li></ul>
</main>
<script>document.querySelector('input[type=checkbox]').indeterminate = true;</script>
</body></html>`;

const CALIBRATION_PARENT_HTML = `<!DOCTYPE html>
<html><body>
  <h1>Parent</h1>
  <iframe src="http://tactual.test/frame" title="Calibration"></iframe>
</body></html>`;

interface CDPAXTreeResponse {
  nodes?: CDPAXNode[];
}

interface CDPFrameTreeResponse {
  frameTree: CDPFrameTreeNode;
}

interface CDPFrameTreeNode {
  frame: {
    id: string;
    url: string;
  };
  childFrames?: CDPFrameTreeNode[];
}

describe("cdpAxTreeToAriaYaml", () => {
  it("matches Playwright ariaSnapshot on a same-origin calibration frame", async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.route("http://tactual.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: CALIBRATION_PARENT_HTML }),
      );
      await context.route("http://tactual.test/frame", (route) =>
        route.fulfill({ contentType: "text/html", body: CALIBRATION_FRAME_HTML }),
      );
      const page = await context.newPage();
      await page.goto("http://tactual.test/", { waitUntil: "load" });

      const frame = page.frames().find((f) => f.url() === "http://tactual.test/frame");
      expect(frame).toBeDefined();
      const expected = await frame!.locator("html").ariaSnapshot({ depth: 20 });

      const session = await page.context().newCDPSession(page);
      try {
        await session.send("Accessibility.enable");
        const frameTree = (await session.send("Page.getFrameTree")) as CDPFrameTreeResponse;
        const frameId = findFrameId(frameTree.frameTree, "http://tactual.test/frame");
        expect(frameId).toBeDefined();
        const { nodes } = (await session.send("Accessibility.getFullAXTree", {
          frameId,
        })) as CDPAXTreeResponse;

        const actual = cdpAxTreeToAriaYaml(nodes ?? [], { depth: 20 });
        expect(normalizeAriaYaml(actual)).toBe(normalizeAriaYaml(expected));
      } finally {
        await session.detach().catch(() => {});
      }

      await context.close();
    } finally {
      await browser.close();
    }
  }, 30000);
});

function findFrameId(node: CDPFrameTreeNode, url: string): string | undefined {
  if (node.frame.url === url) return node.frame.id;
  for (const child of node.childFrames ?? []) {
    const found = findFrameId(child, url);
    if (found) return found;
  }
  return undefined;
}

function normalizeAriaYaml(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n")
    .trim();
}
