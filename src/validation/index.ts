/**
 * Screen reader validation using @guidepup/virtual-screen-reader.
 *
 * Provides ground-truth validation by simulating screen reader navigation
 * and comparing actual announcements against Tactual's predictions.
 *
 * The virtual screen reader runs in a DOM environment without requiring
 * real AT software, making it suitable for CI and cross-platform testing.
 */

export { validateFindings, type ValidationResult, type ValidationOptions } from "./validator.js";
