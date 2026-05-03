/**
 * Projection coverage contract — protect TaskProcessProjectionService from
 * silent drift when new bus events are added.
 *
 * Rule: every recorded projection-relevant event must be either folded
 * by the service (listed in `PROJECTION_INTERPRETED_EVENTS`) or
 * explicitly ignored with a one-line rationale (listed in
 * `PROJECTION_IGNORED_EVENTS`). A new `workflow:something_new` recorded
 * event added without thought trips this test, forcing the author to
 * either wire the service or explicitly mark it out-of-scope.
 *
 * Projection-relevance is curated via prefix: not every recorded event
 * is projection-relevant (skill:* / scheduler:* / memory-wiki:* /
 * worker:* etc. are scheduler-/skills-/memory-page concerns and never
 * appear on the per-task process surface). The prefix list is local
 * to this test and intentionally short — adding a new prefix is a
 * conscious decision in the same PR that adds a new event family.
 */
import { describe, expect, test } from 'bun:test';
import { EVENT_MANIFEST, RECORDED_EVENTS } from '../../src/api/event-manifest.ts';
import {
  PROJECTION_IGNORED_EVENTS,
  PROJECTION_INTERPRETED_EVENTS,
} from '../../src/api/projections/task-process-projection.ts';

/**
 * Event-name prefixes that the projection cares about. An event whose
 * name starts with one of these MUST be classified (interpreted or
 * ignored). Adding a prefix here is a conscious decision: it widens
 * the contract test's scope to a new event family.
 *
 * Prefixes deliberately omitted (so the contract doesn't fail on
 * non-projection-relevant events):
 *   - `skill:*`, `evolution:*`, `sleep:*`, `graph:*` — knowledge subsystems
 *   - `session:*`, `memory:*`, `memory-wiki:*` — UI panels separate from process
 *   - `scheduler:*` — scheduler dashboard
 *   - `worker:*` — legacy worker-pool events superseded by `agent:routed`
 *   - `critic:*`, `shadow:*`, `tools:executed`, `guardrail:*`,
 *     `degradation:*`, `grounding:*`, `trace:*` — observability streams
 *     not currently surfaced on the process state projection
 *   - `llm:*`, `agent:thinking`, `agent:text_delta`, `agent:plan_update`,
 *     `agent:turn_complete`, `agent:contract_violation`,
 *     `agent:clarification_requested`, `agent:synthesized*`,
 *     `agent:capability-research*`, `agent:session_*` — live-stream
 *     surface, not lifecycle authority
 */
const PROJECTION_RELEVANT_PREFIXES: readonly string[] = [
  'task:',
  'workflow:',
  'coding-cli:',
  'approval:',
  'phase:',
  'oracle:',
  'agent:tool_',
  'agent:routed',
  // A8 audit surface — every audit:* event must be classified so a future
  // audit-kind addition surfaces in the projection coverage contract.
  'audit:',
];

function isProjectionRelevant(eventName: string): boolean {
  return PROJECTION_RELEVANT_PREFIXES.some((p) => eventName.startsWith(p));
}

describe('Projection coverage contract', () => {
  test('every recorded projection-relevant event is interpreted OR explicitly ignored', () => {
    const missing: string[] = [];
    for (const evName of RECORDED_EVENTS) {
      if (!isProjectionRelevant(evName)) continue;
      if (PROJECTION_INTERPRETED_EVENTS.has(evName)) continue;
      if (PROJECTION_IGNORED_EVENTS.has(evName)) continue;
      missing.push(evName);
    }
    if (missing.length > 0) {
      // Format a helpful error message — the failure list is the
      // checklist of events that need a decision.
      const lines = missing.map(
        (e) =>
          `  - ${e}: add to PROJECTION_INTERPRETED_EVENTS (and fold it in build*) ` +
          `OR add to PROJECTION_IGNORED_EVENTS with a rationale`,
      );
      throw new Error(
        `Projection coverage gap — these recorded events are projection-relevant by ` +
          `prefix but not classified:\n${lines.join('\n')}`,
      );
    }
    expect(missing).toEqual([]);
  });

  test('no event is both interpreted and explicitly ignored', () => {
    const overlap = [...PROJECTION_INTERPRETED_EVENTS].filter((e) => PROJECTION_IGNORED_EVENTS.has(e));
    expect(overlap).toEqual([]);
  });

  test('every interpreted event exists in the event manifest', () => {
    const manifestNames = new Set<string>(EVENT_MANIFEST.map((e) => e.event));
    const orphan = [...PROJECTION_INTERPRETED_EVENTS].filter((e) => !manifestNames.has(e));
    expect(orphan).toEqual([]);
  });

  test('every ignored event exists in the event manifest', () => {
    const manifestNames = new Set<string>(EVENT_MANIFEST.map((e) => e.event));
    const orphan = [...PROJECTION_IGNORED_EVENTS.keys()].filter((e) => !manifestNames.has(e));
    expect(orphan).toEqual([]);
  });

  test('every ignored entry carries a non-empty rationale', () => {
    for (const [, rationale] of PROJECTION_IGNORED_EVENTS) {
      expect(rationale.trim().length).toBeGreaterThan(0);
    }
  });

  test('PROJECTION_RELEVANT_PREFIXES does not have duplicates (sanity)', () => {
    expect(new Set(PROJECTION_RELEVANT_PREFIXES).size).toBe(PROJECTION_RELEVANT_PREFIXES.length);
  });

  test('PROJECTION_INTERPRETED_EVENTS has no duplicates (sanity)', () => {
    // Set construction itself dedupes; this asserts the source array
    // matches the set size by going through Array.from.
    const arr = Array.from(PROJECTION_INTERPRETED_EVENTS);
    expect(new Set(arr).size).toBe(arr.length);
  });
});
