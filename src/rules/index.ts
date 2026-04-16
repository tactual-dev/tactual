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
