/**
 * `economy` default resolution through the real config loader.
 *
 * The factory reads `loadConfig(workspace).economy?.enabled`. Flipping only
 * `EconomyConfigSchema`'s own `enabled` default is not enough: if the top-level
 * key were `.optional()` (or `.default({})`), an absent `economy` block would
 * still resolve to `undefined` (or a bare `{}`) and the flip would be a silent
 * no-op. These tests pin the loader's answer, not the sub-schema's.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearConfigCache, loadConfig } from '../../src/config/loader.ts';

function workspaceWith(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinyan-econ-cfg-'));
  if (config) writeFileSync(join(dir, 'vinyan.json'), JSON.stringify(config, null, 2));
  return dir;
}

afterEach(() => clearConfigCache());

describe('economy config defaults via loadConfig', () => {
  test('a workspace with no vinyan.json at all gets economy enabled', () => {
    const config = loadConfig(workspaceWith());
    expect(config.economy?.enabled).toBe(true);
  });

  test('a vinyan.json that omits the economy key gets economy enabled', () => {
    const config = loadConfig(workspaceWith({ version: 1, oracles: {} }));
    expect(config.economy?.enabled).toBe(true);
    // Least intrusive: warn mode, no caps.
    expect(config.economy?.budgets.enforcement).toBe('warn');
    expect(config.economy?.budgets.hourly_usd).toBeUndefined();
  });

  test('the market and federation opt-ins stay off when economy is defaulted on', () => {
    const config = loadConfig(workspaceWith({ version: 1 }));
    expect(config.economy?.market.enabled).toBe(false);
    expect(config.economy?.federation.cost_sharing_enabled).toBe(false);
    expect(config.economy?.federation.peer_pricing_enabled).toBe(false);
  });

  test('an operator can still turn the whole subsystem off', () => {
    const config = loadConfig(workspaceWith({ version: 1, economy: { enabled: false } }));
    expect(config.economy?.enabled).toBe(false);
  });

  test('a partial economy block still gets the remaining defaults', () => {
    const config = loadConfig(workspaceWith({ version: 1, economy: { budgets: { hourly_usd: 5 } } }));
    expect(config.economy?.enabled).toBe(true);
    expect(config.economy?.budgets.hourly_usd).toBe(5);
    expect(config.economy?.budgets.enforcement).toBe('warn');
    expect(config.economy?.market.enabled).toBe(false);
  });
});
