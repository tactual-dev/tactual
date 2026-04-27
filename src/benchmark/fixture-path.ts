import { existsSync } from "fs";
import { fileURLToPath } from "url";

export function fixturePath(name: string): string {
  const candidates = [
    new URL(`../../fixtures/${name}`, import.meta.url),
    new URL(`../fixtures/${name}`, import.meta.url),
  ];

  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }

  return fileURLToPath(candidates[0]);
}
