/**
 * Perceive Phase — Step 1 of the Orchestrator lifecycle.
 *
 * Assembles perception, enriches understanding with framework context,
 * runs STU Layer 2 semantic understanding, verifies understanding claims,
 * and persists verified claims to WorldGraph.
 */

import { resolve as resolvePath } from 'node:path';
import type { RoutingDecision, SemanticTaskUnderstanding } from '../types.ts';
import { buildLightweightIntent } from '../understanding/lightweight-intent.ts';
import type { PhaseContext, PerceiveResult, PhaseContinue } from './types.ts';
import { Phase } from './types.ts';

export async function executePerceivePhase(
  ctx: PhaseContext,
  routing: RoutingDecision,
  understanding: SemanticTaskUnderstanding,
  totalTokensConsumed: number,
): Promise<PhaseContinue<PerceiveResult>> {
  const { input, deps } = ctx;

  // ── Step 1: PERCEIVE ──────────────────────────────────────────
  // STU Gap Fix: Inject resolved file paths into input when targetFiles is empty.
  // Enables reasoning tasks like "Explain src/foo.ts" to receive file content
  // even without explicit --file flag, using STU Layer 1 entity resolution.
  let effectiveInput = input;
  if ((!input.targetFiles || input.targetFiles.length === 0) && understanding.resolvedEntities?.length > 0) {
    const resolvedPaths = understanding.resolvedEntities.flatMap((e) => e.resolvedPaths).filter((p) => p.length > 0);
    if (resolvedPaths.length > 0) {
      effectiveInput = { ...input, targetFiles: resolvedPaths };
    }
  }
  const perception = await deps.perception.assemble(effectiveInput, routing.level, understanding);

  // Gap 9A: Enrich understanding with perception-derived framework context
  const { enrichWithPerception } = await import('../understanding/task-understanding.ts');
  if (perception.frameworkMarkers?.length) {
    understanding = enrichWithPerception(understanding, perception.frameworkMarkers) as typeof understanding;
  }

  // ── STU Layer 2: Semantic Understanding (post-routing, budget-gated, L2+ only) ──
  if (deps.understandingEngine && routing.level >= 2) {
    const { enrichUnderstandingL2 } = await import('../understanding/task-understanding.ts');
    const l2Start = Date.now();
    understanding = await enrichUnderstandingL2(understanding, {
      understandingEngine: deps.understandingEngine,
      workspace: deps.workspace ?? '.',
    }, { remainingTokens: input.budget.maxTokens - totalTokensConsumed });
    deps.bus?.emit('understanding:layer2_complete', {
      taskId: input.id,
      durationMs: Date.now() - l2Start,
      hasIntent: understanding.semanticIntent != null,
      depth: understanding.understandingDepth,
    });
  } else if (!understanding.semanticIntent) {
    // ── Lightweight L0-L1 success criteria (rule-based, zero tokens) ──
    // Without this, L0-L1 workers get no goal clarity — just the raw goal text.
    // Generates basic semanticIntent from Layer 0+1 metadata (actionVerb, constraints, entities).
    understanding = {
      ...understanding,
      semanticIntent: buildLightweightIntent(understanding, input),
    };
  }

  // ── STU Phase C: Understanding Verification (A1: separate from generation) ──
  if (deps.worldGraph && understanding.understandingDepth >= 1) {
    const { verifyUnderstandingClaims } = await import('../understanding/understanding-verifier.ts');
    const verifyStart = Date.now();
    const verifiedClaims = verifyUnderstandingClaims(understanding, deps.worldGraph, deps.workspace ?? '.');
    understanding = { ...understanding, verifiedClaims: [...understanding.verifiedClaims, ...verifiedClaims] };
    deps.bus?.emit('understanding:claims_verified', {
      taskId: input.id,
      durationMs: Date.now() - verifyStart,
      totalClaims: verifiedClaims.length,
      knownClaims: verifiedClaims.filter((c) => c.type === 'known').length,
      contradictoryClaims: verifiedClaims.filter((c) => c.type === 'contradictory').length,
    });
  }

  // ── STU Phase E: Persist verified understanding claims as WorldGraph facts (A4) ──
  if (deps.worldGraph && understanding.verifiedClaims.length > 0) {
    try {
      const workspace = deps.workspace ?? '.';
      const knownClaims = understanding.verifiedClaims.filter((c) => c.type === 'known' && c.evidence.length > 0);
      for (const claim of knownClaims) {
        const sourceFile = claim.evidence[0]!.file;
        if (sourceFile === 'goal') continue;
        const absPath = resolvePath(workspace, sourceFile);
        let fileHash: string;
        try {
          fileHash = deps.worldGraph.computeFileHash(absPath);
        } catch {
          continue;
        }
        deps.worldGraph.storeFact({
          target: sourceFile,
          pattern: 'understanding-verified',
          evidence: claim.evidence.map((e) => ({ file: e.file, line: e.line ?? 0, snippet: e.snippet ?? '' })),
          oracleName: claim.verifiedBy ?? 'understanding-verifier',
          sourceFile,
          fileHash,
          verifiedAt: Date.now(),
          sessionId: input.id,
          confidence: claim.confidence,
          decayModel: 'linear',
          tierReliability: claim.tierReliability,
        });
      }
    } catch {
      // WorldGraph fact storage is best-effort
    }
  }

  return Phase.continue({ perception, understanding });
}
