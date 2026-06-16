/**
 * EvoCrawl-style genetic explorer (v1).
 *
 * Standalone utility — NOT wired into the default capture pipeline
 * because cost is high (each evaluated sequence requires re-navigating
 * the URL and stepping through interactions). Programmatic users can
 * invoke `evoExplore(page, initialState, options)` for SPAs where the
 * greedy `--explore` strategy plateaus.
 *
 * Algorithm:
 *   1. Build a candidate-target pool from initialState.targets,
 *      filtered to safe-activatable interactive kinds.
 *   2. Generate `populationSize` random sequences of length
 *      `sequenceLength`, each sequence = list of (targetId, action).
 *   3. For each generation:
 *      a. Evaluate each sequence: re-navigate, execute steps,
 *         capture states, fitness = unique snapshotHashes reached.
 *      b. Select top half by fitness (truncation selection).
 *      c. Generate next generation: crossover the survivors
 *         pairwise (single-point), mutate (swap, replace, insert)
 *         with low probability.
 *   4. Return the best sequence found.
 *
 * Reset between sequences: re-navigate to initialState.url and wait
 * for it to render. Each sequence runs in a clean page context so
 * one sequence's side effects don't pollute another.
 *
 * Limitations (v1):
 *   - Action vocabulary is just "activate" — clicks/keyboard activate
 *     via the existing safety-checked path. No form-fill, no scroll.
 *   - Fitness ignores depth — a sequence reaching 3 unique states is
 *     scored the same regardless of how it got there.
 *   - No memoization — repeating sequences re-runs everything.
 *   - Single-point crossover only.
 */

import type { Page } from "playwright";
import type { PageState, Target } from "../core/types.js";
import { captureState } from "./capture.js";

const SAFE_INTERACTIVE_KINDS = new Set(["button", "menuTrigger", "tab", "menuItem", "disclosure"]);

export interface InteractionStep {
  targetId: string;
  /** Stable name for matching the target across re-navigations (target.id
   *  changes across captures because of slug counters). */
  targetName: string;
  targetRole: string;
  action: "activate";
}

export interface EvoExploreOptions {
  populationSize?: number;
  generations?: number;
  sequenceLength?: number;
  /** Seed for reproducibility — defaults to Date.now() when omitted. */
  randomSeed?: number;
  /** Called after each generation with (gen, bestFitnessSoFar). */
  onGeneration?: (generation: number, bestFitness: number) => void;
}

export interface EvoExploreResult {
  bestSequence: InteractionStep[];
  bestFitness: number;
  totalSequencesEvaluated: number;
  generationsRun: number;
  /** Snapshot hashes reached by the best sequence — caller can use
   *  these as a unique-state count proxy. */
  bestSequenceStates: string[];
}

const DEFAULT_POPULATION = 8;
const DEFAULT_GENERATIONS = 3;
const DEFAULT_SEQ_LENGTH = 4;

export async function evoExplore(
  page: Page,
  initialState: PageState,
  options: EvoExploreOptions = {},
): Promise<EvoExploreResult> {
  const populationSize = options.populationSize ?? DEFAULT_POPULATION;
  const generations = options.generations ?? DEFAULT_GENERATIONS;
  const sequenceLength = options.sequenceLength ?? DEFAULT_SEQ_LENGTH;
  const url = initialState.url;
  const seed = options.randomSeed ?? Date.now();
  const rng = makeRng(seed);

  const candidates = initialState.targets.filter(
    (t) => SAFE_INTERACTIVE_KINDS.has(t.kind) && t.name && t.role,
  );
  if (candidates.length === 0) {
    return {
      bestSequence: [],
      bestFitness: 1, // initial state itself
      totalSequencesEvaluated: 0,
      generationsRun: 0,
      bestSequenceStates: [initialState.snapshotHash],
    };
  }

  let population: InteractionStep[][] = Array.from({ length: populationSize }, () =>
    randomSequence(candidates, sequenceLength, rng),
  );

  let totalEvaluated = 0;
  let bestSequence: InteractionStep[] = population[0];
  let bestFitness = 0;
  let bestStates: string[] = [];

  // Wave 25: coverage-guided fitness. Track which targets have been
  // activated across all sequences this run; reward sequences that
  // touch novel ground (Black Widow / EvoCrawl convergence trick).
  const touchedTargets = new Set<string>();
  const touchedStates = new Set<string>();

  for (let gen = 0; gen < generations; gen++) {
    const fitnesses: Array<{ seq: InteractionStep[]; fitness: number; states: string[] }> = [];
    for (const seq of population) {
      const reached = await evaluateSequence(page, url, seq);
      totalEvaluated++;

      // Coverage-guided fitness:
      //   base       = unique states reached by this sequence (raw signal)
      //   stateNov   = +1 per state never reached by any prior sequence
      //   targetNov  = +1 per target this sequence activates that no
      //                prior sequence has activated
      // Total fitness rewards both raw coverage and novelty contribution
      // to the run-wide picture.
      let stateNov = 0;
      for (const s of reached) {
        if (!touchedStates.has(s)) {
          stateNov++;
          touchedStates.add(s);
        }
      }
      let targetNov = 0;
      for (const step of seq) {
        if (!touchedTargets.has(step.targetId)) {
          targetNov++;
          touchedTargets.add(step.targetId);
        }
      }
      const fitness = reached.length + stateNov + targetNov;

      fitnesses.push({ seq, fitness, states: reached });
      if (fitness > bestFitness) {
        bestFitness = fitness;
        bestSequence = seq;
        bestStates = reached;
      }
    }
    options.onGeneration?.(gen, bestFitness);

    // Selection: top half
    fitnesses.sort((a, b) => b.fitness - a.fitness);
    const survivors = fitnesses.slice(0, Math.max(2, Math.floor(populationSize / 2)));

    // Next generation: crossovers + a few mutations of the best
    const next: InteractionStep[][] = survivors.map((s) => s.seq);
    while (next.length < populationSize) {
      const parentA = survivors[Math.floor(rng() * survivors.length)].seq;
      const parentB = survivors[Math.floor(rng() * survivors.length)].seq;
      let child = crossover(parentA, parentB, rng);
      if (rng() < 0.3) child = mutate(child, candidates, rng);
      next.push(child);
    }
    population = next;
  }

  return {
    bestSequence,
    bestFitness,
    totalSequencesEvaluated: totalEvaluated,
    generationsRun: generations,
    bestSequenceStates: bestStates,
  };
}

function randomSequence(
  candidates: Target[],
  length: number,
  rng: () => number,
): InteractionStep[] {
  const out: InteractionStep[] = [];
  for (let i = 0; i < length; i++) {
    const t = candidates[Math.floor(rng() * candidates.length)];
    out.push({
      targetId: t.id,
      targetName: t.name,
      targetRole: t.role,
      action: "activate",
    });
  }
  return out;
}

function crossover(
  a: InteractionStep[],
  b: InteractionStep[],
  rng: () => number,
): InteractionStep[] {
  const point = Math.floor(rng() * Math.min(a.length, b.length));
  return [...a.slice(0, point), ...b.slice(point)];
}

function mutate(
  seq: InteractionStep[],
  candidates: Target[],
  rng: () => number,
): InteractionStep[] {
  const out = [...seq];
  const op = rng();
  if (op < 0.33 && out.length > 1) {
    // swap two positions
    const i = Math.floor(rng() * out.length);
    const j = Math.floor(rng() * out.length);
    [out[i], out[j]] = [out[j], out[i]];
  } else if (op < 0.66) {
    // replace one position with a random candidate
    const i = Math.floor(rng() * out.length);
    const t = candidates[Math.floor(rng() * candidates.length)];
    out[i] = {
      targetId: t.id,
      targetName: t.name,
      targetRole: t.role,
      action: "activate",
    };
  } else if (out.length < 8) {
    // insert at random position
    const i = Math.floor(rng() * (out.length + 1));
    const t = candidates[Math.floor(rng() * candidates.length)];
    out.splice(i, 0, {
      targetId: t.id,
      targetName: t.name,
      targetRole: t.role,
      action: "activate",
    });
  }
  return out;
}

async function evaluateSequence(
  page: Page,
  url: string,
  sequence: InteractionStep[],
): Promise<string[]> {
  const reached = new Set<string>();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(500);
  // Capture the initial post-navigation state once so we can dedup
  // sequences that don't change anything against the baseline.
  const initialState = await captureState(page, { provenance: "scripted" }).catch(() => null);
  if (initialState) reached.add(initialState.snapshotHash);

  for (const step of sequence) {
    try {
      const locator = page.getByRole(step.targetRole as Parameters<Page["getByRole"]>[0], {
        name: step.targetName,
        exact: true,
      }).first();
      const visible = await locator.isVisible({ timeout: 1000 }).catch(() => false);
      if (!visible) continue;
      await locator.focus({ timeout: 1500 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(200);
      const state = await captureState(page, { provenance: "explored" }).catch(() => null);
      if (state) reached.add(state.snapshotHash);
    } catch {
      // Step failed (target gone, etc.) — skip and continue.
    }
  }
  return [...reached];
}

/** Deterministic xorshift32 RNG so seeded runs are reproducible. */
function makeRng(seed: number): () => number {
  let state = seed | 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}
