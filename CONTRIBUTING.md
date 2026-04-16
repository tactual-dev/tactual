# Contributing to Tactual

## Adding an AT Profile

1. Create `src/profiles/your-profile.ts` implementing the `ATProfile` interface (see `src/profiles/types.ts` for the full type definition and `src/profiles/generic-mobile.ts` for a complete example):

```typescript
import type { ATProfile } from "./types.js";

export const yourProfileV0: ATProfile = {
  id: "your-profile-v0",
  name: "Your Profile (v0)",
  description: "...",
  platform: "desktop", // or "mobile"
  actionCosts: {
    nextItem: 1.0,
    previousItem: 1.0,
    nextHeading: 1.0,
    nextLink: 1.0,
    nextControl: 1.0,
    activate: 1.0,
    dismiss: 1.0,
    back: 1.5,
    find: 2.5,
    groupEntry: 1.0,
    groupExit: 1.0,
  },
  weights: {
    discoverability: 0.30,
    reachability: 0.40,
    operability: 0.20,
    recovery: 0.10,
  },
  // costSensitivity scales the reachability decay curve.
  // Higher values penalize navigation cost more aggressively (mobile).
  // Lower values are more forgiving (desktop with quick keys).
  costSensitivity: 1.0,
  modifiers: [
    // Add context-dependent cost adjustments
  ],
};
```

2. Register it in `src/profiles/index.ts`:

```typescript
import { yourProfileV0 } from "./your-profile.js";
registerProfile(yourProfileV0);
```

3. Export from `src/index.ts` if needed for the public API.

### Cost calibration

- `1.0` = one atomic action (single keystroke, single swipe)
- Higher values represent actions requiring more cognitive load, multi-key combos, or mode switching
- Test by running `npx tactual analyze-url` with your profile against known-good and known-bad pages

## Adding a Rule

Implement the `Rule` interface in `src/rules/index.ts`:

```typescript
export const yourRule: Rule = {
  id: "your-rule",
  name: "Your Rule",
  description: "What this rule checks",
  evaluate(ctx) {
    const penalties: string[] = [];
    const suggestedFixes: string[] = [];
    // Analyze ctx.target, ctx.state, ctx.graph
    return { penalties, suggestedFixes };
  },
};
```

Add it to `builtinRules`. Note: avoid duplicating penalties that `finding-builder.ts` already generates from graph analysis.

## Adding a Reporter

1. Create `src/reporters/your-format.ts` with a format function
2. Add the format to `ReportFormat` type and `formatReport` switch in `src/reporters/index.ts`

## Testing

```bash
npm run test                   # Fast tests (unit + integration)
npm run test:benchmark         # Benchmark suite (slower, launches browser)
npx vitest run src/path/to/specific.test.ts  # Single test file
```

Integration tests require Playwright with Chromium installed:
```bash
npx playwright install chromium
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module dependency graph, data flow pipeline, and scoring formula.
