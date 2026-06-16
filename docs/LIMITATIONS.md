# Limitations

Tactual is a screen-reader navigation-cost analyzer. It captures browser
accessibility trees, runtime evidence, and modeled AT navigation paths. It is
not a replacement for manual testing of critical flows with real assistive
technology.

## Accessibility Tree Capture

- Chromium can recover many cross-origin OOPIF accessibility trees through CDP
  when Playwright's frame-scoped `ariaSnapshot()` path is inaccessible.
- Firefox and WebKit do not expose the same CDP frame-target fallback, so
  inaccessible cross-origin frames keep the existing skip behavior.
- CDP AX trees are browser accessibility trees, not screen-reader speech. Tactual
  serializes them into the same parser path as Playwright snapshots, but speech
  output still depends on AT, browser, verbosity settings, focus mode, and page
  state.
- Frame DOM enrichment is best effort. Rects, hrefs, native-control metadata,
  descriptions, and ARIA relationships can be recovered for many Chromium frame
  targets, but not all browser/target combinations expose equivalent backend
  node information.

## SPA and Runtime State

- `--wait-for-selector`, convergence polling, framework settling, route tracking,
  auto-scroll, banner dismissal, hover probing, tab walking, and exploration
  improve SPA coverage, but they do not prove every user journey was exercised.
- Virtualized lists, infinite feeds, account-specific feature flags, bot
  challenges, payments, destructive admin actions, and deeply stateful workflows
  still need scenario-specific setup and safety constraints.
- `--auto-scroll`, `--dismiss-banners`, `--probe`, `--probe-hover`,
  `--walk-tab-order`, and `--explore` can change page state. Use them on safe
  previews, fixtures, or known non-destructive flows.

## Announcement Modeling

- Tactual's announcement simulator is a model. It uses captured role/name/state
  data plus calibrated token expectations for covered ARIA-AT patterns.
- `npm run calibrate` verifies that the simulator conveys expected
  role/name/state tokens for the curated ARIA-AT subset. It is not a claim that
  Tactual exactly reproduces all NVDA, JAWS, or VoiceOver speech.
- Observed announcement data should be recorded as `observedAnnouncement` or
  `observedAnnouncementTokens`, with `announcementSource` such as `manual-sr`,
  `nvda-vm`, `virtual-sr`, `fixture`, or `aria-at`. Avoid using observed data as
  a universal truth unless AT version, browser, mode, verbosity, page state, and
  target are all controlled.
- The compatibility field `actualAnnouncement` exists for pre-release data, but
  public docs and new datasets should prefer `observedAnnouncement` because
  "actual" can imply certainty that Tactual cannot guarantee.

## NVDA Source Boundary

NVDA is open source and useful to study, but its public repository describes the
project as licensed under a modified GPL-2-or-later license. Tactual is
Apache-2.0. Do not copy NVDA implementation code into Tactual unless the project
intentionally changes its license strategy after legal review.

Acceptable approaches for Tactual:

- cite NVDA, browser, ARIA, HTML-AAM, and ARIA-AT behavior as external evidence;
- black-box test real NVDA output and store it as observed calibration data;
- use virtual screen-reader tooling for deterministic CI checks where it fits;
- model stable role/name/state tokens instead of trying to clone an AT speech
  engine.

## Real Screen-Reader Testing

Manual SR testing remains the final validation path for critical user journeys.
The `observe-announcement` CLI command is designed to reduce the bookkeeping
burden: run or load an analysis, select a target, paste or file the announcement
you observed, and append an announcement-only calibration entry. That gives
Tactual deterministic feedback without requiring NVDA, JAWS, or VoiceOver to run
inside CI. For controlled Windows VM runs with NVDA, see
`docs/NVDA_VM_OBSERVER.md`.
