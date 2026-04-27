import type { EvidenceItem, EvidenceSummary } from "./types.js";

const EMPTY_SUMMARY: EvidenceSummary = {
  measured: 0,
  validated: 0,
  modeled: 0,
  heuristic: 0,
};

export function summarizeEvidence(evidence: readonly EvidenceItem[] = []): EvidenceSummary {
  const summary = { ...EMPTY_SUMMARY };
  for (const item of evidence) {
    summary[item.kind] = (summary[item.kind] ?? 0) + 1;
  }
  return summary;
}
