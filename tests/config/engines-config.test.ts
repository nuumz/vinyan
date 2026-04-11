/**
 * EnginesConfig Schema Tests
 *
 * Tests the non-LLM reasoning engine configuration schema (Z3, Human bridge)
 * within the VinyanConfigSchema.
 */
import { describe, expect, test } from 'bun:test';
import { VinyanConfigSchema } from '../../src/config/schema.ts';

describe('EnginesConfig — defaults', () => {
  test('engines section is optional and defaults to undefined', () => {
    const config = VinyanConfigSchema.parse({});
    expect(config.engines).toBeUndefined();
  });

  test('empty engines object fills in z3 and human defaults', () => {
    const config = VinyanConfigSchema.parse({ engines: {} });

    expect(config.engines).toBeDefined();
    expect(config.engines!.z3.enabled).toBe(false);
    expect(config.engines!.z3.path).toBe('z3');
    expect(config.engines!.human.enabled).toBe(false);
    expect(config.engines!.human.timeout_ms).toBe(300_000);
  });

  test('z3 defaults: disabled, path = "z3"', () => {
    const config = VinyanConfigSchema.parse({ engines: { z3: {} } });

    expect(config.engines!.z3.enabled).toBe(false);
    expect(config.engines!.z3.path).toBe('z3');
  });

  test('human defaults: disabled, timeout = 300_000ms', () => {
    const config = VinyanConfigSchema.parse({ engines: { human: {} } });

    expect(config.engines!.human.enabled).toBe(false);
    expect(config.engines!.human.timeout_ms).toBe(300_000);
  });
});

describe('EnginesConfig — custom values', () => {
  test('z3 with custom path and enabled', () => {
    const config = VinyanConfigSchema.parse({
      engines: {
        z3: { enabled: true, path: '/opt/z3/bin/z3' },
      },
    });

    expect(config.engines!.z3.enabled).toBe(true);
    expect(config.engines!.z3.path).toBe('/opt/z3/bin/z3');
  });

  test('human with custom timeout and enabled', () => {
    const config = VinyanConfigSchema.parse({
      engines: {
        human: { enabled: true, timeout_ms: 60_000 },
      },
    });

    expect(config.engines!.human.enabled).toBe(true);
    expect(config.engines!.human.timeout_ms).toBe(60_000);
  });

  test('both engines configured together', () => {
    const config = VinyanConfigSchema.parse({
      engines: {
        z3: { enabled: true, path: '/usr/local/bin/z3' },
        human: { enabled: true, timeout_ms: 120_000 },
      },
    });

    expect(config.engines!.z3.enabled).toBe(true);
    expect(config.engines!.z3.path).toBe('/usr/local/bin/z3');
    expect(config.engines!.human.enabled).toBe(true);
    expect(config.engines!.human.timeout_ms).toBe(120_000);
  });
});

describe('EnginesConfig — validation', () => {
  test('human timeout_ms must be positive', () => {
    expect(() =>
      VinyanConfigSchema.parse({
        engines: { human: { timeout_ms: 0 } },
      }),
    ).toThrow();
  });

  test('human timeout_ms rejects negative values', () => {
    expect(() =>
      VinyanConfigSchema.parse({
        engines: { human: { timeout_ms: -1 } },
      }),
    ).toThrow();
  });

  test('engines config coexists with other root sections', () => {
    const config = VinyanConfigSchema.parse({
      version: 1,
      engines: { z3: { enabled: true } },
      orchestrator: {
        routing: {
          l0_max_risk: 0.1,
          l1_max_risk: 0.3,
          l2_max_risk: 0.7,
        },
      },
    });

    expect(config.version).toBe(1);
    expect(config.engines!.z3.enabled).toBe(true);
    expect(config.orchestrator!.routing.l0_max_risk).toBe(0.1);
  });
});
