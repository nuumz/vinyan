/**
 * `researcher.investigate` — Phase A2 built-in protocol for the
 * researcher persona.
 *
 * Six-step investigation contract that turns a research question into a
 * cited, multi-source synthesis. Every step's prompt is intentionally
 * narrow — the persona's `soul` carries identity ("investigate before
 * concluding, cite sources, name disagreements"); this protocol carries
 * the *methodology* (what step we're on, what artifact this step
 * produces, what oracle gates progression).
 *
 * Steps:
 *   1. discover         — identify candidate sources for the research question
 *   2. gather           — read each candidate, record content hashes
 *   3. compare-extract  — extract claims from each source, attribute to source
 *   4. synthesize       — combine findings; name disagreements explicitly; cite each load-bearing claim
 *   5. verify-citations — every claim has ≥1 citation pointing into the gathered set (deterministic, A4)
 *   6. verify-cross-source — flag lone-source claims; mark multi-source claims higher-confidence
 *
 * A1 honesty: steps 5 and 6 declare `requiresPersonaClass: 'verifier'`
 * so a researcher (Generator class) cannot single-handedly walk the
 * full protocol. The dispatcher (caller of `RoleProtocolDriver.run`)
 * must hand verify steps off to a reviewer-class persona, OR the run
 * uses a Mixed-class persona (`assistant`, `coordinator`) that can
 * fulfil both sides.
 *
 * Exit criteria (AND-ed):
 *   - source-citation oracle passed (no uncited claims, no unknown citations)
 *   - at least 4 steps completed successfully (don't exit before synthesis)
 *
 * Note for A2: this protocol is registered (via `registerBuiltinProtocols()`
 * below) but no built-in persona declares `roleProtocolId:
 * 'researcher.investigate'` yet. Production routing (phase-generate
 * driving per-step dispatch) lands in A2.5 once the prompt-injection
 * design for `WorkerContract.systemPromptPrepend` settles. Until then,
 * the protocol is exercised by the integration test against a stubbed
 * dispatcher — proving the recipe + oracle work end-to-end without
 * touching production paths.
 */

import { registerRoleProtocol } from '../registry.ts';
import { makeRoleProtocolId, type RoleProtocol } from '../types.ts';

export const RESEARCHER_INVESTIGATE_ID = makeRoleProtocolId('researcher.investigate');

export const researcherInvestigate: RoleProtocol = {
  id: RESEARCHER_INVESTIGATE_ID,
  description:
    'Six-step multi-source investigation: discover → gather → extract → synthesize → cite-verify → cross-source-verify. ' +
    'Source-citation oracle gates progression (A4 content-addressed truth applied to claims).',
  steps: [
    {
      id: 'discover',
      kind: 'discover',
      description: 'Identify candidate sources (URLs, papers, docs) for the research question.',
      promptPrepend:
        'Step 1 of 6 — DISCOVER. Identify ≥3 candidate sources for the research question. ' +
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
        'Step 2 of 6 — GATHER. For each candidate from the prior step, fetch the content and ' +
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
        'Step 3 of 6 — COMPARE-EXTRACT. For each gathered source, extract the load-bearing ' +
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
        'Step 4 of 6 — SYNTHESIZE. Write a coherent narrative from the extracted claims. ' +
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
        'Step 5 of 6 — VERIFY-CITATIONS. Read the synthesis output. Confirm every load-bearing ' +
        "claim cites a source from step 2's gathered set. The source-citation oracle gates this " +
        'step; uncited or dangling-citation claims block progression.',
      preconditions: ['synthesize'],
      requiresPersonaClass: 'verifier',
      oracleHooks: [{ oracleName: 'source-citation', blocking: true }],
      // One retry — gives the synthesizer a chance to fix uncited claims when the
      // dispatcher loops the step. retryMax > 1 risks loops on systematic miswriting.
      retryMax: 1,
    },
    {
      id: 'verify-cross-source',
      kind: 'verify',
      description:
        'Annotate each claim with how many distinct sources back it. Flag lone-source claims as ' +
        'lower-confidence; mark claims with ≥2 sources as higher-confidence. Does NOT block — this ' +
        'step grades, not gates.',
      promptPrepend:
        'Step 6 of 6 — VERIFY-CROSS-SOURCE. For each claim, count distinct backing sources from ' +
        'the gathered set. Tag (lone-source) or (multi-source) per claim. Surface lone-source ' +
        'claims to the user — they are the weakest part of the synthesis.',
      preconditions: ['verify-citations'],
      requiresPersonaClass: 'verifier',
      // No oracle: this step grades; it does not gate.
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
