export type {
  GroundTruthObservation,
  CalibrationDataset,
  CalibrationResult,
  CalibrationReport,
} from "./types.js";

export { runCalibration, formatCalibrationReport } from "./runner.js";

// ARIA-AT calibration — compare simulator predictions to ground-truth
// AT recordings from https://aria-at.w3.org
export {
  compareSimulatorToAriaAt,
  formatCalibrationReport as formatAriaAtReport,
  type AriaAtCase,
  type CalibrationMismatch,
  type CalibrationSummary,
} from "./aria-at.js";
