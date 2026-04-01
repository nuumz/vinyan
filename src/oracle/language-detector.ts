/**
 * Language Detector — auto-detect project languages from marker files.
 *
 * Source of truth: design/implementation-plan.md PH5.10
 */
import { existsSync } from "fs";
import { join } from "path";

export interface DetectedLanguage {
  language: string;
  marker: string;
}

/** Marker file → language mapping. */
const LANGUAGE_MARKERS: Array<{ file: string; language: string }> = [
  { file: "package.json", language: "typescript" },
  { file: "tsconfig.json", language: "typescript" },
  { file: "pyproject.toml", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "go.mod", language: "go" },
  { file: "Cargo.toml", language: "rust" },
];

/**
 * Detect project languages from marker files in the workspace root.
 * Returns deduplicated list of detected languages.
 */
export function detectLanguages(workspace: string): DetectedLanguage[] {
  const detected = new Map<string, string>();

  for (const marker of LANGUAGE_MARKERS) {
    if (existsSync(join(workspace, marker.file))) {
      // First match per language wins
      if (!detected.has(marker.language)) {
        detected.set(marker.language, marker.file);
      }
    }
  }

  return [...detected.entries()].map(([language, marker]) => ({ language, marker }));
}
