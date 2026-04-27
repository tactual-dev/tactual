/**
 * Pipeline: diff two Tactual analysis results.
 *
 * Accepts either parsed objects (MCP passes a string it's parsed, CLI
 * reads a file) so the surface stays simple on both sides. Returns a
 * structured summary; surfaces format it.
 */

import { extractFindings } from "../core/result-extraction.js";

export interface DiffChange {
  targetId: string;
  baselineScore: number | null;
  candidateScore: number | null;
  delta: number;
  baselineSeverity: string | null;
  candidateSeverity: string | null;
  severityChanged: boolean;
  penaltiesResolved: string[];
  penaltiesAdded: string[];
  status: "improved" | "regressed" | "new" | "removed" | "unchanged";
}

export interface DiffResult {
  summary: {
    improved: number;
    regressed: number;
    added: number;
    removed: number;
  };
  penaltiesResolved: string[];
  penaltiesAdded: string[];
  changes: DiffChange[];
}

export class DiffResultsError extends Error {
  constructor(
    public readonly code: "bad-input" | "runtime",
    message: string,
  ) {
    super(message);
    this.name = "DiffResultsError";
  }
}

export function runDiffResults(baseline: unknown, candidate: unknown): DiffResult {
  let baseFindings;
  let candFindings;
  try {
    baseFindings = extractFindings(baseline);
    candFindings = extractFindings(candidate);
  } catch (err) {
    throw new DiffResultsError(
      "bad-input",
      `Error parsing results: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const baseMap = new Map(baseFindings.map((f) => [f.targetId, f]));
  const candMap = new Map(candFindings.map((f) => [f.targetId, f]));
  const allIds = new Set([...baseMap.keys(), ...candMap.keys()]);

  const changes: DiffChange[] = [];
  let improved = 0;
  let regressed = 0;
  let added = 0;
  let removed = 0;

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = candMap.get(id);
    const bScore = b?.overall ?? null;
    const cScore = c?.overall ?? null;
    const delta = (cScore ?? 0) - (bScore ?? 0);

    const bPenalties = new Set(b?.penalties ?? []);
    const cPenalties = new Set(c?.penalties ?? []);
    const penaltiesResolved = [...bPenalties].filter((p) => !cPenalties.has(p));
    const penaltiesAdded = [...cPenalties].filter((p) => !bPenalties.has(p));

    let status: DiffChange["status"];
    if (!b) {
      status = "new";
      added++;
    } else if (!c) {
      status = "removed";
      removed++;
    } else if (delta > 0) {
      status = "improved";
      improved++;
    } else if (delta < 0) {
      status = "regressed";
      regressed++;
    } else {
      continue;
    }

    changes.push({
      targetId: id,
      baselineScore: bScore,
      candidateScore: cScore,
      delta,
      baselineSeverity: b?.severity ?? null,
      candidateSeverity: c?.severity ?? null,
      severityChanged: (b?.severity ?? null) !== (c?.severity ?? null),
      penaltiesResolved,
      penaltiesAdded,
      status,
    });
  }

  const statusOrder = { regressed: 0, new: 1, removed: 2, improved: 3, unchanged: 4 };
  changes.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.delta - b.delta);

  const allResolved = changes.flatMap((c) => c.penaltiesResolved);
  const allAdded = changes.flatMap((c) => c.penaltiesAdded);

  return {
    summary: { improved, regressed, added, removed },
    penaltiesResolved: [...new Set(allResolved)].slice(0, 5),
    penaltiesAdded: [...new Set(allAdded)].slice(0, 5),
    changes: changes.slice(0, 20),
  };
}
