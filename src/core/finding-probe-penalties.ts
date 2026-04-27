import type { Target } from "./types.js";
import { addGenericProbePenalties } from "./finding-generic-probe-penalties.js";
import {
  addModalProbePenalties,
  addModalTriggerProbePenalties,
} from "./finding-dialog-probe-penalties.js";
import { addMenuProbePenalties } from "./finding-menu-probe-penalties.js";
import { addCompositeWidgetProbePenalties } from "./finding-widget-probe-penalties.js";
import { addFormErrorProbePenalties } from "./finding-form-probe-penalties.js";

interface PenaltyResult {
  penalties: string[];
  suggestedFixes: string[];
}

export function detectProbePenalties(target: Target): PenaltyResult {
  const penalties: string[] = [];
  const suggestedFixes: string[] = [];

  addGenericProbePenalties(target, penalties, suggestedFixes);
  addModalProbePenalties(target, penalties, suggestedFixes);
  addModalTriggerProbePenalties(target, penalties, suggestedFixes);
  addMenuProbePenalties(target, penalties, suggestedFixes);
  addCompositeWidgetProbePenalties(target, penalties, suggestedFixes);
  addFormErrorProbePenalties(target, penalties, suggestedFixes);

  return { penalties, suggestedFixes };
}
