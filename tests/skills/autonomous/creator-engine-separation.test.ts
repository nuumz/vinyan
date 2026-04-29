/**
 * Phase-4 risk-C3 enforcement: AutonomousSkillCreator refuses to wire when
 * generator and critic share an engine id.
 *
 * A1 Epistemic Separation forbids the same engine from both drafting AND
 * critiquing a skill. The construction-time check is the last line of
 * defense if downstream wiring forgets to pick distinct engines.
 */
import { describe, expect, test } from 'bun:test';
import { AutonomousSkillCreator, type AutonomousSkillCreatorDeps } from '../../../src/skills/autonomous/creator.ts';

function makeMinimalDeps(overrides: Partial<AutonomousSkillCreatorDeps>): AutonomousSkillCreatorDeps {
  // Stubs are only needed for type completeness — these tests don't invoke
  // any of the methods that actually call into them.
  return {
    predictionLedger: { listSamples: () => [] } as unknown as AutonomousSkillCreatorDeps['predictionLedger'],
    skillStore: {
      upsertSkill: async () => {},
      getSkill: async () => null,
    } as unknown as AutonomousSkillCreatorDeps['skillStore'],
    artifactStore: { write: async () => {} } as unknown as AutonomousSkillCreatorDeps['artifactStore'],
    generator: async () => ({}) as unknown as Awaited<ReturnType<AutonomousSkillCreatorDeps['generator']>>,
    // Construction-time tests don't invoke the gate or critic; cast through
    // unknown so the inner shape doesn't track the real ImporterGateVerdict /
    // ImporterCriticVerdict schemas.
    gate: (async () => ({ pass: true, aggregateConfidence: 1, oracles: [] })) as unknown as AutonomousSkillCreatorDeps['gate'],
    critic: (async () => ({ approved: true, notes: '' })) as unknown as AutonomousSkillCreatorDeps['critic'],
    profile: 'default',
    ...overrides,
  };
}

describe('AutonomousSkillCreator engine-separation enforcement', () => {
  test('throws when generator and critic engine ids match', () => {
    expect(
      () =>
        new AutonomousSkillCreator(
          makeMinimalDeps({
            generatorEngineId: 'anthropic-sonnet-4',
            criticEngineId: 'anthropic-sonnet-4',
          }),
        ),
    ).toThrow(/A1 violation/);
  });

  test('constructs cleanly when engine ids differ', () => {
    expect(
      () =>
        new AutonomousSkillCreator(
          makeMinimalDeps({
            generatorEngineId: 'anthropic-sonnet-4',
            criticEngineId: 'openrouter-gpt-4o',
          }),
        ),
    ).not.toThrow();
  });

  test('constructs cleanly when only one engine id is supplied (back-compat)', () => {
    expect(
      () => new AutonomousSkillCreator(makeMinimalDeps({ generatorEngineId: 'anthropic-sonnet-4' })),
    ).not.toThrow();
    expect(() => new AutonomousSkillCreator(makeMinimalDeps({ criticEngineId: 'anthropic-sonnet-4' }))).not.toThrow();
  });

  test('constructs cleanly when neither engine id is supplied (legacy)', () => {
    expect(() => new AutonomousSkillCreator(makeMinimalDeps({}))).not.toThrow();
  });
});
