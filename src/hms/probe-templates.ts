/**
 * Probe Templates — deterministic question generation for cross-validation.
 *
 * A3 compliant: templates are static, no LLM involvement in probe generation.
 *
 * Source of truth: HMS plan §H3
 */
import type { ExtractedClaim } from './claim-grounding.ts';

export interface Probe {
  type: 'affirmation' | 'negation' | 'reframe';
  prompt: string;
  claim: ExtractedClaim;
}

/**
 * Generate probing questions for a claim.
 * Pure function — deterministic templates (A3).
 */
export function generateProbes(claim: ExtractedClaim): Probe[] {
  const probes: Probe[] = [];

  switch (claim.type) {
    case 'file_reference': {
      probes.push({
        type: 'affirmation',
        prompt: `Does the file "${claim.value}" exist in this project? Answer yes or no.`,
        claim,
      });
      probes.push({
        type: 'negation',
        prompt: `Is it true that the file "${claim.value}" does NOT exist in this project? Answer yes or no.`,
        claim,
      });
      probes.push({
        type: 'reframe',
        prompt: `List the files in the directory "${claim.value.split('/').slice(0, -1).join('/')}/". Be specific.`,
        claim,
      });
      break;
    }

    case 'import_claim': {
      probes.push({
        type: 'affirmation',
        prompt: `Can the module "${claim.value}" be imported in this project? Answer yes or no.`,
        claim,
      });
      probes.push({
        type: 'negation',
        prompt: `Is it true that "${claim.value}" is NOT a valid import path in this project? Answer yes or no.`,
        claim,
      });
      break;
    }

    case 'fake_tool_call': {
      probes.push({
        type: 'affirmation',
        prompt: `Should code output contain XML-like tool call syntax such as "${claim.value}"? Answer yes or no.`,
        claim,
      });
      break;
    }

    case 'symbol_reference': {
      probes.push({
        type: 'affirmation',
        prompt: `Does the symbol "${claim.value}" exist in the codebase? Answer yes or no.`,
        claim,
      });
      probes.push({
        type: 'negation',
        prompt: `Is it true that "${claim.value}" is NOT defined anywhere in the codebase? Answer yes or no.`,
        claim,
      });
      break;
    }
  }

  return probes;
}
