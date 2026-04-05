import type { Target, PageState } from "../core/types.js";
import type { NavigationGraph } from "../core/graph.js";

/**
 * A rule evaluates a target within its graph context and returns
 * penalties and suggested fixes.
 */
export interface Rule {
  id: string;
  name: string;
  description: string;
  evaluate(ctx: RuleContext): RuleResult;
}

export interface RuleContext {
  target: Target;
  state: PageState;
  graph: NavigationGraph;
  profile: string;
}

export interface RuleResult {
  penalties: string[];
  suggestedFixes: string[];
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

export const noHeadingAnchorRule: Rule = {
  id: "no-heading-anchor",
  name: "No Heading Anchor",
  description: "Target is not preceded by or contained within a heading structure",
  evaluate(ctx) {
    const penalties: string[] = [];
    const suggestedFixes: string[] = [];

    // Check if any heading target exists in the same state
    const headings = ctx.state.targets.filter((t) => t.kind === "heading");
    if (headings.length === 0) {
      penalties.push("Page has no heading structure for screen-reader navigation");
      suggestedFixes.push("Add heading hierarchy to organize page content");
    }

    return { penalties, suggestedFixes };
  },
};

export const hiddenBranchRule: Rule = {
  id: "hidden-branch",
  name: "Hidden Branch Required",
  description: "Target only becomes reachable after opening a hidden UI branch",
  evaluate(ctx) {
    const penalties: string[] = [];
    const suggestedFixes: string[] = [];

    if (ctx.target.requiresBranchOpen) {
      penalties.push(
        `Target "${ctx.target.name}" requires opening a hidden branch before it becomes reachable`,
      );
      suggestedFixes.push(
        "Consider making this target discoverable without requiring a branch open, " +
          "or ensure the branch trigger is clearly labeled and easy to find",
      );
    }

    return { penalties, suggestedFixes };
  },
};

export const missingAccessibleNameRule: Rule = {
  id: "missing-accessible-name",
  name: "Missing Accessible Name",
  description: "Interactive target lacks a clear accessible name",
  evaluate(ctx) {
    const penalties: string[] = [];
    const suggestedFixes: string[] = [];

    if (!ctx.target.name || ctx.target.name.trim() === "") {
      penalties.push(`Target has no accessible name — screen-reader users cannot identify it`);
      suggestedFixes.push("Add an aria-label, aria-labelledby, or visible text label");
    }

    return { penalties, suggestedFixes };
  },
};

export const excessiveControlSequenceRule: Rule = {
  id: "excessive-control-sequence",
  name: "Excessive Control Sequence",
  description: "Too many controls must be traversed to reach the target via control navigation",
  evaluate(ctx) {
    const penalties: string[] = [];
    const suggestedFixes: string[] = [];

    // Count controls that appear before this target in the state
    const controls = ctx.state.targets.filter(
      (t) =>
        t.kind === "button" ||
        t.kind === "link" ||
        t.kind === "formField" ||
        t.kind === "menuTrigger",
    );
    const targetIndex = controls.findIndex((t) => t.id === ctx.target.id);

    if (targetIndex > 8) {
      penalties.push(
        `${targetIndex} controls precede this target in control navigation order`,
      );
      suggestedFixes.push(
        "Move the primary action earlier in the control sequence or add a skip link",
      );
    }

    return { penalties, suggestedFixes };
  },
};

/**
 * All built-in rules.
 *
 * Rules that overlap with graph-derived penalties in finding-builder.ts
 * have been removed to prevent duplicate output:
 * - hiddenBranchRule: finding-builder checks target.requiresBranchOpen directly
 * - missingAccessibleNameRule: finding-builder checks target.name directly
 * - excessiveControlSequenceRule: finding-builder uses graph-derived control index
 */
export const builtinRules: Rule[] = [
  noHeadingAnchorRule,
];
