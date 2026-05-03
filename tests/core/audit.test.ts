/**
 * AuditEntry schema + redact tree-walker — behavior tests.
 *
 * Covers the load-bearing invariants for the A8 audit surface: every
 * variant accepts its own fields and rejects fields belonging to other
 * variants; redaction preserves structure while redacting every string
 * leaf; cycles do not crash; the wrapper enforces sha256 / schemaVersion
 * shape.
 */

import { describe, expect, test } from 'bun:test';
import {
  ACTOR_TYPES,
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  AuditEntrySchema,
  parseAuditEntry,
  pickEntries,
  safeParseAuditEntry,
} from '../../src/core/audit.ts';
import { redactAuditPayload } from '../../src/core/audit-redact.ts';
import { BUILT_IN_POLICY } from '../../src/trajectory/redaction.ts';

const FAKE_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function wrapper(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'audit-1',
    taskId: 'task-1',
    ts: 1_700_000_000_000,
    policyVersion: 'policy-v1',
    schemaVersion: AUDIT_SCHEMA_VERSION,
    actor: { type: 'orchestrator' as const },
    ...overrides,
  };
}

describe('AuditEntrySchema — variant acceptance', () => {
  test('thought variant accepts content + optional trigger', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'thought',
      content: 'Considering whether to call the search tool',
      trigger: 'pre-tool',
    });
    expect(e.kind).toBe('thought');
    if (e.kind === 'thought') {
      expect(e.trigger).toBe('pre-tool');
      expect(e.content).toContain('search tool');
    }
  });

  test('tool_call variant requires sha256-shaped argsHash', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'tool_call',
      lifecycle: 'executed',
      toolId: 'Read',
      argsHash: FAKE_HASH,
      argsRedacted: { path: '<HOME>/foo.ts' },
      latencyMs: 42,
    });
    expect(e.kind).toBe('tool_call');
    if (e.kind === 'tool_call') {
      expect(e.lifecycle).toBe('executed');
      expect(e.latencyMs).toBe(42);
    }
  });

  test('tool_call rejects malformed argsHash', () => {
    const result = AuditEntrySchema.safeParse({
      ...wrapper(),
      kind: 'tool_call',
      lifecycle: 'executed',
      toolId: 'Read',
      argsHash: 'NOT_HEX',
      argsRedacted: {},
    });
    expect(result.success).toBe(false);
  });

  test('decision variant accepts decisionType + ruleId', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'decision',
      decisionType: 'tool_deny',
      verdict: 'denied',
      rationale: 'capability-scoped authorization failed',
      ruleId: 'contract:capability-shell',
      tier: 'deterministic',
    });
    expect(e.kind).toBe('decision');
    if (e.kind === 'decision') {
      expect(e.decisionType).toBe('tool_deny');
      expect(e.ruleId).toBe('contract:capability-shell');
    }
  });

  test('verdict variant accepts pass:unknown literal', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'verdict',
      source: 'oracle',
      pass: 'unknown',
      oracleId: 'type-oracle',
      confidence: 0.42,
    });
    expect(e.kind).toBe('verdict');
    if (e.kind === 'verdict') {
      expect(e.pass).toBe('unknown');
    }
  });

  test('verdict rejects confidence outside [0,1]', () => {
    const result = AuditEntrySchema.safeParse({
      ...wrapper(),
      kind: 'verdict',
      source: 'critic',
      pass: false,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test('plan_step variant tracks status enum', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'plan_step',
      stepId: 'step-1',
      status: 'running',
    });
    expect(e.kind).toBe('plan_step');
    if (e.kind === 'plan_step') {
      expect(e.status).toBe('running');
    }
  });

  test('delegate variant requires subAgentId', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'delegate',
      phase: 'spawn',
      subAgentId: 'sub-task-2',
      persona: 'researcher',
      budgetMs: 60_000,
    });
    expect(e.kind).toBe('delegate');
    if (e.kind === 'delegate') {
      expect(e.subAgentId).toBe('sub-task-2');
      expect(e.persona).toBe('researcher');
    }
  });

  test('gate variant accepts decision when answered', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'gate',
      gateName: 'approval',
      phase: 'answered',
      decision: 'approve',
    });
    expect(e.kind).toBe('gate');
    if (e.kind === 'gate') {
      expect(e.decision).toBe('approve');
    }
  });

  test('final variant requires assembled-from arrays', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper(),
      kind: 'final',
      contentHash: FAKE_HASH,
      contentRedactedPreview: 'Here is the answer…',
      assembledFromStepIds: ['step-1', 'step-2'],
      assembledFromDelegateIds: ['sub-task-2'],
    });
    expect(e.kind).toBe('final');
    if (e.kind === 'final') {
      expect(e.assembledFromStepIds.length).toBe(2);
    }
  });
});

describe('AuditEntrySchema — discriminator narrowing', () => {
  test('a tool_call payload does not parse as a thought', () => {
    const result = AuditEntrySchema.safeParse({
      ...wrapper(),
      kind: 'thought',
      lifecycle: 'executed',
      toolId: 'Read',
      argsHash: FAKE_HASH,
    });
    // Missing required `content` field for `thought` variant.
    expect(result.success).toBe(false);
  });

  test('unknown kind is rejected', () => {
    const result = AuditEntrySchema.safeParse({
      ...wrapper(),
      kind: 'reflect',
      content: 'should-not-parse',
    });
    expect(result.success).toBe(false);
  });
});

describe('AuditEntrySchema — wrapper enforcement', () => {
  test('rejects missing taskId', () => {
    const w = wrapper();
    delete (w as Record<string, unknown>).taskId;
    const result = AuditEntrySchema.safeParse({
      ...w,
      kind: 'thought',
      content: 'x',
    });
    expect(result.success).toBe(false);
  });

  test('rejects wrong schemaVersion', () => {
    const result = AuditEntrySchema.safeParse({
      ...wrapper({ schemaVersion: 2 }),
      kind: 'thought',
      content: 'x',
    });
    expect(result.success).toBe(false);
  });

  test('accepts every canonical actor type', () => {
    for (const t of ACTOR_TYPES) {
      const e = AuditEntrySchema.parse({
        ...wrapper({ actor: { type: t } }),
        kind: 'thought',
        content: 'ok',
      });
      expect(e.actor.type).toBe(t);
    }
  });

  test('accepts evidence refs across all five evidence kinds', () => {
    const e = AuditEntrySchema.parse({
      ...wrapper({
        evidenceRefs: [
          { type: 'file', path: 'src/foo.ts', sha256: FAKE_HASH },
          { type: 'fact', factId: 'fact-1', sha256: OTHER_HASH },
          { type: 'event', eventId: 'evt-1' },
          { type: 'verdict', verdictId: 'verdict-1' },
          { type: 'tool_result', auditEntryId: 'audit-2' },
        ],
      }),
      kind: 'thought',
      content: 'multi-evidence',
    });
    expect(e.evidenceRefs?.length).toBe(5);
  });
});

describe('parseAuditEntry / safeParseAuditEntry', () => {
  test('parseAuditEntry throws on bad input', () => {
    expect(() => parseAuditEntry({ kind: 'thought' })).toThrow();
  });

  test('safeParseAuditEntry returns ok:false with a ZodError', () => {
    const r = safeParseAuditEntry({ kind: 'thought' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.length).toBeGreaterThan(0);
  });

  test('safeParseAuditEntry returns ok:true on valid input', () => {
    const r = safeParseAuditEntry({
      ...wrapper(),
      kind: 'thought',
      content: 'ok',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.kind).toBe('thought');
  });
});

describe('pickEntries', () => {
  test('narrows to a single kind', () => {
    const entries: AuditEntry[] = [
      { ...wrapper({ id: 'a' }), kind: 'thought', content: 'one' },
      {
        ...wrapper({ id: 'b' }),
        kind: 'tool_call',
        lifecycle: 'executed',
        toolId: 'Read',
        argsHash: FAKE_HASH,
        argsRedacted: {},
      },
      { ...wrapper({ id: 'c' }), kind: 'thought', content: 'two' },
    ];
    const thoughts = pickEntries(entries, 'thought');
    expect(thoughts.length).toBe(2);
    expect(thoughts.map((e) => e.content)).toEqual(['one', 'two']);
  });
});

describe('redactAuditPayload', () => {
  test('redacts home paths in nested string leaves', () => {
    const out = redactAuditPayload(
      {
        path: '/Users/phumin.k/secret.ts',
        nested: { other: '/home/alice/.bashrc' },
      },
      BUILT_IN_POLICY,
    );
    const obj = out as { path: string; nested: { other: string } };
    expect(obj.path).toBe('<HOME>/secret.ts');
    expect(obj.nested.other).toBe('<HOME>/.bashrc');
  });

  test('redacts env-looking assignments', () => {
    const out = redactAuditPayload({ env: 'API_KEY=AKIAI44QH8DHBEXAMPLEXX' }, BUILT_IN_POLICY);
    const obj = out as { env: string };
    expect(obj.env).toBe('<ENV>');
  });

  test('redacts high-entropy tokens', () => {
    const out = redactAuditPayload({ token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9XXXXXXXXXXXX' }, BUILT_IN_POLICY);
    const obj = out as { token: string };
    expect(obj.token).toBe('<REDACTED_TOKEN>');
  });

  test('preserves non-string primitives unchanged', () => {
    const out = redactAuditPayload({ n: 42, b: true, nil: null, deep: { arr: [1, false, 'plain'] } }, BUILT_IN_POLICY);
    expect(out).toEqual({
      n: 42,
      b: true,
      nil: null,
      deep: { arr: [1, false, 'plain'] },
    });
  });

  test('walks arrays of objects', () => {
    const out = redactAuditPayload([{ path: '/Users/me/a.ts' }, { path: '/Users/me/b.ts' }], BUILT_IN_POLICY) as Array<{
      path: string;
    }>;
    expect(out[0]?.path).toBe('<HOME>/a.ts');
    expect(out[1]?.path).toBe('<HOME>/b.ts');
  });

  test('cycle-safe: replaces second visit with <CYCLE>', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', back: a };
    a.forward = b;
    const out = redactAuditPayload(a, BUILT_IN_POLICY) as Record<string, unknown>;
    const fwd = out.forward as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(fwd.name).toBe('b');
    expect(fwd.back).toBe('<CYCLE>');
  });

  test('drops function and symbol values', () => {
    const out = redactAuditPayload(
      {
        keep: 'plain',
        fn: () => 1,
        sym: Symbol('x'),
      },
      BUILT_IN_POLICY,
    ) as Record<string, unknown>;
    expect(out.keep).toBe('plain');
    expect('fn' in out).toBe(false);
    expect('sym' in out).toBe(false);
  });

  test('returns same shape (does not mutate input)', () => {
    const input = { path: '/Users/me/x.ts', n: 1 };
    const out = redactAuditPayload(input, BUILT_IN_POLICY);
    expect(input.path).toBe('/Users/me/x.ts');
    expect(out).not.toBe(input);
  });
});
