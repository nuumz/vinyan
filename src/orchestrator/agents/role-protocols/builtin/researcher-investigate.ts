/**
 * `researcher.investigate` — Phase A2.5 built-in protocol for the
 * researcher persona.
 *
 * Five-step investigation contract that turns a research question into a
 * cited synthesis. Every step's prompt is intentionally narrow — the
 * persona's `soul` carries identity ("investigate before concluding,
 * cite sources, name disagreements"); this protocol carries the
 * *methodology* (what step we're on, what artifact this step produces,
 * what oracle gates progression).
 *
 * Steps:
 *   1. discover         — identify candidate sources for the research question
 *   2. gather           — read each candidate, record content hashes
 *   3. compare-extract  — extract claims from each source, attribute to source
 *   4. synthesize       — combine findings; name disagreements explicitly; cite each load-bearing claim
 *   5. verify-citations — deterministic source-citation oracle gate (A4)
 *
 * A1 honesty notes:
 *
 *   - The deterministic `source-citation` oracle is the verifier
 *     COMPONENT (separate from the LLM that produced the synthesis),
 *     so the persona dispatching the verify step is not the verifier.
 *     Therefore `verify-citations` does NOT declare
 *     `requiresPersonaClass: 'verifier'` — the oracle provides the
 *     A1 separation, not the persona. A researcher persona can solo-walk
 *     the protocol; A1 is satisfied via tooling.
 *
 *   - The earlier draft included a `verify-cross-source` step (lone vs
 *     multi-source claim grading). That step had no oracle and would have
 *     required a verifier persona — pure self-grading by the researcher
 *     would have been an A1 violation. Dropped from A2.5 in favor of a
 *     future `cross-source-confidence` deterministic oracle (post-A4).
 *
 * Exit criteria (AND-ed):
 *   - source-citation oracle passed (no uncited claims, no unknown citations)
 *   - at least 4 steps completed successfully (don't exit before synthesis)
 *
 * A2.5 wiring: this protocol IS registered at orchestrator boot via
 * `registerBuiltinProtocols()` (factory.ts), and the built-in researcher
 * persona declares `roleProtocolId: 'researcher.investigate'`. The
 * `RoleProtocolDriver` is invoked from `phase-generate.ts` at L0/L1 for
 * any persona with this id; per-step dispatch routes through
 * `workerPool.dispatch` with `TaskInput.systemPromptAugmentation`
 * carrying the step's `promptPrepend`. L2+ falls back to legacy
 * single-shot dispatch (A2.6 wires the agent-loop path).
 */

import { registerRoleProtocol } from '../registry.ts';
import { makeRoleProtocolId, type RoleProtocol } from '../types.ts';

export const RESEARCHER_INVESTIGATE_ID = makeRoleProtocolId('researcher.investigate');

export const researcherInvestigate: RoleProtocol = {
  id: RESEARCHER_INVESTIGATE_ID,
  description:
    'Five-step multi-source investigation: discover → gather → extract → synthesize → cite-verify. ' +
    'Source-citation oracle gates progression (A4 content-addressed truth applied to claims). ' +
    'A1 separation is provided by the deterministic oracle, not by a verifier-class persona.',
  steps: [
    {
      id: 'discover',
      kind: 'discover',
      description: 'Identify candidate sources (URLs, papers, docs) for the research question.',
      promptPrepend:
        'Step 1 of 5 — DISCOVER. Identify ≥3 candidate sources for the research question. ' +
        'Output a list of source identifiers (URLs, paper titles, doi: identifiers). ' +
        'Do NOT read or summarize content yet; this step only enumerates candidates.',
    },
    {
      id: 'gather',
      kind: 'gather',
      description:
        'Read each candidate source and record its content hash in evidence.hashes. ' +
        'The hash is the membership token the citation oracle checks against.',
      promptPrepend:
        'Step 2 of 5 — GATHER. For each candidate from the prior step, fetch the content and ' +
        'record (source-id, content-hash) pairs. Populate evidence.hashes with the hash list. ' +
        'Skip a candidate if fetch fails; do NOT fabricate a hash.',
      preconditions: ['discover'],
    },
    {
      id: 'compare-extract',
      kind: 'analyze',
      description:
        'Extract claims from each gathered source, attributing each claim to its source-id. ' +
        'Prefer factual statements over opinion; tag agreements and disagreements explicitly.',
      promptPrepend:
        'Step 3 of 5 — COMPARE-EXTRACT. For each gathered source, extract the load-bearing ' +
        'factual claims and attribute each to its source-id. When two sources disagree, name ' +
        'the disagreement (do NOT silently average). Output one claim per line.',
      preconditions: ['gather'],
      targetFilesFromStep: 'gather',
    },
    {
      id: 'synthesize',
      kind: 'synthesize',
      description:
        'Combine the per-source claim sets into a coherent narrative. Every load-bearing claim ' +
        'in the body must carry an explicit citation token: footnote ref ([^id]) or inline hash ([hash:value]). ' +
        'Output goes into evidence.synthesisText for the verify-citations step.',
      promptPrepend:
        'Step 4 of 5 — SYNTHESIZE. Write a coherent narrative from the extracted claims. ' +
        'Every load-bearing claim MUST carry a citation in the form `[^id]` (with a corresponding ' +
        'footnote definition `[^id]: <source-id-from-gather>`) or `[hash:<gathered-hash>]`. ' +
        'Name disagreements explicitly. Populate evidence.synthesisText with the full body.',
      preconditions: ['compare-extract'],
    },
    {
      id: 'verify-citations',
      kind: 'verify',
      description:
        'Deterministic check: every claim in the synthesis has ≥1 citation, and every citation ' +
        "resolves to a value in the gather step's recorded hash set.",
      promptPrepend:
        'Step 5 of 5 — VERIFY-CITATIONS. Read the synthesis output. Confirm every load-bearing ' +
        "claim cites a source from step 2's gathered set. The source-citation oracle gates this " +
        'step; uncited or dangling-citation claims block progression.',
      preconditions: ['synthesize'],
      // A1 honesty: the deterministic source-citation oracle is the
      // verifier component (separate from the LLM that generated the
      // synthesis). The dispatching persona is not self-evaluating, so
      // requiresPersonaClass is intentionally not set — A1 is satisfied
      // via tooling.
      oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
      // One retry — gives the synthesizer a chance to fix uncited claims
      // when the dispatcher loops the step. retryMax > 1 risks token loops
      // on systematic miswriting.
      retryMax: 1,
    },
  ],
  exitCriteria: [
    { kind: 'oracle-pass', oracleName: 'source-citation' },
    { kind: 'step-count', minSteps: 4 },
  ],
};

/**
 * Idempotently register every Phase A2 built-in protocol. Called by
 * factory.ts at boot. Safe to call multiple times (re-registration
 * overwrites with identical content).
 */
export function registerBuiltinProtocols(): void {
  registerRoleProtocol(researcherInvestigate);
}
