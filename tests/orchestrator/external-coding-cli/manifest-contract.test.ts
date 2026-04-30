/**
 * Manifest contract — ensures every coding-cli event Vinyan emits is
 * registered in the EVENT_MANIFEST AND declares `taskId` in its payload
 * type. Without this, the SSE forwarder + recorder silently drop events.
 */
import { describe, expect, test } from 'bun:test';
import { EVENT_MANIFEST } from '../../../src/api/event-manifest.ts';
import type { VinyanBusEvents } from '../../../src/core/bus.ts';

const REQUIRED_CODING_CLI_EVENTS = [
  'coding-cli:session_created',
  'coding-cli:session_started',
  'coding-cli:state_changed',
  'coding-cli:message_sent',
  'coding-cli:output_delta',
  'coding-cli:tool_started',
  'coding-cli:tool_completed',
  'coding-cli:file_changed',
  'coding-cli:command_requested',
  'coding-cli:command_completed',
  'coding-cli:approval_required',
  'coding-cli:approval_resolved',
  'coding-cli:decision_recorded',
  'coding-cli:checkpoint',
  'coding-cli:result_reported',
  'coding-cli:verification_started',
  'coding-cli:verification_completed',
  'coding-cli:completed',
  'coding-cli:failed',
  'coding-cli:stalled',
  'coding-cli:cancelled',
] as const satisfies ReadonlyArray<keyof VinyanBusEvents>;

describe('coding-cli event manifest', () => {
  test('every required coding-cli event is in the manifest', () => {
    const known = new Set(EVENT_MANIFEST.map((e) => e.event));
    const missing = REQUIRED_CODING_CLI_EVENTS.filter((e) => !known.has(e));
    expect(missing).toEqual([]);
  });

  test('every coding-cli event is task-scoped, sse=true, record=true', () => {
    for (const event of REQUIRED_CODING_CLI_EVENTS) {
      const entry = EVENT_MANIFEST.find((e) => e.event === event);
      expect(entry).toBeDefined();
      expect(entry?.scope).toBe('task');
      expect(entry?.sse).toBe(true);
      expect(entry?.record).toBe(true);
    }
  });

  // Type-level check — every coding-cli event payload must extend
  // CodingCliEventBase, which carries taskId. This test is a runtime
  // proxy: it asserts the type assignability via a no-op compile-time
  // check encoded as a const assignment.
  test('payload type carries taskId (compile-time enforced)', () => {
    type Payload = VinyanBusEvents[(typeof REQUIRED_CODING_CLI_EVENTS)[number]];
    type HasTaskId = Payload extends { taskId: string } ? true : false;
    const verified: HasTaskId = true;
    expect(verified).toBe(true);
  });
});
