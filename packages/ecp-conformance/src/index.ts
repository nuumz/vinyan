/**
 * ECP Conformance Test Suite — validates oracle implementations against the ECP specification.
 *
 * Conformance Levels:
 *   Level 0 — Minimal: raw JSON stdin/stdout, required verdict fields
 *   Level 1 — Standard: JSON-RPC framing, all epistemic types, falsifiability
 *   Level 2 — Full: version negotiation, temporal context, deliberation
 *   Level 3 — Platform: cross-instance, knowledge sharing, signed messages
 *
 * Usage:
 *   import { validateLevel0, validateLevel1, runConformanceSuite } from '@vinyan/ecp-conformance';
 */

export { validateLevel0, type Level0Result } from './level0.ts';
export { validateLevel1, type Level1Result } from './level1.ts';
export { validateLevel2, type Level2Result } from './level2.ts';
export { validateLevel3, validateKnowledgeOffer, validateKnowledgeAcceptance, validateKnowledgeTransfer, type Level3Result } from './level3.ts';
export { runConformanceSuite, type ConformanceResult, type ConformanceLevel } from './suite.ts';
