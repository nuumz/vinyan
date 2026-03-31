/**
 * Task Fingerprinting — 5-dimension fingerprint for capability matching.
 *
 * 3 always-active dimensions (from PH3.1 task signatures):
 *   actionVerb, fileExtensions, blastRadiusBucket
 * 2 data-gated dimensions:
 *   frameworkMarkers (200+ traces), oracleFailurePattern (500+ traces)
 *
 * Source of truth: vinyan-implementation-plan.md §Phase 4.3
 */
import type { TaskFingerprint, TaskInput, PerceptualHierarchy } from "./types.ts";

/** Known framework patterns detected from import paths. */
const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; marker: string }> = [
  { pattern: /\breact\b/i, marker: "react" },
  { pattern: /\bnext\b/i, marker: "next" },
  { pattern: /\bexpress\b/i, marker: "express" },
  { pattern: /\bfastify\b/i, marker: "fastify" },
  { pattern: /\bzod\b/i, marker: "zod" },
  { pattern: /\bprisma\b/i, marker: "prisma" },
  { pattern: /\btailwind\b/i, marker: "tailwind" },
  { pattern: /\bvue\b/i, marker: "vue" },
  { pattern: /\bangular\b/i, marker: "angular" },
  { pattern: /\bsvelte\b/i, marker: "svelte" },
  { pattern: /\btypeorm\b/i, marker: "typeorm" },
  { pattern: /\bdrizzle\b/i, marker: "drizzle" },
  { pattern: /\bmongoose\b/i, marker: "mongoose" },
  { pattern: /\bjest\b/i, marker: "jest" },
  { pattern: /\bvitest\b/i, marker: "vitest" },
  { pattern: /\bpytest\b/i, marker: "pytest" },
];

/** Common action verbs extracted from task goal text. */
const ACTION_VERBS = [
  "refactor", "fix", "add", "remove", "update", "test",
  "rename", "move", "extract", "inline", "optimize",
  "migrate", "convert", "implement", "delete", "create",
];

/**
 * Compute a task fingerprint from input and perception data.
 * Deterministic for same inputs (A3 compliance).
 */
export function computeFingerprint(
  input: TaskInput,
  perception?: PerceptualHierarchy,
): TaskFingerprint {
  const actionVerb = extractActionVerb(input.goal);
  const fileExtensions = extractFileExtensions(input.targetFiles ?? []);
  const blastRadiusBucket = computeBlastBucket(perception);
  const frameworkMarkers = perception ? detectFrameworkMarkers(perception) : undefined;

  return {
    actionVerb,
    fileExtensions,
    blastRadiusBucket,
    frameworkMarkers: frameworkMarkers?.length ? frameworkMarkers : undefined,
  };
}

/**
 * Detect framework markers from perception's dependency cone.
 * Scans directImportees for known framework patterns.
 */
export function detectFrameworkMarkers(perception: PerceptualHierarchy): string[] {
  const importees = perception.dependencyCone.directImportees;
  const markers = new Set<string>();

  for (const importee of importees) {
    for (const { pattern, marker } of FRAMEWORK_PATTERNS) {
      if (pattern.test(importee)) {
        markers.add(marker);
      }
    }
  }

  return [...markers].sort();
}

/**
 * Extract the primary action verb from a task goal string.
 */
function extractActionVerb(goal: string): string {
  const lower = goal.toLowerCase();
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) return verb;
  }
  return "unknown";
}

/**
 * Extract unique file extensions from target files.
 */
function extractFileExtensions(targetFiles: string[]): string[] {
  const exts = new Set<string>();
  for (const file of targetFiles) {
    const dot = file.lastIndexOf(".");
    if (dot >= 0) {
      exts.add(file.slice(dot));
    }
  }
  return [...exts].sort();
}

/**
 * Compute blast radius bucket from perception data.
 */
function computeBlastBucket(
  perception?: PerceptualHierarchy,
): TaskFingerprint["blastRadiusBucket"] {
  if (!perception) return "single";
  const radius = perception.dependencyCone.transitiveBlastRadius;
  if (radius <= 1) return "single";
  if (radius <= 5) return "small";
  if (radius <= 20) return "medium";
  return "large";
}

/**
 * Serialize a fingerprint to a string key for trace grouping.
 * Deterministic for same fingerprint.
 */
export function fingerprintKey(fp: TaskFingerprint): string {
  return `${fp.actionVerb}::${fp.fileExtensions.join(",")}::${fp.blastRadiusBucket}`;
}
