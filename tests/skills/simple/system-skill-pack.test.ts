/**
 * Smoke tests for the bundled system-skill pack at `templates/skills/`.
 *
 * Two things this file locks in:
 *
 *   1. Content invariants — names match `SYSTEM_SKILL_NAMES`, files parse via
 *      the simple-skill loader, descriptions stay under the matcher cap, and
 *      no SKILL.md leaks language- or framework-specific terminology into the
 *      default pack.
 *   2. Matcher behaviour — representative goals from across the persona
 *      surface produce sensible top-1 selections (a goal about "review" hits
 *      `reviewer-brief`, "plan" hits `planning-contract`, "failed" hits
 *      `recovery-replan`, etc.).
 *
 * The point is to catch regressions where someone adds a skill that drifts
 * back into domain territory or breaks the matcher's keyword density.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { locateBundledSkillsDir, RETIRED_STARTER_NAMES, SYSTEM_SKILL_NAMES } from '../../../src/cli/skills-simple.ts';
import { DESCRIPTION_CHAR_CAP, parseFrontmatter } from '../../../src/skills/simple/loader.ts';
import { matchSkillsForTask } from '../../../src/skills/simple/matcher.ts';

const TEMPLATES_DIR = locateBundledSkillsDir('skills');

function loadBundledSkill(name: string): { description: string; body: string; raw: string } {
  if (!TEMPLATES_DIR) throw new Error('templates/skills/ not located');
  const path = join(TEMPLATES_DIR, name, 'SKILL.md');
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error(`malformed frontmatter in ${path}`);
  return { description: parsed.frontmatter.description ?? '', body: parsed.body, raw };
}

describe('bundled system-skill pack — content invariants', () => {
  test('templates/skills/ directory is locatable next to source', () => {
    expect(TEMPLATES_DIR).not.toBeNull();
    expect(existsSync(TEMPLATES_DIR!)).toBe(true);
  });

  test('exactly the 14 SYSTEM_SKILL_NAMES are present on disk', () => {
    if (!TEMPLATES_DIR) throw new Error('templates dir missing');
    const onDisk = readdirSync(TEMPLATES_DIR)
      .filter((entry) => statSync(join(TEMPLATES_DIR, entry)).isDirectory())
      .sort();
    const expected = [...SYSTEM_SKILL_NAMES].sort();
    expect(onDisk).toEqual(expected);
  });

  test('no retired starter directory remains under templates/skills/', () => {
    if (!TEMPLATES_DIR) throw new Error('templates dir missing');
    for (const name of RETIRED_STARTER_NAMES) {
      expect(existsSync(join(TEMPLATES_DIR, name))).toBe(false);
    }
  });

  test('every system skill parses cleanly via the simple-skill loader', () => {
    for (const name of SYSTEM_SKILL_NAMES) {
      const { description, body } = loadBundledSkill(name);
      expect(description.length).toBeGreaterThan(20); // non-trivial description
      expect(body.length).toBeGreaterThan(80); // non-trivial body
    }
  });

  test('every description fits under the loader description cap', () => {
    for (const name of SYSTEM_SKILL_NAMES) {
      const { description } = loadBundledSkill(name);
      expect(description.length).toBeLessThanOrEqual(DESCRIPTION_CHAR_CAP);
    }
  });

  test('no SKILL.md leaks language- or framework-specific terminology', () => {
    // System skills must remain broad. Words like "TypeScript", "Python",
    // etc. signal a domain skill that does not belong in the default pack —
    // those go in templates/examples/skills/ instead.
    //
    // The list is deliberately limited to compound or unambiguous tech terms;
    // single English words (react, bun, java, rust, vue, flask) collide with
    // ordinary prose and would generate false positives.
    const forbidden = [
      /\btypescript\b/i,
      /\bjavascript\b/i,
      /\bpython\b/i,
      /\bgolang\b/i,
      /\bnext\.?js\b/i,
      /\bnode\.?js\b/i,
      /\bnpm\b/i,
      /\bdjango\b/i,
      /\bsqlite\b/i,
      /\bpostgres\b/i,
    ];
    for (const name of SYSTEM_SKILL_NAMES) {
      const { raw } = loadBundledSkill(name);
      for (const re of forbidden) {
        expect(re.test(raw)).toBe(false);
      }
    }
  });
});

describe('bundled system-skill pack — matcher selection', () => {
  if (!TEMPLATES_DIR) {
    test.skip('templates/skills/ not located — skipping matcher tests', () => {});
    return;
  }

  // Materialise the bundled pack as SimpleSkill records once for every test.
  const pool = SYSTEM_SKILL_NAMES.map((name) => {
    const { description, body } = loadBundledSkill(name);
    return {
      name,
      description,
      body,
      scope: 'user' as const,
      path: join(TEMPLATES_DIR!, name, 'SKILL.md'),
    };
  });

  // Representative goals across the persona surface; each goal should put the
  // expected skill in the top result. We use top-1 (not just "in top-3") so
  // descriptions have to actually carry their weight.
  //
  // The matcher (Jaccard on lowercase tokens) does NOT stem — "decide" and
  // "deciding" are different tokens. Goals here intentionally use the same
  // word forms that appear in each skill's description; this is the contract
  // the matcher exposes to its inputs, and goals that rely on stemming would
  // be testing a behaviour the matcher does not promise.
  const expectations: ReadonlyArray<{ goal: string; expectTop: string }> = [
    { goal: 'classify the intent of this request and decide whether to clarify route or answer', expectTop: 'workflow-intake' },
    { goal: 'break this complex task into ordered subgoals with dependencies', expectTop: 'task-decomposition' },
    { goal: 'who should handle this — which persona should I dispatch to?', expectTop: 'persona-dispatch' },
    { goal: 'do we have the capability and skills required for this workflow?', expectTop: 'capability-mapping' },
    { goal: 'investigate the source of truth and gather evidence before acting', expectTop: 'evidence-gathering' },
    { goal: 'produce a plan with objective, assumptions, affected surfaces, verification', expectTop: 'planning-contract' },
    { goal: 'decide the verification tier for this change', expectTop: 'verification-strategy' },
    { goal: 'frame review output by severity and end with a verdict', expectTop: 'reviewer-brief' },
    { goal: 'recover from failed tool calls — diagnose choose alternate path avoid retry loops', expectTop: 'recovery-replan' },
    { goal: 'shape the final output to match the user intent and artifact', expectTop: 'output-contract' },
    { goal: 'decide whether a task produced reusable knowledge worth recording in memory', expectTop: 'learning-capture' },
    { goal: 'enforce governance guardrails — generator verifier separation, deterministic routing', expectTop: 'governance-guardrails' },
    { goal: 'choose budget and scope proportional to the risk of this change', expectTop: 'budget-and-scope' },
    { goal: 'coordinate multi-persona collaboration with a shared blackboard and synthesis', expectTop: 'collaboration-room' },
  ];

  for (const { goal, expectTop } of expectations) {
    test(`'${goal.slice(0, 60)}…' → top match is ${expectTop}`, () => {
      const matches = matchSkillsForTask(goal, pool, { topK: 3 });
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0]?.skill.name).toBe(expectTop);
    });
  }

  test('a generic "help" with no system-skill keyword does not falsely match anything strong', () => {
    const matches = matchSkillsForTask('hello there', pool);
    // Either zero matches (below threshold) or low scores. Just assert no
    // single skill scores a runaway 1.0 — that would mean the description is
    // catching universal stopwords.
    for (const m of matches) {
      expect(m.score).toBeLessThan(0.5);
    }
  });

  test('eager [AVAILABLE SKILLS] section size stays under 4 KB with all 14 loaded', () => {
    // The prompt-section assembler renders one bullet per loaded skill. Bound
    // the descriptions cumulatively so a future contributor cannot bloat the
    // eager section by writing a 1 KB description.
    const bulletSize = pool.reduce(
      (acc, s) => acc + `- ${s.name}: ${s.description}\n`.length,
      0,
    );
    expect(bulletSize).toBeLessThan(4096);
  });
});
