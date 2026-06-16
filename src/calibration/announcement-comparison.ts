import type { Target } from "../core/types.js";
import {
  buildAnnouncementModel,
  type ATKind,
} from "../playwright/sr-simulator.js";
import type {
  AnnouncementAssumptionResult,
  AnnouncementObservation,
  AnnouncementSource,
} from "./types.js";

export interface AnnouncementComparison {
  predictedAnnouncement: string;
  modeledAnnouncement: string;
  observedAnnouncement?: string;
  actualAnnouncement?: string;
  announcementSource: AnnouncementSource;
  announcementAccuracy: number;
  announcementMatch: boolean;
  missingAnnouncementTokens: string[];
  unexpectedAnnouncementTokens: string[];
  announcementAssumptions: AnnouncementAssumptionResult[];
}

export function compareAnnouncementObservation(
  observation: AnnouncementObservation,
  target: Target,
): AnnouncementComparison | null {
  const observedAnnouncement =
    observation.observedAnnouncement ?? observation.actualAnnouncement;
  const observedTokens =
    observation.observedAnnouncementTokens ?? observation.actualAnnouncementTokens;
  if (!observedAnnouncement && !observedTokens) return null;

  const at = observation.announcementAt ?? inferATFromProfile(observation.profileId);
  return compareTargetAnnouncement({
    target,
    at,
    observedAnnouncement,
    observedTokens,
    source: observation.announcementSource ?? "manual-sr",
  });
}

export function compareTargetAnnouncement(args: {
  target: Target;
  at: ATKind;
  observedAnnouncement?: string;
  observedTokens?: string[];
  source: AnnouncementSource;
}): AnnouncementComparison {
  const model = buildAnnouncementModel(args.target, args.at);
  const predictedTokens = model.parts
    .map((part) => normalizeAnnouncementToken(part.text))
    .filter(Boolean);
  const actualTokens = args.observedTokens
    ? args.observedTokens.map(normalizeAnnouncementToken).filter(Boolean)
    : announcementTokens(args.observedAnnouncement ?? "");
  const actualText = args.observedAnnouncement
    ? normalizeAnnouncementToken(args.observedAnnouncement)
    : actualTokens.join(" ");

  const partResults: AnnouncementAssumptionResult[] = [];
  for (const part of model.parts) {
    const expected = normalizeAnnouncementToken(part.text);
    if (!expected) continue;
    const confirmed = tokenObserved({
      expected,
      observedAnnouncement: args.observedAnnouncement,
      actualText,
      actualTokens,
    });
    partResults.push({
      id: part.assumptionId,
      kind: part.kind,
      status: confirmed ? "confirmed" : "missing",
      expected,
      expectedText: part.text,
      confidence: part.confidence,
      source: part.source,
    });
  }

  const missingAnnouncementTokens = partResults
    .filter((result) => result.status === "missing")
    .map((result) => result.expected);
  const unexpectedAnnouncementTokens = args.observedTokens
    ? actualTokens.filter((actual) =>
        !predictedTokens.some((predicted) => predicted.includes(actual) || actual.includes(predicted)),
      )
    : [];
  const unexpectedResults: AnnouncementAssumptionResult[] = unexpectedAnnouncementTokens.map((token) => ({
    id: `announcement.${args.at}.observed.unexpected`,
    kind: "unexpected",
    status: "unexpected",
    observed: token,
    expected: "",
    confidence: 0,
    source: "observed-token-not-modeled",
  }));
  const matched = predictedTokens.length - missingAnnouncementTokens.length;
  const announcementAccuracy =
    predictedTokens.length === 0 ? 1 : matched / predictedTokens.length;

  return {
    predictedAnnouncement: model.announcement,
    modeledAnnouncement: model.announcement,
    observedAnnouncement: args.observedAnnouncement,
    actualAnnouncement: args.observedAnnouncement,
    announcementSource: args.source,
    announcementAccuracy,
    // NVDA often prefixes the target with contextual speech: landmarks,
    // frames, group labels, autocomplete hints, or field values. Those tokens
    // are useful evidence, but they are not mapper failures when every modeled
    // name/role/state token was still announced. Keep them in
    // unexpectedAnnouncementTokens for review while letting mapper drift mean
    // "Tactual predicted speech NVDA did not say."
    announcementMatch: missingAnnouncementTokens.length === 0,
    missingAnnouncementTokens,
    unexpectedAnnouncementTokens,
    announcementAssumptions: [...partResults, ...unexpectedResults],
  };
}

export function inferATFromProfile(profileId: string): ATKind {
  if (profileId.includes("jaws")) return "jaws";
  if (profileId.includes("voiceover")) return "voiceover";
  return "nvda";
}

export function announcementTokens(announcement: string): string[] {
  return announcement
    .split(",")
    .map(normalizeAnnouncementToken)
    .filter(Boolean);
}

export function normalizeAnnouncementToken(token: string): string {
  return token
    .toLowerCase()
    // NVDA logs and Speech Viewer often preserve punctuation from the
    // accessible name, e.g. `Search: edit`. For calibration purposes,
    // punctuation is a name separator, not missing speech content.
    .replace(/[:;：；]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim();
}

function tokenObserved(args: {
  expected: string;
  observedAnnouncement?: string;
  actualText: string;
  actualTokens: string[];
}): boolean {
  if (args.observedAnnouncement) return args.actualText.includes(args.expected);
  return args.actualTokens.some((actual) => actual.includes(args.expected) || args.expected.includes(actual));
}
