import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { z } from "zod";
import type { AnalysisFilter } from "./filter.js";

const TactualConfigSchema = z.object({
  exclude: z.array(z.string()).optional(),
  excludeSelectors: z.array(z.string()).optional(),
  focus: z.array(z.string()).optional(),
  suppress: z.array(z.string()).optional(),
  priority: z.record(z.string(), z.enum(["critical", "normal", "low", "ignore"])).optional(),
  profile: z.string().optional(),
  device: z.string().optional(),
  explore: z.boolean().optional(),
  threshold: z.number().optional(),
  maxFindings: z.number().int().min(0).optional(),
  minSeverity: z.enum(["severe", "high", "moderate", "acceptable", "strong"]).optional(),
}).passthrough();

/**
 * Tactual configuration file format (tactual.json).
 */
export type TactualConfig = z.infer<typeof TactualConfigSchema>;

/**
 * Load a tactual.json config file.
 * Searches the given path, or auto-detects from CWD.
 */
export function loadConfig(configPath?: string): TactualConfig {
  const path = configPath
    ? resolve(configPath)
    : findConfigFile();

  if (!path) return {};

  try {
    const content = readFileSync(path, "utf-8");
    const raw = JSON.parse(content);
    return TactualConfigSchema.parse(raw);
  } catch (err) {
    if (configPath) {
      // Explicit path — error if can't load
      throw new Error(`Failed to load config from ${path}: ${err}`, { cause: err });
    }
    // Auto-detected — silently ignore
    return {};
  }
}

/**
 * Merge CLI flags with config file settings.
 * CLI flags take precedence over config file.
 */
export function mergeConfigWithFlags(
  config: TactualConfig,
  flags: Partial<TactualConfig>,
): TactualConfig {
  return {
    ...config,
    ...Object.fromEntries(
      Object.entries(flags).filter(([_, v]) => v !== undefined),
    ),
    // Arrays merge (CLI adds to config, doesn't replace)
    exclude: mergeArrays(config.exclude, flags.exclude),
    excludeSelectors: mergeArrays(config.excludeSelectors, flags.excludeSelectors),
    focus: flags.focus ?? config.focus,
    suppress: mergeArrays(config.suppress, flags.suppress),
    priority: { ...config.priority, ...flags.priority },
  };
}

/**
 * Convert a TactualConfig into an AnalysisFilter.
 */
export function configToFilter(config: TactualConfig): AnalysisFilter {
  return {
    exclude: config.exclude,
    excludeSelectors: config.excludeSelectors,
    focus: config.focus,
    suppress: config.suppress as AnalysisFilter["suppress"],
    priority: config.priority,
    threshold: config.threshold,
    maxFindings: config.maxFindings,
    minSeverity: config.minSeverity,
  };
}

function findConfigFile(): string | null {
  const candidates = ["tactual.json", ".tactualrc.json"];
  for (const name of candidates) {
    const path = resolve(name);
    if (existsSync(path)) return path;
  }
  return null;
}

function mergeArrays(
  base?: string[],
  override?: string[],
): string[] | undefined {
  if (!base && !override) return undefined;
  return [...(base ?? []), ...(override ?? [])];
}
