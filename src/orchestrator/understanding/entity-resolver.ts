/**
 * Entity Resolver — NL reference → code path resolution (STU Layer 1).
 *
 * Deterministic, no LLM, A3-safe. Resolves natural-language references
 * in a task goal to actual file paths in the codebase.
 *
 * Algorithm: exact match → fuzzy per-token path match → symbol search → dependency inference.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type { ResolvedEntity, TaskInput, TaskUnderstanding } from '../types.ts';

/** Only entities above this threshold expand perception (file contents loaded). */
export const PERCEPTION_EXPANSION_THRESHOLD = 0.8;

/** Minimum fuzzy match score to include an entity. */
const FUZZY_MATCH_THRESHOLD = 0.6;

/** File extensions to include in resolution. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py']);

/** Directories to skip during file walking. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vinyan', '.next', '__pycache__']);

/** All known action verbs — filtered out of goal tokens to avoid matching verb-named files. */
const ALL_VERBS = new Set([
  // mutation
  'fix',
  'add',
  'remove',
  'update',
  'refactor',
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
  // analysis
  'analyze',
  'explain',
  'describe',
  'review',
  'audit',
  'inspect',
  'summarize',
  // investigation
  'investigate',
  'debug',
  'trace',
  'find',
  'diagnose',
  'why',
  // design
  'design',
  'plan',
  'architect',
  'propose',
  'suggest',
  // qa
  'test',
  'write',
]);

/** Common stop words to filter from goal tokens. */
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'my',
  'our',
  'we',
  'i',
  'not',
  'no',
  'but',
  'so',
  'if',
  'when',
  'how',
  'what',
  'which',
  'where',
  'like',
  'just',
  'also',
  'same',
  'from',
  'into',
  'about',
  'up',
  'out',
  'all',
  'can',
  'make',
  'way',
  'new',
  'old',
  'get',
  'set',
  'use',
]);

/**
 * Recursively walk a directory and collect source file paths (relative to root).
 * Skips directories in SKIP_DIRS, only includes files with SOURCE_EXTENSIONS.
 */
function walkSourceFiles(root: string, dir: string = root): string[] {
  const results: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir) as string[];
  } catch {
    return results;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (SKIP_DIRS.has(name)) continue;
    const fullPath = join(dir, name);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkSourceFiles(root, fullPath));
      } else if (stat.isFile()) {
        const ext = name.slice(name.lastIndexOf('.'));
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(relative(root, fullPath));
        }
      }
    } catch {
      // stat failure — skip
    }
  }
  return results;
}

/** Tokenize goal text into meaningful tokens for fuzzy matching. */
function tokenizeGoal(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[\s\-_./\\,;:!?()[\]{}'"]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !ALL_VERBS.has(t));
}

/** Compute path specificity bonus: deeper paths are more specific. */
function pathSpecificityBonus(path: string): number {
  const depth = path.split('/').length;
  return 1 + Math.min(depth * 0.05, 0.25); // max 1.25 bonus
}

/** Compute consecutive token bonus: tokens appearing in sequence in the path. */
function consecutiveTokenBonus(tokens: string[], pathLower: string): number {
  if (tokens.length < 2) return 0;
  let maxConsecutive = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const combined = tokens[i]! + tokens[i + 1]!;
    if (pathLower.includes(combined)) maxConsecutive++;
  }
  return maxConsecutive;
}

export class EntityResolver {
  private fileCache: Map<string, string[]> = new Map();

  constructor(
    private workspace: string,
    private worldGraph?: WorldGraph,
  ) {}

  /**
   * Resolve NL references in a task goal to code file paths.
   * 4-step deterministic algorithm: exact → fuzzy path → symbol → dependency inference.
   */
  resolve(input: TaskInput, understanding: TaskUnderstanding, opts?: { forceRefresh?: boolean }): ResolvedEntity[] {
    if (opts?.forceRefresh) {
      this.fileCache.clear();
    }

    const results: ResolvedEntity[] = [];

    // Step 1: Exact match — targetFiles are ground truth
    if (input.targetFiles?.length) {
      results.push({
        reference: input.targetFiles.join(', '),
        resolvedPaths: [...input.targetFiles],
        resolution: 'exact',
        confidence: 1.0,
        confidenceSource: 'evidence-derived',
      });
      return results; // Exact match is authoritative — skip fuzzy resolution
    }

    // Step 2: Fuzzy per-token path match
    const tokens = tokenizeGoal(input.goal);
    if (tokens.length > 0) {
      const files = this.getSourceFiles();
      const scored: Array<{ path: string; score: number; matchedTokens: string[] }> = [];

      for (const filePath of files) {
        const pathLower = filePath.toLowerCase();
        // Also match against file name without extension for better recall
        const fileName =
          pathLower
            .split('/')
            .pop()
            ?.replace(/\.\w+$/, '') ?? '';
        const matchedTokens = tokens.filter((t) => pathLower.includes(t) || fileName.includes(t));

        if (matchedTokens.length === 0) continue;

        const tokenRatio = matchedTokens.length / tokens.length;
        const specificity = pathSpecificityBonus(filePath);
        const consecutive = consecutiveTokenBonus(matchedTokens, pathLower);
        const score = tokenRatio * specificity * (1 + 0.1 * consecutive);

        if (score >= FUZZY_MATCH_THRESHOLD) {
          scored.push({ path: filePath, score, matchedTokens });
        }
      }

      // Group by matched tokens to create coherent entities
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        // Take top 10 to avoid flooding
        const topMatches = scored.slice(0, 10);
        const reference = tokens.join(' ');
        results.push({
          reference,
          resolvedPaths: topMatches.map((m) => m.path),
          resolution: 'fuzzy-path',
          confidence: Math.min(topMatches[0]!.score, 0.95), // Cap below exact match
          confidenceSource: 'evidence-derived',
        });
      }
    }

    // Step 2.5: Prior understanding facts — cross-task transfer (Phase E)
    if (this.worldGraph && tokens.length > 0) {
      const existingPaths = new Set(results.flatMap((e) => e.resolvedPaths));
      for (const token of tokens) {
        try {
          const facts = this.worldGraph.queryFacts(token).filter(
            (f) => f.pattern === 'understanding-verified' && !existingPaths.has(f.sourceFile),
          );
          if (facts.length > 0) {
            const priorPaths = [...new Set(facts.map((f) => f.sourceFile))].slice(0, 5);
            results.push({
              reference: `prior:${token}`,
              resolvedPaths: priorPaths,
              resolution: 'fuzzy-path',
              confidence: Math.min(facts[0]!.confidence * 0.9, 0.85), // Slight discount for cross-task transfer
              confidenceSource: 'evidence-derived',
            });
            for (const p of priorPaths) existingPaths.add(p);
          }
        } catch {
          // WorldGraph query failure is non-fatal
        }
      }
    }

    // Step 3: Symbol search via WorldGraph
    if (understanding.targetSymbol && this.worldGraph) {
      const facts = this.worldGraph.queryFacts(understanding.targetSymbol);
      if (facts.length > 0) {
        const symbolPaths = [...new Set(facts.map((f) => f.sourceFile))];
        results.push({
          reference: understanding.targetSymbol,
          resolvedPaths: symbolPaths,
          resolution: 'fuzzy-symbol',
          confidence: 0.85,
          confidenceSource: 'evidence-derived',
        });
      }
    }

    // Step 4: Dependency inference — expand high-confidence entities
    if (this.worldGraph) {
      const highConfEntities = results.filter((e) => e.confidence >= PERCEPTION_EXPANSION_THRESHOLD);
      for (const entity of highConfEntities) {
        const inferred: string[] = [];
        for (const path of entity.resolvedPaths.slice(0, 3)) {
          // Limit expansion per entity
          try {
            const dependents = this.worldGraph.queryDependents(path, 2);
            inferred.push(...dependents);
          } catch {
            // WorldGraph query failure is non-fatal
          }
        }
        if (inferred.length > 0) {
          const uniqueInferred = [...new Set(inferred)].filter(
            (p) => !results.some((e) => e.resolvedPaths.includes(p)),
          );
          if (uniqueInferred.length > 0) {
            results.push({
              reference: `dependents of ${entity.reference}`,
              resolvedPaths: uniqueInferred.slice(0, 5), // Cap at 5 inferred paths
              resolution: 'dependency-inferred',
              confidence: 0.75,
              confidenceSource: 'evidence-derived',
            });
          }
        }
      }
    }

    return results;
  }

  /** Get cached source file list for the workspace. */
  private getSourceFiles(): string[] {
    const cacheKey = 'source-files';
    let files = this.fileCache.get(cacheKey);
    if (!files) {
      files = walkSourceFiles(this.workspace);
      this.fileCache.set(cacheKey, files);
    }
    return files;
  }
}
