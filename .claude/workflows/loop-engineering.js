export const meta = {
  name: 'loop-engineering',
  description: 'Expand the ask → plan → harden → implement → review → prove it works, with evidence',
  whenToUse:
    'Any task that should not be called done on the strength of "the code looks right". Takes a raw request (args.task), completes the requirement, plans it, attacks the plan before writing code, implements, reviews the diff adversarially, and refuses to report success without pasted command output. Pass args.task as a string, or {task, constraints, files}.',
  phases: [
    { title: 'Expand', detail: 'two lenses complete the ask into requirements + acceptance criteria' },
    { title: 'Plan', detail: 'two independent plans, judged and synthesised into one' },
    { title: 'Harden', detail: 'pre-mortem: two agents try to make the plan fail before code exists' },
    { title: 'Implement', detail: 'single writer executes the hardened plan' },
    { title: 'Review', detail: 'three lenses over the real diff, findings adjudicated' },
    { title: 'Prove', detail: 'run the Definition-of-Done gates, report pasted output only' },
  ],
}

// ── Repo contract every agent must obey ─────────────────────────────
//
// Kept in one string so a change to the house rules changes every stage at
// once. Agents that run tests are the ones most likely to wedge the terminal,
// so the execution rules are stated as prohibitions, not preferences.
const HOUSE_RULES = `
REPOSITORY: Vinyan — Bun + TypeScript (strict), Biome, SQLite. Read CLAUDE.md first; it is binding.

TERMINAL RULES (violating these hangs the session):
- NEVER run \`bun test\` or \`bun run test*\` with \`2>&1\`, and never pipe them (\`| tee\`, \`| cat\`).
  To capture output, redirect the two streams to SEPARATE files:
  \`bun run test > /tmp/out.log 2> /tmp/err.log; echo "EXIT=$?"\`  — Bun writes the pass/fail summary to stderr.
- Always scope tests to specific files while iterating: \`bun test tests/path/to/file.test.ts\`.
- Full suite only when shared types changed.

DEFINITION OF DONE (from CLAUDE.md — pick the row that matches the task):
- New feature / wiring: \`bun run check\` green + relevant \`bun test tests/<scope>/\` green + wired into a runtime trace
- Bug fix: failing repro test added first, now green + \`bun run check\` green
- Refactor: \`bun run check\` green + affected test dirs green; core-loop/phases/perception → \`bun run test:benchmark\`
- Cross-cutting type change: \`bun run check\` green + \`bun run test:all\` green

NON-NEGOTIABLE AXIOMS (use to settle design conflicts, not as a per-line checklist):
A1 generation != verification · A2 "unknown" is a valid state, never hallucinate · A3 governance is rule-based,
no LLM in the routing/verification/commit path · A4 facts bound to SHA-256 file hash · A5 deterministic >
heuristic > probabilistic evidence · A6 workers propose, orchestrator disposes · A7 learning = delta(predicted, actual).

VOCABULARY: never bare "agent"/"agentId" in new code or user-facing strings. Use persona / worker / cliDelegate / peer.

QUALITY GATES: behaviour tests only — \`toHaveProperty\` alone is forbidden; every test must call a function and
assert on output or a side effect. A feature is "Active" ONLY if it runs in default \`vinyan run\` with no extra config.
`.trim()

const REQUIREMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explicit', 'implicit', 'acceptanceCriteria', 'outOfScope', 'unknowns'],
  properties: {
    explicit: {
      type: 'array',
      description: 'Requirements the request literally states. Quote or paraphrase closely; do not embellish.',
      items: { type: 'string' },
    },
    implicit: {
      type: 'array',
      description:
        'What a careful colleague on this codebase would understand as included even though it was not said — house conventions, tests, wiring, docs that go stale.',
      items: { type: 'string' },
    },
    acceptanceCriteria: {
      type: 'array',
      description:
        'Checkable statements that decide done-ness. Each must name a command, an observable behaviour, or a file state — never a feeling.',
      items: { type: 'string' },
    },
    outOfScope: {
      type: 'array',
      description: 'Things a reader might assume are included that deliberately are NOT. Guards against scope creep.',
      items: { type: 'string' },
    },
    unknowns: {
      type: 'array',
      description:
        'Genuine ambiguities where two readings lead to materially different work. Empty if the request is unambiguous — do not manufacture doubt.',
      items: { type: 'string' },
    },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['approach', 'steps', 'filesTouched', 'risks', 'verification'],
  properties: {
    approach: { type: 'string', description: 'One paragraph: the shape of the solution and why this shape.' },
    steps: {
      type: 'array',
      description: 'Ordered, each independently checkable.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'why', 'check'],
        properties: {
          what: { type: 'string' },
          why: { type: 'string' },
          check: { type: 'string', description: 'How to tell this step actually landed.' },
        },
      },
    },
    filesTouched: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    verification: {
      type: 'array',
      description: 'Exact commands that will prove the work, in run order.',
      items: { type: 'string' },
    },
  },
}

const JUDGED_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'reasoning', 'plan', 'graftedIdeas'],
  properties: {
    winner: { type: 'string', description: 'Which candidate won: "A" or "B".' },
    reasoning: { type: 'string' },
    plan: PLAN_SCHEMA,
    graftedIdeas: {
      type: 'array',
      description: 'Ideas taken from the losing candidate and folded into the winner.',
      items: { type: 'string' },
    },
  },
}

const PREMORTEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['failureModes'],
  properties: {
    failureModes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scenario', 'likelihood', 'mitigation'],
        properties: {
          scenario: {
            type: 'string',
            description: 'Concrete: what input or state makes this plan produce the wrong result.',
          },
          likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
          mitigation: { type: 'string', description: 'A change to the plan, not a note to be careful.' },
        },
      },
    },
  },
}

const IMPLEMENTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'filesChanged', 'deviations', 'selfCheck'],
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviations: {
      type: 'array',
      description: 'Where the plan was not followed, and why. Empty only if it was followed exactly.',
      items: { type: 'string' },
    },
    selfCheck: {
      type: 'string',
      description: 'Commands run during implementation and their PASTED result lines. No claims without output.',
    },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'summary', 'failureScenario', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string' },
          failureScenario: {
            type: 'string',
            description: 'Concrete inputs or state → wrong output. If you cannot write one, it is not a finding.',
          },
          severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] },
        },
      },
    },
  },
}

const ADJUDICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed', 'rejected'],
  properties: {
    confirmed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'summary', 'severity', 'evidence'],
        properties: {
          file: { type: 'string' },
          summary: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] },
          evidence: { type: 'string', description: 'What in the code or in a command result confirms it.' },
        },
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'whyNot'],
        properties: { summary: { type: 'string' }, whyNot: { type: 'string' } },
      },
    },
  },
}

const EVIDENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'gates', 'unmetCriteria'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['proven', 'failed', 'unknown'],
      description:
        '"proven" only when every gate below shows real pasted output that passed. "unknown" when a gate could not be run — that is a valid answer (A2), and is NOT "proven".',
    },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'exitCode', 'output', 'passed'],
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'number' },
          output: { type: 'string', description: 'The actual tail of the run. Never a summary you wrote yourself.' },
          passed: { type: 'boolean' },
        },
      },
    },
    unmetCriteria: {
      type: 'array',
      description: 'Acceptance criteria not demonstrably satisfied. Empty is a claim you must be able to defend.',
      items: { type: 'string' },
    },
  },
}

// ── Input ───────────────────────────────────────────────────────────

const task = typeof args === 'string' ? args : (args?.task ?? '')
if (!task) throw new Error('loop-engineering: pass the request as args.task (string) — nothing to work on.')
const extraConstraints = (typeof args === 'object' && args?.constraints) || ''

const brief = `
TASK AS THE USER STATED IT:
${task}
${extraConstraints ? `\nADDITIONAL CONSTRAINTS:\n${extraConstraints}` : ''}
`.trim()

// ── 1. Expand ───────────────────────────────────────────────────────
// Two lenses rather than one, because the failure mode here is asymmetric:
// a literal reader ships something technically correct and useless, an
// inferring reader ships scope nobody asked for. Running both and keeping
// the disagreement visible is cheaper than picking one and being wrong.

phase('Expand')
log('Completing the request into checkable requirements')

const [literal, colleague] = await parallel([
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n` +
        'You are the LITERAL lens. Read the request as written, nothing more. Explore the repo enough to ' +
        'name the real files and commands involved — but do not invent requirements the user did not state. ' +
        'Your `implicit` list should be short and defensible; anything you cannot trace to a house rule in ' +
        'CLAUDE.md or an existing pattern in the code does not belong there. Put honest ambiguities in ' +
        '`unknowns` and leave it empty if there are none.',
      { label: 'expand:literal', phase: 'Expand', schema: REQUIREMENTS_SCHEMA },
    ),
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n` +
        'You are the COLLEAGUE lens. You have worked on this codebase for a year. Read the request the way a ' +
        'careful teammate would: what does landing this ACTUALLY entail here — tests, wiring into the runtime, ' +
        'docs that go stale, config defaults, callers that break? Ground every item in a file you have opened. ' +
        'Be equally clear about `outOfScope`: name the adjacent work someone might wrongly pull in.',
      { label: 'expand:colleague', phase: 'Expand', schema: REQUIREMENTS_SCHEMA },
    ),
])

const requirements = {
  explicit: dedupe([...(literal?.explicit ?? []), ...(colleague?.explicit ?? [])]),
  implicit: dedupe([...(literal?.implicit ?? []), ...(colleague?.implicit ?? [])]),
  acceptanceCriteria: dedupe([...(literal?.acceptanceCriteria ?? []), ...(colleague?.acceptanceCriteria ?? [])]),
  outOfScope: dedupe([...(literal?.outOfScope ?? []), ...(colleague?.outOfScope ?? [])]),
  unknowns: dedupe([...(literal?.unknowns ?? []), ...(colleague?.unknowns ?? [])]),
}

log(
  `Requirements: ${requirements.explicit.length} explicit, ${requirements.implicit.length} implicit, ` +
    `${requirements.acceptanceCriteria.length} acceptance criteria, ${requirements.unknowns.length} unknowns`,
)

const requirementsBlock = `
REQUIREMENTS (merged from two independent readings):
Explicit:
${bullets(requirements.explicit)}
Implicit (inferred from house rules and existing patterns):
${bullets(requirements.implicit)}
Acceptance criteria — these decide done-ness:
${bullets(requirements.acceptanceCriteria)}
Out of scope — do NOT do these:
${bullets(requirements.outOfScope)}
Open unknowns:
${bullets(requirements.unknowns)}
`.trim()

// ── 2. Plan ─────────────────────────────────────────────────────────
// Two attempts from deliberately different starting points, then a judge.
// One plan iterated is worse than two plans compared: the second angle is
// what exposes the first one's unexamined assumption.

phase('Plan')
log('Two independent plans, then judged')

const [planA, planB] = await parallel([
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n` +
        'Produce a plan that takes the SMALLEST correct change: minimum diff, minimum blast radius, reusing what ' +
        'already exists (CLAUDE.md: "Reuse first — search existing code before creating modules"). Read the ' +
        'actual files before proposing edits to them. Every step needs a check that would fail if the step were skipped.',
      { label: 'plan:minimal', phase: 'Plan', schema: PLAN_SCHEMA },
    ),
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n` +
        'Produce a plan that starts from RISK: what is most likely to be wrong, silently, after this ships? ' +
        'Order the work so the riskiest assumption is tested first and cheaply. Read the actual files. ' +
        'You may propose a larger change than strictly minimal IF you can name the failure it prevents.',
      { label: 'plan:risk-first', phase: 'Plan', schema: PLAN_SCHEMA },
    ),
])

const candidates = [planA, planB].filter(Boolean)
if (candidates.length === 0) throw new Error('loop-engineering: both planners failed — nothing to judge.')

const judged =
  candidates.length === 1
    ? { winner: 'A', reasoning: 'only one candidate survived', plan: candidates[0], graftedIdeas: [] }
    : await agent(
        `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n` +
          `CANDIDATE A (minimal-diff):\n${JSON.stringify(planA, null, 2)}\n\n` +
          `CANDIDATE B (risk-first):\n${JSON.stringify(planB, null, 2)}\n\n` +
          'Judge these against the acceptance criteria and the axioms, not against your taste. Pick the winner, ' +
          'then graft in any step from the loser that covers a real gap — a merged plan that is better than both ' +
          'is the point. Return the FULL merged plan, not a diff against a candidate. Do not write any code.',
        { label: 'plan:judge', phase: 'Plan', schema: JUDGED_PLAN_SCHEMA },
      )

const plan = judged?.plan ?? candidates[0]
log(`Plan: ${plan.steps.length} steps, ${plan.filesTouched.length} files, winner=${judged?.winner ?? 'A'}`)

const planBlock = `PLAN:\n${JSON.stringify(plan, null, 2)}`

// ── 3. Harden ───────────────────────────────────────────────────────
// A pre-mortem is cheaper than a post-mortem. Both agents are told the plan
// has ALREADY failed, which reliably produces sharper failure modes than
// asking "what could go wrong" — the latter invites reassurance.

phase('Harden')
log('Pre-mortem: assuming the plan already failed')

const [premortemA, premortemB] = await parallel([
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${planBlock}\n\n` +
        'This plan was executed and it FAILED — silently, and nobody noticed for a month. Working backwards, ' +
        'explain what broke. Focus on CORRECTNESS: wrong values that still typecheck, seams where two components ' +
        'disagree about a contract, defaults that differ between config and runtime, tests that assert the ' +
        'mistake. Each mitigation must be a concrete change to the plan.',
      { label: 'harden:correctness', phase: 'Harden', schema: PREMORTEM_SCHEMA },
    ),
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${planBlock}\n\n` +
        'This plan was executed and it FAILED. Focus on INTEGRATION and process: callers not updated, a component ' +
        'built but never wired into a runtime trace, a test file that exists but is in no `package.json` script, ' +
        'a DoD gate that cannot actually be run, a change that breaks an earlier phase. Read the code to check ' +
        'each claim before reporting it. Each mitigation must be a concrete change to the plan.',
      { label: 'harden:integration', phase: 'Harden', schema: PREMORTEM_SCHEMA },
    ),
])

const failureModes = [...(premortemA?.failureModes ?? []), ...(premortemB?.failureModes ?? [])].sort(
  (a, b) => rank(a.likelihood) - rank(b.likelihood),
)
log(`Pre-mortem: ${failureModes.length} failure modes (${failureModes.filter((f) => f.likelihood === 'high').length} high)`)

const hardeningBlock =
  failureModes.length === 0
    ? 'PRE-MORTEM: no failure modes found.'
    : `PRE-MORTEM — these are how this plan fails. Each mitigation is now part of the plan:\n${failureModes
        .map((f) => `- [${f.likelihood}] ${f.scenario}\n  MITIGATION: ${f.mitigation}`)
        .join('\n')}`

// ── 4. Implement ────────────────────────────────────────────────────
// Exactly one writer. Parallel implementers would race on the same files,
// and worktree isolation would land the work somewhere the user is not
// looking. Sequential is not a limitation here, it is the requirement.

phase('Implement')
log('Single writer executing the hardened plan')

const implementation = await agent(
  `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${planBlock}\n\n${hardeningBlock}\n\n` +
    'Execute the plan, with every mitigation applied. You are the only writer — no other agent is touching these ' +
    'files. Rules: make the change, run the scoped checks as you go, and fix what you break. Do not commit and do ' +
    'not push; leave the work in the working tree. If a step turns out to be wrong, deviate and record it in ' +
    '`deviations` with the reason — silent deviation is the one unacceptable outcome. In `selfCheck`, paste the ' +
    'ACTUAL output lines of the commands you ran; a claim without output is treated as not run.',
  { label: 'implement', phase: 'Implement', schema: IMPLEMENTATION_SCHEMA },
)

if (!implementation) throw new Error('loop-engineering: implementation agent produced no result.')
log(`Implemented: ${implementation.filesChanged.length} files, ${implementation.deviations.length} deviations`)

// ── 5. Review ───────────────────────────────────────────────────────
// Three lenses over the real diff. Findings then go to a single adjudicator
// rather than being trusted: a reviewer that reports nine plausible bugs and
// one real one has made the real one harder to see.

phase('Review')
log('Three lenses over the diff, then adjudication')

const diffContext =
  'Review the CURRENT WORKING TREE DIFF. Get it yourself with `git diff` and `git status --short` (untracked ' +
  'files are part of the change — read them too). Do not review the plan; review what was actually written.'

const reviews = await parallel([
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${diffContext}\n\n` +
        'Lens: CORRECTNESS. Hunt for defects that survive typechecking — off-by-one, wrong default, inverted ' +
        'condition, unhandled null, a value that is right in the happy path and wrong on the second call. For ' +
        'each finding write concrete inputs → wrong output. If you cannot construct that, do not report it.',
      { label: 'review:correctness', phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${diffContext}\n\n` +
        'Lens: HOUSE RULES AND AXIOMS. Does the diff violate A1/A3 (an LLM in the governance path, a component ' +
        'evaluating its own output), A2 (hallucinating instead of reporting unknown), A6 (a worker granted ' +
        'execution privileges)? Does it use bare "agent"/"agentId" in new code or user-facing strings? Does it ' +
        'contradict a doc comment, a config default, or the parameter registry? Cite the rule you are applying.',
      { label: 'review:axioms', phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
  () =>
    agent(
      `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n${diffContext}\n\n` +
        'Lens: TESTS AND COMPLETENESS. Would the new tests FAIL against the old code? Check by reasoning about ' +
        'what they assert — a test that passes both before and after proves nothing. Flag any `toHaveProperty`-only ' +
        'assertion. Are new test files reachable from a `package.json` script? Is every acceptance criterion above ' +
        'covered by something checkable? Name the criteria that are not.',
      { label: 'review:tests', phase: 'Review', schema: FINDINGS_SCHEMA },
    ),
])

const rawFindings = reviews.filter(Boolean).flatMap((r) => r.findings ?? [])
log(`Review: ${rawFindings.length} raw findings across 3 lenses`)

const adjudicated =
  rawFindings.length === 0
    ? { confirmed: [], rejected: [] }
    : await agent(
        `${HOUSE_RULES}\n\n${brief}\n\n${diffContext}\n\n` +
          `REPORTED FINDINGS:\n${JSON.stringify(rawFindings, null, 2)}\n\n` +
          'Adjudicate. For each finding, go to the code and try to REFUTE it — default to rejecting anything you ' +
          'cannot confirm by reading the actual lines or running a command. Reviewers reporting plausible-sounding ' +
          'defects is the normal failure mode here; your job is to protect the signal. Confirm only what you can ' +
          'point at. Re-grade severity honestly: "blocking" means the change is wrong, not that it could be nicer.',
        { label: 'review:adjudicate', phase: 'Review', schema: ADJUDICATION_SCHEMA },
      )

const confirmed = adjudicated?.confirmed ?? []
const blocking = confirmed.filter((f) => f.severity === 'blocking' || f.severity === 'should-fix')
log(`Adjudicated: ${confirmed.length} confirmed (${blocking.length} actionable), ${adjudicated?.rejected?.length ?? 0} rejected`)

let fixSummary = null
if (blocking.length > 0) {
  fixSummary = await agent(
    `${HOUSE_RULES}\n\n${brief}\n\n${planBlock}\n\n` +
      `CONFIRMED REVIEW FINDINGS TO FIX:\n${JSON.stringify(blocking, null, 2)}\n\n` +
      'Fix exactly these, in the working tree. Do not widen the change, do not refactor around them, do not ' +
      'commit. Re-run the scoped checks for what you touched. Paste real output in `selfCheck`.',
    { label: 'implement:fix', phase: 'Review', schema: IMPLEMENTATION_SCHEMA },
  )
  log(`Applied fixes for ${blocking.length} confirmed findings`)
}

// ── 6. Prove ────────────────────────────────────────────────────────
// The whole loop exists for this stage. An agent that says "tests pass" has
// told us nothing; the schema forces pasted output and allows "unknown" as an
// answer (A2), so a gate that could not be run cannot masquerade as a gate
// that passed.

phase('Prove')
log('Running the Definition-of-Done gates')

const evidence = await agent(
  `${HOUSE_RULES}\n\n${brief}\n\n${requirementsBlock}\n\n` +
    `WHAT WAS IMPLEMENTED:\n${implementation.summary}\n` +
    `Files changed: ${implementation.filesChanged.join(', ')}\n` +
    (fixSummary ? `\nFOLLOW-UP FIXES:\n${fixSummary.summary}\n` : '') +
    `\nPLANNED VERIFICATION COMMANDS:\n${bullets(plan.verification)}\n\n` +
    'Prove this works. Run the Definition-of-Done gates for this task type plus the planned verification ' +
    'commands. Obey the terminal rules exactly — separate stdout and stderr files, never `2>&1`, never a pipe. ' +
    'For every gate record the command, the real exit code, and the PASTED tail of its output. ' +
    'Then check each acceptance criterion against that evidence and list every one you cannot demonstrate. ' +
    'Report `proven` only if every gate really passed. If a gate could not be run, the verdict is `unknown` — ' +
    'that is a valid and expected answer under A2, and it is far better than a confident wrong one. ' +
    'Do not fix anything; you are measuring, not building (A1: the verifier is not the generator).',
  { label: 'prove', phase: 'Prove', schema: EVIDENCE_SCHEMA },
)

const verdict = evidence?.verdict ?? 'unknown'
log(`Verdict: ${verdict} — ${evidence?.gates?.filter((g) => g.passed).length ?? 0}/${evidence?.gates?.length ?? 0} gates passed`)

return {
  verdict,
  requirements,
  plan,
  failureModes,
  implementation,
  review: { confirmed, rejected: adjudicated?.rejected ?? [], fixesApplied: blocking.length },
  evidence,
  // Stated plainly so the caller does not have to infer it from the fields.
  handoff:
    verdict === 'proven'
      ? 'Every gate passed with pasted output. Safe to commit and open a PR.'
      : verdict === 'failed'
        ? 'A gate failed. Read evidence.gates before touching anything else.'
        : 'Not proven. Some gate could not be run — see evidence.unmetCriteria. Do NOT report this as done.',
}

// ── helpers ─────────────────────────────────────────────────────────

function dedupe(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = String(item).trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function bullets(items) {
  return items && items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)'
}

function rank(likelihood) {
  return likelihood === 'high' ? 0 : likelihood === 'medium' ? 1 : 2
}
