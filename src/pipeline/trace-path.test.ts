import { describe, expect, it } from "vitest";
import type { PageState } from "../core/types.js";
import { runTracePath, TracePathError } from "./trace-path.js";

function makeState(): PageState {
  return {
    id: "s1",
    url: "https://example.test",
    route: "/",
    snapshotHash: "snapshot",
    interactiveHash: "interactive",
    openOverlays: [],
    timestamp: 1,
    provenance: "scripted",
    targets: [
      {
        id: "heading:checkout",
        kind: "heading",
        role: "heading",
        name: "Checkout",
        headingLevel: 1,
        requiresBranchOpen: false,
      },
      {
        id: "button:submit",
        kind: "button",
        role: "button",
        name: "Submit order",
        requiresBranchOpen: false,
      },
    ],
  };
}

describe("runTracePath", () => {
  it("rejects unknown profiles before launching a browser", async () => {
    await expect(
      runTracePath({
        url: "https://example.test",
        targetPattern: "*submit*",
        profileId: "unknown-profile",
      }),
    ).rejects.toMatchObject({
      code: "unknown-profile",
      name: "TracePathError",
    } satisfies Partial<TracePathError>);
  });

  it("reports available targets when pre-captured states have no match", async () => {
    await expect(
      runTracePath({
        url: "https://example.test",
        targetPattern: "*missing*",
        states: [makeState()],
      }),
    ).rejects.toMatchObject({
      code: "no-matches",
      availableTargets: ["button:submit (button: Submit order)"],
    } satisfies Partial<TracePathError>);
  });
});
