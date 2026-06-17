/**
 * Playwright integration for Tactual.
 *
 * This module provides state capture, target extraction, and bounded
 * exploration using Playwright's accessibility snapshots and page automation.
 *
 * Uses the Playwright runtime dependency bundled with Tactual.
 */

export { captureState, parseAriaSnapshot, type CaptureOptions } from "./capture.js";
export { attachToFlow, type AttachOptions, type FlowRecorder } from "./attach.js";
export { explore, type ExploreOptions, type ExploreResult, type ExplorationStep } from "./explorer.js";
export { checkActionSafety, type ElementInfo, type SafetyCheck, type ActionSafety } from "./safety.js";
export { probeTargets, type ProbeResults } from "./probes.js";
export { probeMenuPatterns, type MenuProbeResults } from "./menu-probe.js";
export { probeModalDialogs, type ModalProbeResults } from "./modal-probe.js";
export {
  probeTabAndDisclosurePatterns,
  type TabProbeResults,
  type DisclosureProbeResults,
} from "./widget-probe.js";
export {
  probeComboListboxContracts,
  type ComboboxProbeResults,
  type ListboxProbeResults,
} from "./composite-widget-probe.js";
export { probeFormErrorFlows, type FormErrorProbeResults } from "./form-error-probe.js";
export {
  waitForFrameworkSettled,
  type SettleStrategy,
  type SettleOptions,
  type SettleResult,
} from "./framework-settle.js";
export {
  detectFrameworks,
  type FrameworkSignal,
} from "./framework-detect.js";
export {
  simulateCvd,
  contrastWithCvd,
  contrastRatio,
  detectCvdContrastIssues,
  type CvdType,
  type CvdContrastSummary,
  type CvdContrastSample,
  type CvdTypeResult,
} from "./cvd-simulation.js";
export {
  diffViewports,
  type ViewportDiffOptions,
  type ViewportDiffResult,
  type ViewportDivergences,
  type ViewportSnapshot,
  type ViewportSize,
} from "./viewport-diff.js";
export {
  probeFormEnablement,
  type FormEnablement,
  type FormFillOptions,
  type FormFillResult,
} from "./form-fill-probe.js";
export {
  simulateScreenReader,
  buildAnnouncement,
  buildMultiATAnnouncement,
  buildProfileNavigationTranscript,
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
// so existing `tactual/playwright` imports keep working.
export {
  simulateAction,
  simulateSequence,
  type Key,
  type ActionResult,
  type AttributeChange,
} from "../core/state-machine.js";
