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
export {
  simulateScreenReader,
  buildAnnouncement,
  buildMultiATAnnouncement,
  detectInteropDivergence,
  buildTranscript,
  buildNavigationTranscript,
  isLandmarkDemoted,
  aggregateDemotedLandmarks,
  type ATKind,
  type SimulatorReport,
  type SimulatedAnnouncement,
  type MultiATAnnouncement,
  type TranscriptStep,
  type NavigationMode,
  type NavigationOptions,
  type NestingContext,
} from "./sr-simulator.js";
// State machine lives in core/ (no Playwright deps); re-exported here
// for backward compatibility with the v0.3.0 publish path.
export {
  simulateAction,
  simulateSequence,
  type Key,
  type ActionResult,
  type AttributeChange,
} from "../core/state-machine.js";
