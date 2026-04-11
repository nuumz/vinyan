/**
 * Task Fingerprinting — 5-dimension fingerprint for capability matching.
 *
 * 3 always-active dimensions (from PH3.1 task signatures):
 *   actionVerb, fileExtensions, blastRadiusBucket
 * 2 data-gated dimensions:
 *   frameworkMarkers (200+ traces), oracleFailurePattern (500+ traces)
 *
 * Source of truth: design/implementation-plan.md §Phase 4.3
 */
import type { ExecutionTrace, PerceptualHierarchy, TaskFingerprint, TaskInput } from './types.ts';

/** Known framework patterns detected from import paths. */
const FRAMEWORK_PATTERNS: Array<{ pattern: RegExp; marker: string }> = [
  { pattern: /\breact\b/i, marker: 'react' },
  { pattern: /\bnext\b/i, marker: 'next' },
  { pattern: /\bexpress\b/i, marker: 'express' },
  { pattern: /\bfastify\b/i, marker: 'fastify' },
  { pattern: /\bzod\b/i, marker: 'zod' },
  { pattern: /\bprisma\b/i, marker: 'prisma' },
  { pattern: /\btailwind\b/i, marker: 'tailwind' },
  { pattern: /\bvue\b/i, marker: 'vue' },
  { pattern: /\bangular\b/i, marker: 'angular' },
  { pattern: /\bsvelte\b/i, marker: 'svelte' },
  { pattern: /\btypeorm\b/i, marker: 'typeorm' },
  { pattern: /\bdrizzle\b/i, marker: 'drizzle' },
  { pattern: /\bmongoose\b/i, marker: 'mongoose' },
  { pattern: /\bjest\b/i, marker: 'jest' },
  { pattern: /\bvitest\b/i, marker: 'vitest' },
  { pattern: /\bpytest\b/i, marker: 'pytest' },
];

/** Common action verbs extracted from task goal text. */
export const ACTION_VERBS = [
  'refactor',
  'fix',
  'add',
  'remove',
  'update',
  'test',
  'rename',
  'move',
  'extract',
  'inline',
  'optimize',
  'migrate',
  'convert',
  'implement',
  'delete',
  'create',
];

/**
 * Options for data-gated fingerprint dimensions.
 * Pass traceCount to enable gated dimensions (frameworkMarkers at 200+, oracleFailurePattern at 500+).
 */
export interface FingerprintOptions {
  traceCount?: number;
  /** Pre-computed oracle failure pattern for this task type (requires DB access). */
  oracleFailurePattern?: string;
}

/**
 * Compute a task fingerprint from input and perception data.
 * Deterministic for same inputs (A3 compliance).
 */
export function computeFingerprint(
  input: TaskInput,
  perception?: PerceptualHierarchy,
  options?: FingerprintOptions,
): TaskFingerprint {
  const actionVerb = extractActionVerb(input.goal);
  const fileExtensions = extractFileExtensions(input.targetFiles ?? []);
  const blastRadiusBucket = computeBlastBucket(perception);

  const traceCount = options?.traceCount ?? 0;

  // Data-gated dimension: frameworkMarkers (200+ traces)
  const frameworkMarkers = traceCount >= 200 && perception ? detectFrameworkMarkers(perception) : undefined;

  // Data-gated dimension: oracleFailurePattern (500+ traces)
  const oracleFailurePattern =
    traceCount >= 500 && options?.oracleFailurePattern ? options.oracleFailurePattern : undefined;

  return {
    actionVerb,
    fileExtensions,
    blastRadiusBucket,
    frameworkMarkers: frameworkMarkers?.length ? frameworkMarkers : undefined,
    oracleFailurePattern,
  };
}

/**
 * Compute the most-frequently-failing oracle for a given task type signature from traces.
 * Returns the oracle name or undefined if no dominant failure exists.
 */
export function computeOracleFailurePattern(traces: ExecutionTrace[], taskTypeSignature: string): string | undefined {
  const oracleFails = new Map<string, number>();
  for (const trace of traces) {
    if (trace.taskTypeSignature !== taskTypeSignature) continue;
    for (const [oracle, passed] of Object.entries(trace.oracleVerdicts)) {
      if (!passed) {
        oracleFails.set(oracle, (oracleFails.get(oracle) ?? 0) + 1);
      }
    }
  }
  if (oracleFails.size === 0) return undefined;
  const sorted = [...oracleFails.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0];
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
 * Shared across self-model, task-fingerprint, and task-understanding (Gap 5B unification).
 */
export function extractActionVerb(goal: string): string {
  const lower = goal.toLowerCase();
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) return verb;
  }
  return 'unknown';
}

/**
 * Extract unique file extensions from target files.
 */
function extractFileExtensions(targetFiles: string[]): string[] {
  const exts = new Set<string>();
  for (const file of targetFiles) {
    const dot = file.lastIndexOf('.');
    if (dot >= 0) {
      exts.add(file.slice(dot));
    }
  }
  return [...exts].sort();
}

/**
 * Compute blast radius bucket from perception data.
 */
function computeBlastBucket(perception?: PerceptualHierarchy): TaskFingerprint['blastRadiusBucket'] {
  if (!perception) return 'single';
  const radius = perception.dependencyCone.transitiveBlastRadius;
  if (radius <= 1) return 'single';
  if (radius <= 5) return 'small';
  if (radius <= 20) return 'medium';
  return 'large';
}

/**
 * Serialize a fingerprint to a string key for trace grouping.
 * Deterministic for same fingerprint.
 */
export function fingerprintKey(fp: TaskFingerprint): string {
  return `${fp.actionVerb}::${fp.fileExtensions.join(',')}::${fp.blastRadiusBucket}`;
}
