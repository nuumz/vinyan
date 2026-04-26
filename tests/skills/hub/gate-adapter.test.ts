/**
 * Gate adapter tests — verify `buildImporterGateFn` correctly projects the
 * real `GateVerdict` shape onto the narrow `ImporterGateVerdict` the
 * `SkillImporter` promotion rule consumes.
 *
 * Tests pin each mapping lane (allow / block / allow-with-caveats /
 * uncertain), confirm `aggregateConfidence` pass-through + fallback, and
 * confirm that a thrown `runGate` propagates unchanged (the importer's
 * state machine handles the throw).
 */
import { describe, expect, test } from 'bun:test';
import type { GateRequest, GateVerdict } from '../../../src/gate/gate.ts';
import type { ImporterGateRequest } from '../../../src/skills/hub/importer.ts';
import { buildImporterGateFn } from '../../../src/skills/hub/gate-adapter.ts';

const IMPORTER_REQ: ImporterGateRequest = {
  tool: 'import_skill_dry_run',
  params: {
    file_path: 'skills/refactor/extract-method-ts/SKILL.md',
    content: '## Procedure\n1. Do a thing.\n',
    workspace: '/tmp/ws',
  },
  skillId: 'refactor/extract-method-ts',
  dryRun: true,
};

function stubGate(verdict: GateVerdict): { run: (r: GateRequest) => Promise<GateVerdict>; calls: GateRequest[] } {
  const calls: GateRequest[] = [];
  return {
    calls,
    run: async (r) => {
      calls.push(r);
      return verdict;
    },
  };
}

function baseVerdict(overrides: Partial<GateVerdict>): GateVerdict {
  return {
    decision: 'allow',
    reasons: [],
    oracle_results: {},
    oracle_abstentions: {},
    durationMs: 12,
    aggregateConfidence: 0.9,
    epistemicDecision: 'allow',
    ...overrides,
  };
}

describe('buildImporterGateFn', () => {
  test('allow + epistemic=allow → decision=allow, epistemicDecision=allow', async () => {
    const stub = stubGate(baseVerdict({ decision: 'allow', epistemicDecision: 'allow', aggregateConfidence: 0.92 }));
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.decision).toBe('allow');
    expect(v.epistemicDecision).toBe('allow');
    expect(v.aggregateConfidence).toBeCloseTo(0.92, 4);
  });

  test('block + epistemic=block → decision=block, epistemicDecision=block', async () => {
    const stub = stubGate(
      baseVerdict({
        decision: 'block',
        epistemicDecision: 'block',
        aggregateConfidence: 0.12,
        reasons: ['oracle-ast-failed', 'oracle-type-failed'],
      }),
    );
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.decision).toBe('block');
    expect(v.epistemicDecision).toBe('block');
    expect(v.reasons).toEqual(['oracle-ast-failed', 'oracle-type-failed']);
  });

  test('allow-with-caveats passes through epistemic decision', async () => {
    const stub = stubGate(baseVerdict({ decision: 'allow', epistemicDecision: 'allow-with-caveats', aggregateConfidence: 0.71 }));
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.decision).toBe('allow');
    expect(v.epistemicDecision).toBe('allow-with-caveats');
  });

  test('uncertain epistemic → decision=block, epistemicDecision=uncertain', async () => {
    const stub = stubGate(
      baseVerdict({ decision: 'block', epistemicDecision: 'uncertain', aggregateConfidence: 0.4, reasons: [] }),
    );
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.decision).toBe('block');
    expect(v.epistemicDecision).toBe('uncertain');
    expect(v.aggregateConfidence).toBeCloseTo(0.4, 4);
  });

  test('missing aggregateConfidence falls back to mean of oracle confidences', async () => {
    const stub = stubGate({
      decision: 'allow',
      reasons: [],
      oracle_results: {
        ast: {
          verified: true,
          type: 'known',
          confidence: 0.8,
          evidence: [],
          fileHashes: {},
          durationMs: 1,
        },
        type: {
          verified: true,
          type: 'known',
          confidence: 0.6,
          evidence: [],
          fileHashes: {},
          durationMs: 1,
        },
      },
      oracle_abstentions: {},
      durationMs: 12,
      // aggregateConfidence omitted on purpose
    });
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.aggregateConfidence).toBeCloseTo(0.7, 4);
  });

  test('no aggregate + no oracle results → aggregate defaults to 0', async () => {
    const stub = stubGate({
      decision: 'block',
      reasons: ['guardrail-injection'],
      oracle_results: {},
      oracle_abstentions: {},
      durationMs: 5,
    });
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    const v = await gate(IMPORTER_REQ);
    expect(v.aggregateConfidence).toBe(0);
    expect(v.reasons).toEqual(['guardrail-injection']);
  });

  test('gate request is built with mutating tool and importer params', async () => {
    const stub = stubGate(baseVerdict({}));
    const gate = buildImporterGateFn({ runGate: stub.run, workspace: '/tmp/ws' });
    await gate(IMPORTER_REQ);
    expect(stub.calls.length).toBe(1);
    const req = stub.calls[0]!;
    expect(req.tool).toBe('write_file'); // canonical mutating tool — forces oracle dispatch
    expect(req.params.file_path).toBe(IMPORTER_REQ.params.file_path);
    expect(req.params.content).toBe(IMPORTER_REQ.params.content);
    expect(req.params.workspace).toBe(IMPORTER_REQ.params.workspace);
    expect(req.session_id).toBe(`skill-import/${IMPORTER_REQ.skillId}`);
  });

  test('runGate throw propagates (importer catches)', async () => {
    const gate = buildImporterGateFn({
      runGate: async () => {
        throw new Error('gate crashed');
      },
      workspace: '/tmp/ws',
    });
    await expect(gate(IMPORTER_REQ)).rejects.toThrow('gate crashed');
  });
});
