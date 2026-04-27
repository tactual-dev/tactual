# Calibration Guide

Tactual's scoring model uses weights and decay curves that are currently based on informed estimates, not empirical data. The calibration framework lets us systematically improve these weights using ground-truth observations from real screen-reader users.

The built-in `npm run calibrate` gate compares the simulator against curated ARIA-AT role/name/state-token assertions. Passing those assertions is useful regression protection for covered patterns, but it is not a claim of full screen-reader fidelity. It does not cover every browse mode, verbosity setting, timing behavior, user strategy, browser/AT pairing, or valid widget implementation variant.

## Why calibrate?

The scoring model makes predictions like "this button has reachability score 70" — meaning it thinks the button takes moderate effort to reach. But is that prediction accurate? Does a reachability score of 70 actually correspond to moderate difficulty for a real NVDA user?

Calibration answers this by comparing Tactual's predictions against human tester observations, then measuring where the model is systematically too optimistic or pessimistic.

## What we need

**Observations**: a tester using a real screen reader navigates to specific targets on a page and records:
- How many actions it took to reach the target
- How they found it (heading nav, landmark, search, linear)
- How long discovery took
- Whether they could operate and recover from it
- A 1-5 difficulty rating

**Per observation**: ~2-3 minutes. A full page with 10-15 targets takes 20-30 minutes.

**Target**: 50+ observations per profile for statistically meaningful calibration. Even 10-20 per profile is useful for identifying gross biases.

## How to collect data

### 1. Pick pages to test

Good calibration pages have a mix of:
- Well-structured sections (proper headings, landmarks)
- Poorly-structured sections (deep nesting, missing labels)
- Interactive widgets (menus, dialogs, tabs, forms)

The `fixtures/` directory in the [Tactual GitHub repo](https://github.com/tactual-dev/tactual/tree/main/fixtures) has HTML files suitable for local testing (not shipped with the npm package — clone the repo if you want them). Real-world pages (GitHub, Wikipedia, your own app) are even better.

### 2. Run Tactual on each page

```bash
npx tactual analyze-url https://example.com -p nvda-desktop-v0 -f json -o example-nvda.json
```

This gives you Tactual's predictions to compare against.

### 3. Record observations

Create a JSON file following this schema:

```json
{
  "name": "my-calibration-set",
  "collectedAt": "2026-04-03T12:00:00Z",
  "observations": [
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "Search",
      "actualStepsToReach": 3,
      "strategyUsed": "landmark",
      "requiredStrategySwitch": false,
      "knewTargetExisted": true,
      "timeToDiscoverSeconds": 1,
      "discoveryMethod": "landmark-nav",
      "couldOperate": true,
      "couldRecover": true,
      "difficultyRating": 1,
      "testerId": "tester-alice",
      "atVersion": "NVDA 2024.4",
      "browser": "Chrome 131",
      "timestamp": "2026-04-03T12:05:00Z"
    }
  ]
}
```

#### Field reference

| Field | Type | Description |
|---|---|---|
| `url` | string | Page URL (must match the URL you ran Tactual on) |
| `profileId` | string | Tactual profile ID matching the AT used |
| `targetName` | string | Target name or text (matched against Tactual's targets) |
| `targetSelector` | string? | Optional CSS selector for precise matching |
| `actualStepsToReach` | number | Discrete actions from page load to target |
| `strategyUsed` | string | "linear", "heading", "landmark", "search", "mixed" |
| `requiredStrategySwitch` | boolean | Had to change strategy to find it? |
| `knewTargetExisted` | boolean | Did you know it was there before looking? |
| `timeToDiscoverSeconds` | number | Seconds to realize the target exists |
| `discoveryMethod` | string | "heading-nav", "landmark-nav", "linear-scan", "search", "guessed" |
| `couldOperate` | boolean | Could you activate/use the target? |
| `couldRecover` | boolean | Could you get back to a known position? |
| `recoverySteps` | number? | Actions to return to known position |
| `difficultyRating` | 1-5 | 1=trivial, 2=easy, 3=moderate, 4=hard, 5=blocking |
| `testerId` | string | Anonymous identifier |
| `atVersion` | string? | e.g., "NVDA 2024.4", "VoiceOver iOS 18" |
| `browser` | string? | e.g., "Chrome 131", "Safari 18" |
| `timestamp` | string | ISO 8601 timestamp |

### 4. Run calibration

```typescript
import { runCalibration, formatCalibrationReport } from "tactual/calibration";
import { readFileSync } from "fs";

// Load your observations
const dataset = JSON.parse(readFileSync("my-calibration.json", "utf-8"));

// Load the Tactual analysis for each page you tested.
// Keys are URLs, values are the full JSON analysis result.
const analyses = new Map();
for (const url of new Set(dataset.observations.map((o) => o.url))) {
  const slug = new URL(url).hostname.replace(/\./g, "-");
  const result = JSON.parse(readFileSync(`${slug}-nvda.json`, "utf-8"));
  analyses.set(url, result);
}

const report = runCalibration(dataset, analyses);
console.log(formatCalibrationReport(report));
```

A minimal working dataset with 2 observations:

```json
{
  "name": "quick-check",
  "collectedAt": "2026-04-16T12:00:00Z",
  "observations": [
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "More information...",
      "actualStepsToReach": 4,
      "strategyUsed": "heading",
      "requiredStrategySwitch": false,
      "knewTargetExisted": false,
      "timeToDiscoverSeconds": 3,
      "discoveryMethod": "heading-nav",
      "couldOperate": true,
      "couldRecover": true,
      "difficultyRating": 2,
      "testerId": "tester-1",
      "timestamp": "2026-04-16T12:05:00Z"
    },
    {
      "url": "https://example.com",
      "profileId": "nvda-desktop-v0",
      "targetName": "Search",
      "actualStepsToReach": 12,
      "strategyUsed": "linear",
      "requiredStrategySwitch": true,
      "knewTargetExisted": true,
      "timeToDiscoverSeconds": 8,
      "discoveryMethod": "linear-scan",
      "couldOperate": true,
      "couldRecover": false,
      "difficultyRating": 4,
      "testerId": "tester-1",
      "timestamp": "2026-04-16T12:10:00Z"
    }
  ]
}
```

## Reading the report

### Key metrics

| Metric | Good | Concerning | What it means |
|---|---|---|---|
| **Overall Score MAE** | < 10 | > 20 | Average point error in Tactual's predictions |
| **Overall Score Bias** | -5 to +5 | > +10 or < -10 | Positive = too optimistic, negative = too pessimistic |
| **Severity Accuracy** | > 70% | < 50% | How often predicted severity matches human rating |
| **Reachability MAE** | < 3 steps | > 5 steps | Average step-count prediction error |
| **Reachability Correlation** | > 0.7 | < 0.4 | Whether step count trends match (direction, not magnitude) |

### Confusion matrix

The severity confusion matrix shows where the model mis-classifies:

```
              Ground Truth
              severe  high  moderate  acceptable  strong
Predicted
  severe        3      1      0         0          0     ← true positives on diagonal
  high          1      5      2         0          0
  moderate      0      1      8         3          0
  acceptable    0      0      1        12          2
  strong        0      0      0         1         10
```

Off-diagonal entries show misclassifications. If the model puts many "acceptable" observations into "strong" (bottom-right corner), it's too optimistic for easy targets.

### Dimension bias

- **Discoverability bias > 0**: model overestimates how easy targets are to find. Suggests the heading/landmark factors are too generous.
- **Reachability bias > 0**: model underestimates how many steps targets actually need. Suggests the graph is missing navigation paths or the decay curve is too gentle.

## How calibration data improves the model

1. **Severity band thresholds**: if "moderate" targets consistently feel "high" to testers, the 60-74 band should shift.
2. **Discoverability factor weights**: if targets under headings are rated harder than the model predicts, the heading factor (currently ×1.55) should decrease.
3. **Reachability decay coefficient**: if the model consistently underestimates step counts for deep targets, the base coefficient (0.04) should increase.
4. **Profile weights**: if NVDA testers report more operability issues than mobile testers, the NVDA operability weight should increase.
5. **costSensitivity**: if TalkBack testers report proportionally higher difficulty on long paths than the model predicts, TalkBack's costSensitivity (currently 1.3) should increase.

Each adjustment is a single number change in the profile or scoring module, guided by the calibration report's bias metrics rather than guesswork.
