/**
 * Branded ID helpers for agent-vocabulary.
 *
 * Covers `asPersonaId` (throws), `tryAsPersonaId` (non-throwing
 * boundary helper used by trace-store deserialization), and the shape
 * predicates.
 */
import { describe, expect, test } from 'bun:test';
import {
  asPersonaId,
  isPersonaIdShape,
  isWorkerIdShape,
  type PersonaId,
  tryAsPersonaId,
} from '../../src/core/agent-vocabulary.ts';

const pid = (s: string): PersonaId => s as PersonaId;

describe('asPersonaId', () => {
  test('returns the branded value for a valid slug', () => {
    expect(asPersonaId('developer')).toBe(pid('developer'));
    expect(asPersonaId('ts-coder')).toBe(pid('ts-coder'));
    expect(asPersonaId('a')).toBe(pid('a'));
  });

  test('throws on uppercase, leading digit, special chars, or oversize', () => {
    expect(() => asPersonaId('Developer')).toThrow();
    expect(() => asPersonaId('1coder')).toThrow();
    expect(() => asPersonaId('coder_x')).toThrow();
    expect(() => asPersonaId('coder.dot')).toThrow();
    expect(() => asPersonaId('')).toThrow();
    expect(() => asPersonaId('a'.repeat(65))).toThrow();
  });
});

describe('tryAsPersonaId', () => {
  test('returns the branded value for a valid slug', () => {
    expect(tryAsPersonaId('developer')).toBe(pid('developer'));
    expect(tryAsPersonaId('ts-coder')).toBe(pid('ts-coder'));
  });

  test('returns undefined for nullish input', () => {
    expect(tryAsPersonaId(undefined)).toBeUndefined();
    expect(tryAsPersonaId(null)).toBeUndefined();
  });

  test('returns undefined for shape-invalid input (does NOT fall back to bare string)', () => {
    expect(tryAsPersonaId('INVALID UPPER')).toBeUndefined();
    expect(tryAsPersonaId('1coder')).toBeUndefined();
    expect(tryAsPersonaId('coder_x')).toBeUndefined();
    expect(tryAsPersonaId('')).toBeUndefined();
  });

  test('does not throw on any input (boundary safe)', () => {
    // Not strictly a behaviour assertion but the contract is
    // "non-throwing" — verify we can fuzz it without try/catch.
    for (const v of ['ok', 'OK', '', 'a-b', '!!!', '  spaces  ', null, undefined]) {
      tryAsPersonaId(v as string | null | undefined);
    }
  });
});

describe('shape predicates', () => {
  test('isPersonaIdShape: true for slugs, false for everything else', () => {
    expect(isPersonaIdShape('developer')).toBe(true);
    expect(isPersonaIdShape('ts-coder')).toBe(true);
    expect(isPersonaIdShape('Developer')).toBe(false);
    expect(isPersonaIdShape('1coder')).toBe(false);
    expect(isPersonaIdShape('')).toBe(false);
  });

  test('isWorkerIdShape: looser than PersonaId (allows _, :, .)', () => {
    expect(isWorkerIdShape('worker-1')).toBe(true);
    expect(isWorkerIdShape('worker_1')).toBe(true);
    expect(isWorkerIdShape('worker:1')).toBe(true);
    expect(isWorkerIdShape('worker.v2')).toBe(true);
    expect(isWorkerIdShape('Worker')).toBe(false);
  });
});

describe('hierarchy ids — Phase 2 audit redesign', () => {
  test('asSessionId / tryAsSessionId — opaque non-empty string', async () => {
    const { asSessionId, tryAsSessionId } = await import('../../src/core/agent-vocabulary.ts');
    expect(asSessionId('sess-abc')).toBe('sess-abc' as ReturnType<typeof asSessionId>);
    expect(() => asSessionId('')).toThrow();
    expect(tryAsSessionId('sess-abc')).toBe('sess-abc' as ReturnType<typeof asSessionId>);
    expect(tryAsSessionId('')).toBeUndefined();
    expect(tryAsSessionId(null)).toBeUndefined();
    expect(tryAsSessionId(undefined)).toBeUndefined();
  });

  test('asTaskId / tryAsTaskId — opaque non-empty string', async () => {
    const { asTaskId, tryAsTaskId } = await import('../../src/core/agent-vocabulary.ts');
    expect(asTaskId('task-1')).toBe('task-1' as ReturnType<typeof asTaskId>);
    expect(() => asTaskId('')).toThrow();
    expect(tryAsTaskId('task-1')).toBe('task-1' as ReturnType<typeof asTaskId>);
    expect(tryAsTaskId(null)).toBeUndefined();
  });

  test('asSubTaskId — accepts canonical delegate-shape and any non-empty string', async () => {
    const { asSubTaskId } = await import('../../src/core/agent-vocabulary.ts');
    expect(asSubTaskId('task-1-delegate-step1')).toBeTruthy();
    expect(asSubTaskId('task-1-delegate-step1-r2')).toBeTruthy();
    expect(asSubTaskId('task-1-wf-step1')).toBeTruthy();
    expect(() => asSubTaskId('')).toThrow();
  });

  test('asStepId — accepts step\\d+ shapes (no enforcement, but typical)', async () => {
    const { asStepId } = await import('../../src/core/agent-vocabulary.ts');
    expect(asStepId('step1')).toBeTruthy();
    expect(asStepId('step42')).toBeTruthy();
    expect(() => asStepId('')).toThrow();
  });

  test('asSubAgentId — opaque non-empty string', async () => {
    const { asSubAgentId } = await import('../../src/core/agent-vocabulary.ts');
    expect(asSubAgentId('task-1-delegate-step1')).toBeTruthy();
    expect(() => asSubAgentId('')).toThrow();
  });

  test('subAgentIdFromSubTask + subTaskIdFromSubAgent — round-trip identity', async () => {
    const { asSubTaskId, subAgentIdFromSubTask, subTaskIdFromSubAgent } = await import(
      '../../src/core/agent-vocabulary.ts'
    );
    const st = asSubTaskId('task-1-delegate-step1');
    const sa = subAgentIdFromSubTask(st);
    const back = subTaskIdFromSubAgent(sa);
    expect(back).toBe(st as unknown as typeof back);
  });

  test('WorkflowId is type-level alias of TaskId — invariant: workflowId === taskId', async () => {
    // No runtime check possible (type aliases erase). The invariant lives in
    // emit sites (an audit:entry's `workflowId` MUST equal its `taskId`); a
    // contract test below in P2.2 enforces it on emitted entries.
    const { asTaskId } = await import('../../src/core/agent-vocabulary.ts');
    const tid = asTaskId('task-1');
    // Use as WorkflowId — compiles (alias), runs (string equality).
    const wid: import('../../src/core/agent-vocabulary.ts').WorkflowId = tid;
    expect(wid).toBe(tid);
  });
});
