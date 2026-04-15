/**
 * Post-merge gap close (2026-04-15): Phase A §7 seam #3 — peek
 * event whitelist drift regression test.
 *
 * Problem the test guards:
 *   `src/tui/views/peek.ts::TASK_EVENTS` is a hand-maintained list of
 *   bus event names whose payloads carry a `taskId` field. If a new
 *   task-bearing event is added to `src/core/bus.ts` but not to
 *   `TASK_EVENTS`, `vinyan tui peek <task-id>` silently drops it.
 *
 *   This test statically scans `bus.ts` for event declarations whose
 *   payload type contains `taskId:` and asserts each one is either
 *   in `TASK_EVENTS` or in a documented allowlist of deliberate
 *   exclusions (aggregate-level events like `market:*` that don't
 *   make sense to surface in a single-task peek view).
 *
 *   When CI fails with "new task-bearing event XYZ is not in
 *   TASK_EVENTS", the fix is either:
 *     1. Add the event to peek's TASK_EVENTS list + add a summarizer
 *        case, OR
 *     2. Add the event to `KNOWN_EXCLUSIONS` below with a comment
 *        explaining why it's deliberately not in peek.
 *
 *   Either action forces an explicit decision, eliminating the
 *   silent-drift footgun that Phase A §7 seam #3 warned about.
 *
 * Why a static text scan, not a runtime type check:
 *   Bus event types are TypeScript types — they don't exist at
 *   runtime. A proper type-level registry would require a wide
 *   refactor of every bus event declaration (see Phase B §6 item #6).
 *   Scanning the source text is a 30-LOC regex that achieves the
 *   same correctness guarantee in CI without the refactor cost.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Events that legitimately carry `taskId` but are deliberately NOT in
 * peek's whitelist. Each entry MUST have a reason comment.
 *
 * Rules of thumb for excluding an event:
 *   - Aggregate-level: the event is computed over a window of tasks,
 *     not a single task invocation (e.g. economy/market auctions that
 *     pick a winner FROM a pool).
 *   - Low operator value: the event is internal telemetry that
 *     dashboards consume but operators debugging one task wouldn't
 *     care about.
 *   - Dispatch-noise: the event fires too frequently to be useful in
 *     a per-task stream.
 */
const KNOWN_EXCLUSIONS = new Set<string>([
  // Skill Formation events — task id is for trace linkage, but the
  // operator cares about skill reuse across tasks, not per-task matches.
  'skill:match',
  'skill:miss',
  'skill:outcome',
  // Evolution rule engine — task id is for provenance, but rule
  // promotion/retirement is a fleet-level signal, not per-task.
  'evolution:rulesApplied',
  // Economy OS layer — cost/budget events are aggregate, not per-task.
  'economy:cost_recorded',
  'economy:budget_warning',
  'economy:budget_exceeded',
  'economy:budget_degraded',
  'economy:rate_card_miss',
  'economy:cost_predicted',
  'economy:budget_allocated',
  'economy:cost_pattern_found',
  'economy:cost_pattern_detected',
  'economy:federation_cost_received',
  'economy:federation_cost_broadcast',
  // Market / auction events — auction-level, not per-task.
  'market:auction_started',
  'market:auction_completed',
  'market:fallback_to_selector',
  'market:settlement_accurate',
  'market:settlement_inaccurate',
  'market:auto_activated',
  // HMS (Hallucination Mitigation System) — aggregate telemetry.
  'hms:grounding_result',
  'hms:overconfidence_detected',
  'hms:risk_scored',
  'hms:cross_validation_complete',
  // Human-review events — API-level, not per-task-stream.
  'human:review_requested',
  'human:review_completed',
  // Instance coordinator — cross-instance events, not per-task stream.
  'instance:eventForwarded',
  'instance:conflictResolved',
  // Engine selection — per-task but too frequent to stream usefully.
  'engine:selected',
  // Fleet routing — cross-instance routing, not per-task.
  'fleet:taskRouted',
  // Tool remediation — fires on tool errors; task:uncertain is the
  // higher-level equivalent that peek already surfaces.
  'tool:failure_classified',
  'tool:remediation_attempted',
  'tool:remediation_succeeded',
  'tool:remediation_failed',
  // Pipeline confidence decision — internal routing signal.
  'pipeline:re-verify',
  'pipeline:escalate',
  'pipeline:refuse',
  // Warm pool events — dispatch-noise, not useful per-task.
  'warmpool:hit',
  'warmpool:miss',
  'warmpool:timeout',
  // Worker exploration — internal epsilon-greedy optimization signal,
  // not operator-facing.
  'worker:exploration',
  // Intent resolver — pre-routing classification, rarely interesting
  // to tail per-task.
  'intent:resolved',
  // STU (Semantic Task Understanding) — internal pipeline stages.
  'understanding:layer0_complete',
  'understanding:layer1_complete',
  'understanding:layer2_complete',
  'understanding:claims_verified',
  'understanding:calibration',
  // Extensible Thinking — internal policy events.
  'thinking:policy-compiled',
  'thinking:counterfactual-retry',
  'thinking:escalation-path-chosen',
  'thinking:policy-evaluated',
  // Trace record — high-volume, redundant with task:complete.
  'trace:record',
  // Self-model — internal calibration.
  'selfmodel:calibration_error',
  'selfmodel:systematic_miscalibration',
  // Testgen — internal verifier step.
  'testgen:error',
  // Security injection — pre-task guardrail, fires before task really starts.
  'security:injection_detected',
  // Tools executed — redundant with agent:tool_executed for agentic path.
  'tools:executed',
  // Observability alerts — aggregate, not per-task.
  'observability:alert',
  'context:verdict_omitted',
  'memory:eviction_warning',
  // Tool approval prompt — UI-level, not streaming.
  'tool:approval_required',
]);

/**
 * Parse `src/core/bus.ts` and return the set of event names whose
 * payload type declaration contains a `taskId:` field. The regex is
 * intentionally simple: it looks for an event-name literal followed
 * by a payload block containing `taskId:` on a later line.
 */
function extractTaskBearingEventNames(busSource: string): Set<string> {
  const result = new Set<string>();
  // Event declarations are keys in the VinyanBusEvents interface.
  // Single-line form: `'event:name': { taskId: string; ... }`
  // Multi-line form:  `'event:name': {\n    taskId: string;\n    ... }`
  //
  // Split on event-name markers, then check if the following block
  // (up to the next event-name marker or closing brace) contains
  // `taskId:`.
  const lines = busSource.split('\n');
  let inInterface = false;
  let currentEvent: string | null = null;
  let currentBlockLines: string[] = [];
  let braceDepth = 0;

  for (const line of lines) {
    if (line.includes('export interface VinyanBusEvents')) {
      inInterface = true;
      continue;
    }
    if (!inInterface) continue;
    // End of interface
    if (line.match(/^\}/) && braceDepth === 0) {
      // Flush last event
      if (currentEvent && currentBlockLines.some((l) => /\btaskId\s*:/.test(l))) {
        result.add(currentEvent);
      }
      break;
    }

    const eventMatch = line.match(/^\s{2}'([^']+)'\s*:/);
    if (eventMatch && braceDepth === 0) {
      // Flush previous event
      if (currentEvent && currentBlockLines.some((l) => /\btaskId\s*:/.test(l))) {
        result.add(currentEvent);
      }
      currentEvent = eventMatch[1]!;
      currentBlockLines = [line];
      // Track brace depth for multi-line payloads
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      continue;
    }
    // Continuation line of the current payload
    if (currentEvent) {
      currentBlockLines.push(line);
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
    }
  }
  return result;
}

function readPeekWhitelist(): Set<string> {
  const source = readFileSync(join(REPO_ROOT, 'src/tui/views/peek.ts'), 'utf-8');
  const result = new Set<string>();
  // Match entries inside the TASK_EVENTS array: `  'event:name',`
  const arrayMatch = source.match(/const TASK_EVENTS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!arrayMatch) throw new Error('Could not locate TASK_EVENTS array in peek.ts');
  const body = arrayMatch[1]!;
  // Strip line-comments (// ...) so we don't match event-like tokens
  // appearing inside documentation inside the array body.
  const stripped = body.replace(/\/\/[^\n]*/g, '');
  for (const m of stripped.matchAll(/'([^']+)'/g)) {
    const name = m[1]!;
    // Defensive: only accept strings that look like `namespace:event`
    if (/^[a-z][a-z0-9-]*:[a-z_][a-z0-9_-]*$/i.test(name)) {
      result.add(name);
    }
  }
  return result;
}

describe('peek TASK_EVENTS whitelist coverage (Phase A §7 seam #3)', () => {
  test('every task-bearing bus event is either whitelisted or explicitly excluded', () => {
    const busSource = readFileSync(join(REPO_ROOT, 'src/core/bus.ts'), 'utf-8');
    const taskBearing = extractTaskBearingEventNames(busSource);
    const whitelist = readPeekWhitelist();

    // Every task-bearing event must be in the whitelist OR explicitly
    // excluded in the KNOWN_EXCLUSIONS set above.
    const missing: string[] = [];
    for (const eventName of taskBearing) {
      if (whitelist.has(eventName)) continue;
      if (KNOWN_EXCLUSIONS.has(eventName)) continue;
      missing.push(eventName);
    }

    if (missing.length > 0) {
      const msg = [
        `Found ${missing.length} task-bearing bus event(s) that are NOT in peek's TASK_EVENTS`,
        `and NOT in KNOWN_EXCLUSIONS:`,
        '',
        ...missing.map((e) => `  - ${e}`),
        '',
        'To fix: add each event to src/tui/views/peek.ts::TASK_EVENTS with a',
        'summarizer case, OR add it to KNOWN_EXCLUSIONS in this test file',
        'with a comment explaining why it should not surface in peek.',
      ].join('\n');
      throw new Error(msg);
    }

    expect(missing).toEqual([]);
  });

  test('every event in TASK_EVENTS actually exists in bus.ts (no stale entries)', () => {
    const busSource = readFileSync(join(REPO_ROOT, 'src/core/bus.ts'), 'utf-8');
    const whitelist = readPeekWhitelist();

    const stale: string[] = [];
    for (const eventName of whitelist) {
      // The event must appear as a key in VinyanBusEvents
      const regex = new RegExp(`'${eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:`);
      if (!regex.test(busSource)) {
        stale.push(eventName);
      }
    }

    if (stale.length > 0) {
      const msg = [
        `Found ${stale.length} whitelisted event(s) that no longer exist in bus.ts:`,
        '',
        ...stale.map((e) => `  - ${e}`),
      ].join('\n');
      throw new Error(msg);
    }
    expect(stale).toEqual([]);
  });

  test('KNOWN_EXCLUSIONS does not overlap with TASK_EVENTS (no conflict)', () => {
    const whitelist = readPeekWhitelist();
    const conflicts = [...KNOWN_EXCLUSIONS].filter((e) => whitelist.has(e));
    expect(conflicts).toEqual([]);
  });

  test('extractTaskBearingEventNames finds the new critic:debate_* events (sanity)', () => {
    const busSource = readFileSync(join(REPO_ROOT, 'src/core/bus.ts'), 'utf-8');
    const taskBearing = extractTaskBearingEventNames(busSource);
    // Regression sanity: after Wave 5 phases 1-3, these MUST be picked up
    expect(taskBearing.has('critic:debate_fired')).toBe(true);
    expect(taskBearing.has('critic:debate_denied')).toBe(true);
    // Post-merge addition from feature/main — must be seen
    expect(taskBearing.has('monitoring:drift_detected')).toBe(true);
  });
});
