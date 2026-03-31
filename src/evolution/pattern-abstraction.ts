/**
 * Pattern Abstraction — strips project-specific details for cross-project transfer.
 *
 * Converts ExtractedPattern → AbstractPattern by removing file paths,
 * retaining framework/language markers, and generalizing approach descriptions.
 * Imported patterns enter probation with 50% confidence reduction.
 *
 * Source of truth: vinyan-implementation-plan.md §PH4.6
 */
import type { ExtractedPattern, TaskFingerprint } from "../orchestrator/types.ts";

export interface AbstractPattern {
  /** Generalized task fingerprint — no project-specific file paths. */
  fingerprint: TaskFingerprint;
  /** Generalized approach description. */
  approach: string;
  /** Quality range observed in source project. */
  qualityRange: { min: number; max: number };
  /** Wilson LB confidence from source project. */
  confidence: number;
  /** Identifier for the source project. */
  sourceProjectId: string;
  /** IDs of source patterns this was derived from. */
  sourcePatternIds: string[];
  /** Conditions that must match for import eligibility. */
  applicabilityConditions: {
    frameworkMarkers: string[];
    languageMarkers: string[];
    complexityRange: string[];
  };
  /** Original pattern type. */
  type: ExtractedPattern["type"];
  /** Original description (generalized). */
  description: string;
  /** Export timestamp. */
  exportedAt: number;
}

export interface AbstractPatternExport {
  version: 1;
  projectId: string;
  exportedAt: number;
  patterns: AbstractPattern[];
}

/**
 * Abstract an ExtractedPattern for cross-project transfer.
 * Returns null if the pattern is too project-specific to generalize.
 */
export function abstractPattern(
  pattern: ExtractedPattern,
  projectId: string,
): AbstractPattern | null {
  // Must have meaningful confidence and frequency
  if (pattern.confidence < 0.3 || pattern.frequency < 3) return null;

  // Parse fingerprint from task type signature
  const fingerprint = parseFingerprint(pattern.taskTypeSignature);
  if (!fingerprint) return null;

  // Generalize approach — strip specific symbol names, file paths
  const approach = generalizeApproach(pattern.approach ?? "default");

  // Determine applicability conditions
  const languageMarkers = extractLanguageMarkers(fingerprint.fileExtensions);
  const complexityRange = [fingerprint.blastRadiusBucket];

  // If the pattern is tied to a single specific file with no generalizable traits, skip
  if (languageMarkers.length === 0 && !fingerprint.frameworkMarkers?.length) {
    return null;
  }

  return {
    fingerprint: {
      ...fingerprint,
      // Strip project-specific oracle failure patterns
      oracleFailurePattern: undefined,
    },
    approach,
    qualityRange: {
      min: Math.max(0, (pattern.qualityDelta ?? 0) - 0.1),
      max: (pattern.qualityDelta ?? 0) + 0.1,
    },
    confidence: pattern.confidence,
    sourceProjectId: projectId,
    sourcePatternIds: [pattern.id],
    applicabilityConditions: {
      frameworkMarkers: fingerprint.frameworkMarkers ?? [],
      languageMarkers,
      complexityRange,
    },
    type: pattern.type,
    description: generalizeDescription(pattern.description),
    exportedAt: Date.now(),
  };
}

/**
 * Convert an AbstractPattern back to an ExtractedPattern for import.
 * Confidence is reduced by 50% on import. Status is always probation.
 */
export function importAbstractPattern(
  abstract: AbstractPattern,
  targetProjectId: string,
): ExtractedPattern {
  const taskTypeSignature = [
    abstract.fingerprint.actionVerb,
    abstract.fingerprint.fileExtensions.join(","),
    abstract.fingerprint.blastRadiusBucket,
  ].join("::");

  return {
    id: `imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: abstract.type,
    description: `[imported] ${abstract.description}`,
    frequency: 0,
    confidence: abstract.confidence * 0.5,  // 50% reduction on import
    taskTypeSignature,
    approach: abstract.approach,
    sourceTraceIds: [],
    createdAt: Date.now(),
    decayWeight: 1.0,
    derivedFrom: abstract.sourcePatternIds[0],
  };
}

/**
 * Compute project similarity based on shared framework + language markers.
 * Returns a fraction 0-1. Threshold for import eligibility: ≥ 0.5.
 */
export function projectSimilarity(
  sourceConditions: AbstractPattern["applicabilityConditions"],
  targetMarkers: { frameworks: string[]; languages: string[] },
): number {
  const sourceSet = new Set([
    ...sourceConditions.frameworkMarkers,
    ...sourceConditions.languageMarkers,
  ]);
  const targetSet = new Set([
    ...targetMarkers.frameworks,
    ...targetMarkers.languages,
  ]);

  if (sourceSet.size === 0 && targetSet.size === 0) return 1.0;
  if (sourceSet.size === 0 || targetSet.size === 0) return 0;

  let shared = 0;
  for (const marker of sourceSet) {
    if (targetSet.has(marker)) shared++;
  }

  const union = new Set([...sourceSet, ...targetSet]).size;
  return shared / union;  // Jaccard similarity
}

/**
 * Classify pattern portability.
 * - "universal": no framework markers → applies everywhere
 * - "framework-specific": has framework markers → check similarity
 * - "project-specific": too specific to transfer
 */
export function classifyPortability(
  pattern: AbstractPattern,
): "universal" | "framework-specific" | "project-specific" {
  const conditions = pattern.applicabilityConditions;
  if (conditions.frameworkMarkers.length === 0 && conditions.languageMarkers.length > 0) {
    return "universal";
  }
  if (conditions.frameworkMarkers.length > 0) {
    return "framework-specific";
  }
  return "project-specific";
}

/**
 * Export patterns to JSON format.
 */
export function exportPatterns(
  patterns: ExtractedPattern[],
  projectId: string,
): AbstractPatternExport {
  const abstracted: AbstractPattern[] = [];
  for (const p of patterns) {
    const ap = abstractPattern(p, projectId);
    if (ap) abstracted.push(ap);
  }

  return {
    version: 1,
    projectId,
    exportedAt: Date.now(),
    patterns: abstracted,
  };
}

/**
 * Import patterns from a JSON export, checking similarity threshold.
 */
export function importPatterns(
  exported: AbstractPatternExport,
  targetProjectId: string,
  targetMarkers: { frameworks: string[]; languages: string[] },
  similarityThreshold = 0.5,
): ExtractedPattern[] {
  const imported: ExtractedPattern[] = [];

  for (const ap of exported.patterns) {
    const similarity = projectSimilarity(ap.applicabilityConditions, targetMarkers);
    if (similarity >= similarityThreshold) {
      imported.push(importAbstractPattern(ap, targetProjectId));
    }
  }

  return imported;
}

// ── Internal helpers ──────────────────────────────────────────────────

/** Parse a fingerprint key back to a TaskFingerprint. */
function parseFingerprint(taskTypeSignature: string): TaskFingerprint | null {
  const parts = taskTypeSignature.split("::");
  if (parts.length < 2) return null;

  const actionVerb = parts[0] ?? "unknown";
  const extensionPart = parts[1] ?? "";
  const blastBucket = parts[2] as TaskFingerprint["blastRadiusBucket"] | undefined;

  const fileExtensions = extensionPart
    .split(",")
    .map(e => e.trim())
    .filter(e => e.length > 0);

  return {
    actionVerb,
    fileExtensions,
    blastRadiusBucket: blastBucket ?? "small",
  };
}

/** Generalize approach — replace specific identifiers with placeholders. */
function generalizeApproach(approach: string): string {
  return approach
    // Replace specific file paths
    .replace(/(?:src|lib|app)\/[\w./]+/g, "<path>")
    // Replace specific function/class names (camelCase/PascalCase)
    .replace(/\b[A-Z][a-zA-Z0-9]{8,}\b/g, "<Symbol>")
    // Replace specific variable names that are too long
    .replace(/\b[a-z][a-zA-Z0-9]{12,}\b/g, "<variable>");
}

/** Generalize description — same path/symbol stripping. */
function generalizeDescription(description: string): string {
  return description
    .replace(/(?:src|lib|app)\/[\w./]+/g, "<path>")
    .replace(/"[^"]{20,}"/g, '"<specific>"');
}

/** Extract language markers from file extensions. */
function extractLanguageMarkers(extensions: string[]): string[] {
  const langMap: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".rb": "ruby",
    ".cs": "csharp",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
    ".swift": "swift",
    ".kt": "kotlin",
  };

  const markers = new Set<string>();
  for (const ext of extensions) {
    const lang = langMap[ext];
    if (lang) markers.add(lang);
  }
  return [...markers];
}
