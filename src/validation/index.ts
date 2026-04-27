/**
 * Screen reader validation using @guidepup/virtual-screen-reader.
 *
 * Provides virtual screen-reader validation by simulating navigation
 * and comparing observed announcements against Tactual's predictions.
 *
 * The virtual screen reader runs in a DOM environment without requiring
 * real AT software, making it suitable for CI and cross-platform testing.
 */

export {
  validateFindings,
  validateFindingsInJsdom,
  withValidationLock,
  isValidatable,
  announcementMatches,
  type ValidationResult,
  type ValidationOptions,
} from "./validator.js";
