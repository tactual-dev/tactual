import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Read the package version from package.json at build time.
 * Falls back to "0.0.0-unknown" if the file can't be read.
 */
function readVersion(): string {
  try {
    // Walk up from src/ to find package.json
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

export const VERSION = readVersion();
