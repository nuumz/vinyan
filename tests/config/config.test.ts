import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader.ts';

describe('config loader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-config-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('valid full config → parses correctly', () => {
    writeFileSync(
      join(tempDir, 'vinyan.json'),
      JSON.stringify({
        version: 1,
        oracles: {
          ast: { enabled: true, languages: ['typescript', 'python'] },
          type: { enabled: true, command: 'tsc --noEmit' },
          dep: { enabled: false },
        },
        orchestrator: {
          routing: {
            l0_max_risk: 0.15,
            l1_max_risk: 0.3,
            l2_max_risk: 0.8,
          },
          escalation: {
            max_retries_before_human: 5,
            channel: 'slack',
          },
        },
      }),
    );

    const config = loadConfig(tempDir);
    expect(config.version).toBe(1);
    expect(config.oracles.ast?.enabled).toBe(true);
    expect(config.oracles.ast?.languages).toEqual(['typescript', 'python']);
    expect(config.oracles.dep?.enabled).toBe(false);
    expect(config.orchestrator?.routing.l0_max_risk).toBe(0.15);
    expect(config.orchestrator?.routing.l1_max_risk).toBe(0.3);
    expect(config.orchestrator?.routing.l2_max_risk).toBe(0.8);
    expect(config.orchestrator?.escalation.channel).toBe('slack');
    expect(config.orchestrator?.escalation.max_retries_before_human).toBe(5);
  });

  test('missing vinyan.json → returns defaults (Phase 0 only)', () => {
    const config = loadConfig(tempDir);
    expect(config.version).toBe(1);
    expect(config.oracles.ast?.enabled).toBe(true);
    // Phase 1+ config not present by default
    expect(config.orchestrator).toBeUndefined();
  });

  test('partial config → defaults applied for missing fields', () => {
    writeFileSync(join(tempDir, 'vinyan.json'), JSON.stringify({ version: 1 }));

    const config = loadConfig(tempDir);
    expect(config.version).toBe(1);
    // Phase 0: oracles get defaults
    expect(config.oracles.ast?.enabled).toBe(true);
    // Phase 1+ not present when not specified
    expect(config.orchestrator).toBeUndefined();
  });

  test('orchestrator config → routing/isolation/evolution/escalation parsed', () => {
    writeFileSync(
      join(tempDir, 'vinyan.json'),
      JSON.stringify({
        version: 1,
        orchestrator: {
          routing: {},
          isolation: {},
          evolution: {},
          escalation: {},
        },
      }),
    );

    const config = loadConfig(tempDir);
    expect(config.orchestrator?.routing.l0_l1_model).toBe('claude-haiku');
    expect(config.orchestrator?.routing.l2_model).toBe('claude-sonnet');
    expect(config.orchestrator?.routing.l3_model).toBe('claude-opus');
    expect(config.orchestrator?.routing.latency_budgets_ms.l0).toBe(100);
    expect(config.orchestrator?.routing.latency_budgets_ms.l3).toBe(60000);
    expect(config.orchestrator?.isolation.container_image).toBe('vinyan-sandbox:latest');
    expect(config.orchestrator?.evolution.enabled).toBe(true);
    expect(config.orchestrator?.escalation.max_retries_before_human).toBe(3);
  });

  test('invalid JSON → throws with clear error', () => {
    writeFileSync(join(tempDir, 'vinyan.json'), '{ invalid json }');

    expect(() => loadConfig(tempDir)).toThrow('Invalid JSON');
  });

  test('invalid config values → throws with Zod error', () => {
    writeFileSync(
      join(tempDir, 'vinyan.json'),
      JSON.stringify({
        version: 1,
        orchestrator: { routing: { l0_max_risk: 2.0 } }, // out of range [0, 1]
      }),
    );

    expect(() => loadConfig(tempDir)).toThrow('Invalid vinyan.json');
  });

  test('empty object → all defaults applied', () => {
    writeFileSync(join(tempDir, 'vinyan.json'), '{}');

    const config = loadConfig(tempDir);
    expect(config.version).toBe(1);
    expect(Object.keys(config.oracles).length).toBeGreaterThan(0);
  });

  test('oracle tier defaults to deterministic', () => {
    const config = loadConfig(tempDir);
    expect(config.oracles.ast?.tier).toBe('deterministic');
    expect(config.oracles.type?.tier).toBe('deterministic');
    expect(config.oracles.dep?.tier).toBe('heuristic');
  });

  test('oracle timeout_behavior defaults to block', () => {
    const config = loadConfig(tempDir);
    expect(config.oracles.ast?.timeout_behavior).toBe('block');
    expect(config.oracles.type?.timeout_behavior).toBe('block');
    expect(config.oracles.dep?.timeout_behavior).toBe('block');
  });

  test('explicit tier and timeout_behavior override defaults', () => {
    writeFileSync(
      join(tempDir, 'vinyan.json'),
      JSON.stringify({
        version: 1,
        oracles: {
          ast: { enabled: true, tier: 'heuristic', timeout_behavior: 'warn' },
          type: { enabled: true, tier: 'probabilistic' },
        },
      }),
    );

    const config = loadConfig(tempDir);
    expect(config.oracles.ast?.tier).toBe('heuristic');
    expect(config.oracles.ast?.timeout_behavior).toBe('warn');
    expect(config.oracles.type?.tier).toBe('probabilistic');
    expect(config.oracles.type?.timeout_behavior).toBe('block'); // default
  });

  test('invalid tier value → throws Zod error', () => {
    writeFileSync(
      join(tempDir, 'vinyan.json'),
      JSON.stringify({
        version: 1,
        oracles: { ast: { enabled: true, tier: 'magical' } },
      }),
    );

    expect(() => loadConfig(tempDir)).toThrow('Invalid vinyan.json');
  });
});
