/**
 * Playwright integration for Tactual.
 *
 * This module provides state capture, target extraction, and bounded
 * exploration using Playwright's accessibility snapshots and page automation.
 *
 * Requires `playwright` as a peer dependency.
 */

export { captureState, parseAriaSnapshot, type CaptureOptions } from "./capture.js";
export { attachToFlow, type AttachOptions, type FlowRecorder } from "./attach.js";
export { explore, type ExploreOptions, type ExploreResult, type ExplorationStep } from "./explorer.js";
export { checkActionSafety, type ElementInfo, type SafetyCheck, type ActionSafety } from "./safety.js";
