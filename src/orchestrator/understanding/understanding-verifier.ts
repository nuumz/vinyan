/**
 * Understanding Verifier — cross-checks understanding claims against deterministic evidence.
 *
 * A1: Layer 2 generates claims. This verifier evaluates them using different tools
 * (file system, WorldGraph). No component evaluates its own output.
 *
 * All verification is deterministic (A3-safe). Zero LLM cost.
 *
 * Source of truth: docs/design/semantic-task-understanding-system-design.md §5.4
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type { SemanticTaskUnderstanding, VerifiedClaim } from '../types.ts';

// ── Path-like tokens for scope contradiction detection ──────────────────

/** Common directory-like tokens that indicate scope claims. */
const SCOPE_TOKEN_PATTERN = /\b([a-z][\w-]*(?:\/[a-z][\w-]*)*)\b/g;
const MIN_SCOPE_TOKEN_LENGTH = 3;
const IGNORED_SCOPE_TOKENS = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'service', 'module',
  'component', 'function', 'class', 'file', 'code', 'logic', 'system',
  'handling', 'management', 'layer', 'timeout', 'error', 'bug', 'fix',
]);

/**
 * Extract directory-like tokens from a scope string.
 * Returns tokens that look like they reference codebase paths (e.g., "auth", "payment/gateway").
 */
function extractScopeTokens(scope: string): string[] {
  const tokens: string[] = [];
  for (const match of scope.toLowerCase().matchAll(SCOPE_TOKEN_PATTERN)) {
    const token = match[1]!;
    if (token.length >= MIN_SCOPE_TOKEN_LENGTH && !IGNORED_SCOPE_TOKENS.has(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

// ── Main verifier ───────────────────────────────────────────────────────

/**
 * Verify understanding claims against deterministic evidence.
 * Returns VerifiedClaim[] — each claim carries its own confidence source and tier.
 *
 * Three verification paths:
 * 1. Entity file existence (fs)
 * 2. Symbol claims (WorldGraph)
 * 3. Scope-entity contradiction (structural)
 */
export function verifyUnderstandingClaims(
  understanding: SemanticTaskUnderstanding,
  worldGraph: WorldGraph,
  workspace: string,
): VerifiedClaim[] {
  const claims: VerifiedClaim[] = [];

  // ── 1. Verify resolved entity paths exist on filesystem ──────────
  for (const entity of understanding.resolvedEntities) {
    for (const path of entity.resolvedPaths) {
      const exists = existsSync(join(workspace, path));
      claims.push({
        claim: `File ${path} exists (referenced as "${entity.reference}")`,
        type: exists ? 'known' : 'contradictory',
        confidence: exists ? 0.99 : 0.01,
        verifiedBy: 'fs',
        confidenceSource: 'evidence-derived',
        tierReliability: 1.0,
        falsifiableBy: ['file-deleted', 'file-renamed'],
        evidence: [{ file: path }],
      });
    }
  }

  // ── 2. Verify symbol claims via WorldGraph facts ─────────────────
  if (understanding.targetSymbol) {
    const facts = worldGraph.queryFacts(understanding.targetSymbol);
    const verified = facts.length > 0;
    claims.push({
      claim: `Symbol ${understanding.targetSymbol} exists in codebase`,
      type: verified ? 'known' : 'unknown',
      confidence: verified ? facts[0]!.confidence : 0.3,
      verifiedBy: verified ? facts[0]!.oracleName : undefined,
      confidenceSource: 'evidence-derived',
      tierReliability: verified ? 0.95 : 0.5,
      falsifiableBy: ['symbol-renamed', 'file-modified'],
      evidence: verified
        ? facts.map((f) => ({ file: f.sourceFile, snippet: f.pattern }))
        : [{ file: 'goal', snippet: understanding.rawGoal }],
    });
  }

  // ── 3. Scope-entity contradiction (Layer 2 vs Layer 1) ──────────
  if (understanding.semanticIntent) {
    const scopeTokens = extractScopeTokens(understanding.semanticIntent.scope);
    for (const token of scopeTokens) {
      // Bidirectional: path contains token OR token contains a path segment.
      // Handles "authentication" scope ↔ "auth/" path segment.
      const hasMatchingEntity = understanding.resolvedEntities.some((e) =>
        e.resolvedPaths.some((p) => {
          const lower = p.toLowerCase();
          if (lower.includes(token)) return true;
          // Check if token contains any path directory segment
          return lower.split('/').some((seg) => seg.length >= MIN_SCOPE_TOKEN_LENGTH && token.includes(seg));
        }),
      );
      if (!hasMatchingEntity && understanding.resolvedEntities.length > 0) {
        claims.push({
          claim: `Semantic scope "${understanding.semanticIntent.scope}" references "${token}" but no resolved entities match`,
          type: 'contradictory',
          confidence: 0.7,
          confidenceSource: 'evidence-derived',
          tierReliability: 0.8,
          falsifiableBy: ['entity-resolution-expanded'],
          evidence: [{ file: 'goal', snippet: understanding.semanticIntent.scope }],
        });
      }
    }
  }

  return claims;
}
