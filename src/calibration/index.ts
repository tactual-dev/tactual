export type {
  GroundTruthObservation,
  AnnouncementObservation,
  AnnouncementCalibrationResult,
  AnnouncementAssumptionResult,
  AnnouncementAssumptionStatus,
  AnnouncementSource,
  CalibrationScoringDimension,
  CalibrationScoringSignal,
  CalibrationScoringSignalKind,
  CalibrationScoringSignalStatus,
  CalibrationDataset,
  CalibrationResult,
  CalibrationReport,
} from "./types.js";

export { runCalibration, formatCalibrationReport } from "./runner.js";
export {
  announcementTokens,
  compareAnnouncementObservation,
  compareTargetAnnouncement,
  inferATFromProfile,
  normalizeAnnouncementToken,
  type AnnouncementComparison,
} from "./announcement-comparison.js";

// ARIA-AT calibration — compare simulator predictions to ground-truth
// AT recordings from https://aria-at.w3.org
export {
  compareSimulatorToAriaAt,
  formatCalibrationReport as formatAriaAtReport,
  type AriaAtCase,
  type CalibrationMismatch,
  type CalibrationSummary,
} from "./aria-at.js";
