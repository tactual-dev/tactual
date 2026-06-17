import type { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import type { AnalysisResult, Target } from "../../core/types.js";
import type {
  AnnouncementObservation,
  AnnouncementSource,
  CalibrationDataset,
} from "../../calibration/types.js";
import { compareTargetAnnouncement } from "../../calibration/announcement-comparison.js";
import { runAnalyzeUrl } from "../../pipeline/analyze-url.js";
import type { ATKind } from "../../playwright/sr-simulator.js";

type OutputFormat = "text" | "json";

interface ObserveAnnouncementOptions {
  url?: string;
  analysis?: string;
  profile?: string;
  at?: string;
  targetSelector?: string;
  observed?: string;
  observedFile?: string;
  observedToken?: string[];
  source?: string;
  tester?: string;
  atVersion?: string;
  browser?: string;
  notes?: string;
  output?: string;
  append?: boolean;
  format?: string;
  timeout?: string;
  waitForSelector?: string;
  storageState?: string;
  detectRoutes?: boolean;
  descendFrames?: boolean;
  autoScroll?: boolean;
  dismissBanners?: boolean;
}

interface MatchedTarget {
  stateId: string;
  target: Target;
}

const AT_VALUES: readonly ATKind[] = ["nvda", "jaws", "voiceover"];
const SOURCES: readonly AnnouncementSource[] = [
  "manual-sr",
  "nvda-vm",
  "virtual-sr",
  "fixture",
  "aria-at",
  "other",
];

export function registerObserveAnnouncement(program: Command): void {
  program
    .command("observe-announcement <target>")
    .description(
      "Compare Tactual's modeled screen-reader announcement with observed/tested output " +
        "and emit an announcement calibration observation.",
    )
    .option("--url <url>", "Analyze a URL before matching the target")
    .option("--analysis <path>", "Read an existing Tactual analysis JSON instead of loading a URL")
    .option("-p, --profile <id>", "AT profile to use when analyzing a URL")
    .option("--at <name>", "Announcement model: nvda | jaws | voiceover")
    .option("--target-selector <selector>", "CSS selector for precise target matching")
    .option("--observed <text>", "Observed/tested announcement text")
    .option("--observed-file <path>", "Read observed/tested announcement text from a file")
    .option(
      "--observed-token <tokens...>",
      "Stable observed tokens such as name, role, and state when exact phrasing is noisy",
    )
    .option(
      "--source <source>",
      "Observation source: manual-sr | nvda-vm | virtual-sr | fixture | aria-at | other",
      "manual-sr",
    )
    .option("--tester <id>", "Tester identifier for calibration metadata", "oss-review")
    .option("--at-version <version>", "AT software/version used during observation")
    .option("--browser <version>", "Browser/version used during observation")
    .option("--notes <text>", "Free-form context such as verbosity, mode, or uncertainty")
    .option("-o, --output <path>", "Write the observation JSON to a file")
    .option("--append", "Append to output as a CalibrationDataset. Creates one when missing.")
    .option("-f, --format <format>", "Output format: text | json", "text")
    .option("--timeout <ms>", "Page load timeout when --url is used", "30000")
    .option("--wait-for-selector <selector>", "CSS selector to wait for when --url is used")
    .option("--storage-state <path>", "Playwright storageState JSON when --url is used")
    .option("--detect-routes", "Record SPA route changes when --url is used")
    .option("--descend-frames", "Include iframe targets when --url is used")
    .option("--auto-scroll", "Scroll lazy content into the tree when --url is used")
    .option("--dismiss-banners", "Dismiss safe cookie/consent banners when --url is used")
    .action(async (target: string, opts: ObserveAnnouncementOptions) => {
      try {
        const at = parseAt(opts.at, opts.profile);
        const source = parseSource(opts.source);
        const format = parseFormat(opts.format);
        const loaded = await loadAnalysis(opts);
        const match = findTarget(loaded.result, target, opts.targetSelector);
        if (!match) {
          throw new Error(
            `No target matched "${target}". Use --target-selector or inspect analyze-url JSON for a stable id/name.`,
          );
        }

        const observedAnnouncement = await readObservedAnnouncement(opts);
        const observation = buildObservation({
          url: loaded.url,
          profileId: opts.profile ?? loaded.result.metadata.profile,
          targetName: match.target.name || target,
          targetId: `${match.stateId}:${match.target.id}`,
          targetSelector: opts.targetSelector ?? match.target.selector,
          at,
          observedAnnouncement,
          observedTokens: opts.observedToken,
          source,
          testerId: opts.tester,
          atVersion: opts.atVersion,
          browser: opts.browser,
          notes: opts.notes,
        });
        const comparison = compareTargetAnnouncement({
          target: match.target,
          at,
          observedAnnouncement,
          observedTokens: opts.observedToken,
          source,
        });

        const payload = {
          url: loaded.url,
          profileId: observation.profileId,
          at,
          source,
          target: {
            stateId: match.stateId,
            id: match.target.id,
            role: match.target.role,
            kind: match.target.kind,
            name: match.target.name,
            selector: match.target.selector,
          },
          modeledAnnouncement: comparison.modeledAnnouncement,
          observedAnnouncement,
          observedAnnouncementTokens: opts.observedToken,
          announcementAccuracy: comparison.announcementAccuracy,
          announcementMatch: comparison.announcementMatch,
          missingAnnouncementTokens: comparison.missingAnnouncementTokens,
          unexpectedAnnouncementTokens: comparison.unexpectedAnnouncementTokens,
          announcementAssumptions: comparison.announcementAssumptions,
          observation,
        };

        if (opts.output) {
          await writeObservation(opts.output, observation, opts.append === true);
        }

        if (format === "json") {
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log(formatText(payload));
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

async function loadAnalysis(opts: ObserveAnnouncementOptions): Promise<{
  result: AnalysisResult;
  url: string;
}> {
  if (opts.analysis && opts.url) {
    throw new Error("Use either --analysis or --url, not both.");
  }
  if (!opts.analysis && !opts.url) {
    throw new Error("observe-announcement requires --analysis <path> or --url <url>.");
  }

  if (opts.analysis) {
    const parsed = JSON.parse(await readFile(opts.analysis, "utf-8")) as
      | AnalysisResult
      | { result?: AnalysisResult; url?: string };
    const wrapper = parsed as { result?: AnalysisResult; url?: string };
    const result = wrapper.result ?? (parsed as AnalysisResult);
    return { result, url: resolveAnalysisUrl(result, wrapper.url) };
  }

  const analyzed = await runAnalyzeUrl({
    url: opts.url!,
    profileId: opts.profile,
    timeout: parseInt(opts.timeout ?? "30000", 10),
    waitForSelector: opts.waitForSelector,
    storageState: opts.storageState,
    detectRoutes: opts.detectRoutes === true,
    descendFrames: opts.descendFrames === true,
    autoScroll: opts.autoScroll === true,
    dismissBanners: opts.dismissBanners === true,
    checkVisibility: false,
  });
  return { result: analyzed.result, url: analyzed.url };
}

function resolveAnalysisUrl(result: AnalysisResult, explicit?: string): string {
  return explicit ?? result.flow.name ?? result.states[0]?.url ?? "";
}

function findTarget(
  result: AnalysisResult,
  hint: string,
  selector?: string,
): MatchedTarget | null {
  const normalized = hint.toLowerCase();
  const candidates = result.states.flatMap((state) =>
    state.targets.map((target) => ({ stateId: state.id, target })),
  );

  const exactId = candidates.find((candidate) => {
    const target = candidate.target;
    return (
      target.id.toLowerCase() === normalized ||
      `${candidate.stateId}:${target.id}`.toLowerCase() === normalized
    );
  });
  if (exactId) return exactId;

  if (selector) {
    const matched = candidates.find((candidate) => candidate.target.selector === selector);
    if (matched) return matched;
  }

  const exactName = candidates.find((candidate) => candidate.target.name.toLowerCase() === normalized);
  if (exactName) return exactName;

  return candidates.find((candidate) => {
    const target = candidate.target;
    return (
      target.name.toLowerCase().includes(normalized) ||
      target.role.toLowerCase() === normalized ||
      target.kind.toLowerCase() === normalized ||
      target.id.toLowerCase().includes(normalized)
    );
  }) ?? null;
}

async function readObservedAnnouncement(
  opts: ObserveAnnouncementOptions,
): Promise<string | undefined> {
  if (opts.observed && opts.observedFile) {
    throw new Error("Use either --observed or --observed-file, not both.");
  }
  if (opts.observedFile) return (await readFile(opts.observedFile, "utf-8")).trim();
  return opts.observed;
}

function buildObservation(args: {
  url: string;
  profileId: string;
  targetName: string;
  targetId?: string;
  targetSelector?: string;
  at: ATKind;
  observedAnnouncement?: string;
  observedTokens?: string[];
  source: AnnouncementSource;
  testerId?: string;
  atVersion?: string;
  browser?: string;
  notes?: string;
}): AnnouncementObservation {
  return {
    url: args.url,
    profileId: args.profileId,
    targetName: args.targetName,
    ...(args.targetId ? { targetId: args.targetId } : {}),
    ...(args.targetSelector ? { targetSelector: args.targetSelector } : {}),
    announcementAt: args.at,
    ...(args.observedAnnouncement ? { observedAnnouncement: args.observedAnnouncement } : {}),
    ...(args.observedTokens && args.observedTokens.length > 0
      ? { observedAnnouncementTokens: args.observedTokens }
      : {}),
    announcementSource: args.source,
    ...(args.atVersion ? { atVersion: args.atVersion } : {}),
    ...(args.browser ? { browser: args.browser } : {}),
    ...(args.testerId ? { testerId: args.testerId } : {}),
    ...(args.notes ? { announcementNotes: args.notes } : {}),
    timestamp: new Date().toISOString(),
  };
}

async function writeObservation(
  path: string,
  observation: AnnouncementObservation,
  append: boolean,
): Promise<void> {
  if (!append) {
    await writeFile(path, `${JSON.stringify(observation, null, 2)}\n`, "utf-8");
    return;
  }

  let dataset: CalibrationDataset;
  try {
    dataset = JSON.parse(await readFile(path, "utf-8")) as CalibrationDataset;
  } catch {
    dataset = {
      name: "announcement-observations",
      collectedAt: new Date().toISOString(),
      observations: [],
      announcementObservations: [],
    };
  }
  dataset.announcementObservations ??= [];
  dataset.announcementObservations.push(observation);
  await writeFile(path, `${JSON.stringify(dataset, null, 2)}\n`, "utf-8");
}

function parseAt(value: string | undefined, profileId: string | undefined): ATKind {
  const inferred = profileId?.includes("jaws")
    ? "jaws"
    : profileId?.includes("voiceover")
      ? "voiceover"
      : "nvda";
  const at = (value ?? inferred) as ATKind;
  if (!AT_VALUES.includes(at)) {
    throw new Error(`Unknown --at value: ${value}. Use: nvda | jaws | voiceover.`);
  }
  return at;
}

function parseSource(value: string | undefined): AnnouncementSource {
  const source = (value ?? "manual-sr") as AnnouncementSource;
  if (!SOURCES.includes(source)) {
    throw new Error(
      `Unknown --source value: ${value}. Use: manual-sr | nvda-vm | virtual-sr | fixture | aria-at | other.`,
    );
  }
  return source;
}

function parseFormat(value: string | undefined): OutputFormat {
  const format = (value ?? "text") as OutputFormat;
  if (format !== "text" && format !== "json") {
    throw new Error(`Unknown --format value: ${value}. Use: text | json.`);
  }
  return format;
}

function formatText(payload: {
  url: string;
  profileId: string;
  at: ATKind;
  source: AnnouncementSource;
  target: { id: string; role: string; kind: string; name: string; selector?: string };
  modeledAnnouncement: string;
  observedAnnouncement?: string;
  observedAnnouncementTokens?: string[];
  announcementAccuracy: number;
  announcementMatch: boolean;
  missingAnnouncementTokens: string[];
  unexpectedAnnouncementTokens: string[];
  announcementAssumptions?: Array<{ id: string; status: string; expected?: string; observed?: string }>;
  observation: AnnouncementObservation;
}): string {
  const lines: string[] = [];
  lines.push(`Announcement observation for ${payload.url}`);
  lines.push(`Profile: ${payload.profileId}   AT model: ${payload.at}   Source: ${payload.source}`);
  lines.push(
    `Target: ${payload.target.name || "(unnamed)"} [${payload.target.role}/${payload.target.kind}] ${payload.target.id}`,
  );
  if (payload.target.selector) lines.push(`Selector: ${payload.target.selector}`);
  lines.push("");
  lines.push(`Modeled:  ${payload.modeledAnnouncement}`);
  lines.push(`Observed: ${payload.observedAnnouncement ?? "(tokens only or not supplied)"}`);
  if (payload.observedAnnouncementTokens?.length) {
    lines.push(`Observed tokens: ${payload.observedAnnouncementTokens.join(", ")}`);
  }
  lines.push(
    `Token match: ${payload.announcementMatch ? "yes" : "no"} ` +
      `(${Math.round(payload.announcementAccuracy * 100)}%)`,
  );
  if (payload.missingAnnouncementTokens.length > 0) {
    lines.push(`Missing modeled tokens: ${payload.missingAnnouncementTokens.join(", ")}`);
  }
  if (payload.unexpectedAnnouncementTokens.length > 0) {
    lines.push(`Unexpected observed tokens: ${payload.unexpectedAnnouncementTokens.join(", ")}`);
  }
  const challenged = payload.announcementAssumptions?.filter((assumption) => assumption.status !== "confirmed") ?? [];
  if (challenged.length > 0) {
    lines.push(
      `Mapper assumptions to review: ${
        challenged.map((assumption) =>
          `${assumption.id}=${assumption.status}(${assumption.expected || assumption.observed || ""})`,
        ).join("; ")
      }`,
    );
  }
  lines.push("");
  lines.push("Observation JSON:");
  lines.push(JSON.stringify(payload.observation, null, 2));
  return lines.join("\n");
}
