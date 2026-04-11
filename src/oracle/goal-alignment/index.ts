/**
 * Goal Alignment Oracle — A1 Understanding layer verification.
 *
 * Verifies that LLM output aligns with TaskUnderstanding intent.
 * Rule-based, deterministic (A3-safe), heuristic tier (0.7 cap).
 */
export { verify } from './goal-alignment-verifier.ts';
