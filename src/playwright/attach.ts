import type { Page } from "playwright";
import type { PageState } from "../core/types.js";
import { captureState, type CaptureOptions } from "./capture.js";

export interface AttachOptions extends CaptureOptions {
  /** Capture state after each navigation event */
  captureOnNavigation?: boolean;
  /** Capture state after the page becomes idle (networkidle) */
  captureOnIdle?: boolean;
}

export interface FlowRecorder {
  /** All states captured so far */
  states: PageState[];
  /** Manually trigger a state capture at the current moment */
  capture(): Promise<PageState>;
  /** Stop recording and return all captured states */
  detach(): PageState[];
}

/**
 * Attach to a Playwright Page to record accessibility states as the flow runs.
 *
 * In "attach" mode, the recorder captures states:
 * - Immediately on attach (initial state)
 * - After each navigation (if captureOnNavigation is true)
 * - On manual capture() calls
 */
export async function attachToFlow(
  page: Page,
  options: AttachOptions = {},
): Promise<FlowRecorder> {
  const states: PageState[] = [];
  const captureOpts: CaptureOptions = {
    device: options.device,
    provenance: options.provenance ?? "scripted",
    snapshotDepth: options.snapshotDepth,
  };

  let detached = false;

  const doCapture = async (): Promise<PageState> => {
    const state = await captureState(page, captureOpts);
    // Deduplicate by snapshot hash
    const isDuplicate = states.some((s) => s.snapshotHash === state.snapshotHash);
    if (!isDuplicate) {
      states.push(state);
    }
    return state;
  };

  // Capture initial state
  await doCapture();

  // Set up automatic capture on navigation
  const onNavigate = async () => {
    if (!detached) {
      try {
        await page.waitForLoadState("domcontentloaded");
        await doCapture();
      } catch {
        // Page may have been closed
      }
    }
  };

  if (options.captureOnNavigation !== false) {
    page.on("framenavigated", onNavigate);
  }

  return {
    states,
    capture: doCapture,
    detach() {
      detached = true;
      page.removeListener("framenavigated", onNavigate);
      return states;
    },
  };
}
