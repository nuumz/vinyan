/**
 * .mcp.json loader tests — G11 Claude Code drop-in compat.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupePreVinyanSources, loadMcpJsonServers, mergeMcpServerSources } from '../../src/mcp/mcp-json-loader.ts';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-mcp-json-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('loadMcpJsonServers', () => {
  test('returns empty when no .mcp.json exists', () => {
    const result = loadMcpJsonServers(workspace);
    expect(result.servers).toEqual([]);
    expect(result.attemptedPaths).toEqual([]);
    expect(result.invalidPaths).toEqual([]);
  });

  test('reads workspace-level .mcp.json with mcpServers map', () => {
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          fs: { type: 'stdio', command: '/usr/local/bin/mcp-fs' },
        },
      }),
    );
    const result = loadMcpJsonServers(workspace);
    expect(result.servers).toHaveLength(2);
    const github = result.servers.find((s) => s.name === 'github');
    expect(github).toBeDefined();
    expect(github?.command).toBe('npx');
    expect(github?.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(github?.defaultTrust).toBe('untrusted');
    expect(github?.source).toBe(join(workspace, '.mcp.json'));
    const fs = result.servers.find((s) => s.name === 'fs');
    expect(fs?.command).toBe('/usr/local/bin/mcp-fs');
    expect(fs?.args).toBeUndefined();
  });

  test('also reads .claude/mcp.json (legacy nested location)', () => {
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(
      join(workspace, '.claude', 'mcp.json'),
      JSON.stringify({ mcpServers: { legacy: { command: 'legacy-mcp' } } }),
    );
    const result = loadMcpJsonServers(workspace);
    const legacy = result.servers.find((s) => s.name === 'legacy');
    expect(legacy).toBeDefined();
    expect(legacy?.command).toBe('legacy-mcp');
  });

  test('.claude/mcp.json overrides .mcp.json on name conflict (later wins)', () => {
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'first' } } }));
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(
      join(workspace, '.claude', 'mcp.json'),
      JSON.stringify({ mcpServers: { dup: { command: 'second' } } }),
    );
    const result = loadMcpJsonServers(workspace);
    const dup = result.servers.find((s) => s.name === 'dup');
    expect(dup?.command).toBe('second');
    expect(result.servers).toHaveLength(1);
  });

  test('malformed JSON returns empty + records invalid path (does not throw)', () => {
    writeFileSync(join(workspace, '.mcp.json'), '{ this is not json');
    const result = loadMcpJsonServers(workspace);
    expect(result.servers).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.mcp.json'));
  });

  test('valid JSON with wrong shape returns empty + records invalid path', () => {
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          bad: {
            /* no command */
          },
        },
      }),
    );
    const result = loadMcpJsonServers(workspace);
    expect(result.servers).toEqual([]);
    expect(result.invalidPaths).toContain(join(workspace, '.mcp.json'));
  });

  test('tolerates unknown top-level fields (forward compat)', () => {
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ok: { command: 'mcp-ok' } },
        someFutureField: { ignored: true },
      }),
    );
    const result = loadMcpJsonServers(workspace);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe('ok');
  });

  test('always defaults defaultTrust to untrusted (A5 safe default)', () => {
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'x' } } }));
    const result = loadMcpJsonServers(workspace);
    expect(result.servers[0]?.defaultTrust).toBe('untrusted');
  });

  test('attemptedPaths reports files that exist', () => {
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const result = loadMcpJsonServers(workspace);
    expect(result.attemptedPaths).toEqual([join(workspace, '.mcp.json'), join(workspace, '.claude', 'mcp.json')]);
  });
});

// ── shared helpers for merge / dedup tests ─────────────────────────────
function mcpJson(name: string, command: string, args?: string[]) {
  return {
    name,
    command,
    ...(args ? { args } : {}),
    defaultTrust: 'untrusted' as const,
    source: `/fake/${name}`,
  };
}

// ── mergeMcpServerSources ───────────────────────────────────────────────
//
// Pure-function tests for the merge precedence rules used by factory.ts.
// Exercising this here (instead of through the full createOrchestrator
// integration test) keeps the merge contract reproducible without spinning
// up a SQLite db + every orchestrator dep.
describe('mergeMcpServerSources', () => {
  type Zone = 'local' | 'network' | 'remote';
  const TrustMap: Record<string, Zone> = {
    untrusted: 'remote',
    provisional: 'network',
    trusted: 'local',
  };

  test('mcp.json only — passes through with default zone', () => {
    const merged = mergeMcpServerSources<Zone>([mcpJson('a', 'cmd-a', ['--foo'])], [], TrustMap, 'remote');
    expect(merged).toEqual([{ name: 'a', command: 'cmd-a', args: ['--foo'], trustLevel: 'remote' }]);
  });

  test('vinyan.json only — passes through with mapped zone', () => {
    const merged = mergeMcpServerSources<Zone>(
      [],
      [{ name: 'b', command: 'cmd-b', trust_level: 'trusted' }],
      TrustMap,
      'remote',
    );
    expect(merged).toEqual([{ name: 'b', command: 'cmd-b', trustLevel: 'local' }]);
  });

  test('vinyan.json overrides trust tier on name conflict and PRESERVES args from mcp.json', () => {
    // The key regression we guard: vinyan.json's schema doesn't carry args,
    // but a naive merge would drop them and break `npx -y …` style entries.
    const merged = mergeMcpServerSources<Zone>(
      [mcpJson('shared', 'npx', ['-y', '@modelcontextprotocol/server-foo'])],
      [{ name: 'shared', command: 'npx', trust_level: 'trusted' }],
      TrustMap,
      'remote',
    );
    expect(merged).toEqual([
      {
        name: 'shared',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-foo'],
        trustLevel: 'local', // upgraded from default 'remote'
      },
    ]);
  });

  test('vinyan.json command overrides mcp.json command on conflict', () => {
    const merged = mergeMcpServerSources<Zone>(
      [mcpJson('s', 'old-cmd')],
      [{ name: 's', command: 'new-cmd', trust_level: 'trusted' }],
      TrustMap,
      'remote',
    );
    expect(merged[0]?.command).toBe('new-cmd');
  });

  test('unknown trust_level falls back to defaultZone', () => {
    const merged = mergeMcpServerSources<Zone>(
      [],
      [{ name: 'q', command: 'cmd', trust_level: 'mystery-tier' }],
      TrustMap,
      'remote',
    );
    expect(merged[0]?.trustLevel).toBe('remote');
  });

  test('missing trust_level treated as untrusted (mapped to remote in default config)', () => {
    const merged = mergeMcpServerSources<Zone>([], [{ name: 'q', command: 'cmd' }], TrustMap, 'remote');
    expect(merged[0]?.trustLevel).toBe('remote');
  });

  test('order is preserved (mcp.json names first, then vinyan.json-only names)', () => {
    const merged = mergeMcpServerSources<Zone>(
      [mcpJson('first', 'a'), mcpJson('second', 'b')],
      [{ name: 'third', command: 'c', trust_level: 'trusted' }],
      TrustMap,
      'remote',
    );
    expect(merged.map((s) => s.name)).toEqual(['first', 'second', 'third']);
  });
});

// ── dedupePreVinyanSources ──────────────────────────────────────────────
//
// Pure-function tests for the bundle-overrides-`.mcp.json` precedence used
// by factory.ts before the result is fed to `mergeMcpServerSources`.
// Closes the suppressed review comment on PR #38:761 (no focused test for
// the bundle-merge precedence).
describe('dedupePreVinyanSources', () => {
  function bundleEntry(name: string, command: string, args?: string[], source = `/bundle/${name}`) {
    return {
      name,
      command,
      ...(args ? { args } : {}),
      source,
    };
  }

  test('mcp.json only — passes through unchanged', () => {
    const result = dedupePreVinyanSources([mcpJson('a', 'cmd-a', ['--flag'])], []);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('a');
    expect(result[0]?.command).toBe('cmd-a');
    expect(result[0]?.args).toEqual(['--flag']);
    expect(result[0]?.defaultTrust).toBe('untrusted');
  });

  test('bundle only — wraps each entry with defaultTrust: untrusted', () => {
    const result = dedupePreVinyanSources([], [bundleEntry('b', 'cmd-b', ['--quiet'])]);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('b');
    expect(result[0]?.command).toBe('cmd-b');
    expect(result[0]?.args).toEqual(['--quiet']);
    expect(result[0]?.defaultTrust).toBe('untrusted');
    expect(result[0]?.source).toBe('/bundle/b');
  });

  test('bundle wins over .mcp.json on name conflict (curated > raw)', () => {
    const result = dedupePreVinyanSources(
      [mcpJson('shared', 'mcp-cmd', ['--from-mcp'])],
      [bundleEntry('shared', 'bundle-cmd', ['--from-bundle'], '/bundle/shared')],
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.command).toBe('bundle-cmd');
    expect(result[0]?.args).toEqual(['--from-bundle']);
    expect(result[0]?.source).toBe('/bundle/shared');
  });

  test('non-conflicting names accumulate from both sources', () => {
    const result = dedupePreVinyanSources(
      [mcpJson('a', 'cmd-a'), mcpJson('b', 'cmd-b')],
      [bundleEntry('c', 'cmd-c'), bundleEntry('d', 'cmd-d')],
    );
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.name).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('order: mcp.json entries first, then bundle-only names appended', () => {
    const result = dedupePreVinyanSources(
      [mcpJson('first', 'a'), mcpJson('second', 'b')],
      [bundleEntry('second', 'override-b'), bundleEntry('third', 'c')],
    );
    // Iteration order of Map preserves insertion / last-update order: 'first'
    // and 'second' inserted from mcp.json, 'second' overwritten in place,
    // 'third' appended.
    expect(result.map((s) => s.name)).toEqual(['first', 'second', 'third']);
    // The override on 'second' takes effect.
    expect(result.find((s) => s.name === 'second')?.command).toBe('override-b');
  });

  test('bundle entry without args: omits args (does not poison output with empty array)', () => {
    const result = dedupePreVinyanSources([], [bundleEntry('x', 'cmd-x')]);
    expect(result[0]?.args).toBeUndefined();
  });

  test('empty inputs return empty array', () => {
    expect(dedupePreVinyanSources([], [])).toEqual([]);
  });
});

// ── End-to-end precedence: bundle → .mcp.json → vinyan.json ─────────────
//
// Confirms the full chain documented in factory.ts works as expected:
//   1. .mcp.json provides defaults (trust 'remote' after merge)
//   2. bundle entries override .mcp.json on name
//   3. vinyan.json overrides trust + command, args from earlier sources preserved
describe('full MCP precedence chain (bundle → .mcp.json → vinyan.json)', () => {
  type Zone = 'local' | 'network' | 'remote';
  const TrustMap: Record<string, Zone> = {
    untrusted: 'remote',
    provisional: 'network',
    trusted: 'local',
  };

  test('bundle overrides .mcp.json command + args, vinyan.json overrides trust without dropping bundle args', () => {
    const mcpJsonServers = [
      {
        name: 'github',
        command: 'old-mcp',
        args: ['--from-mcp-json'],
        defaultTrust: 'untrusted' as const,
        source: '/.mcp.json',
      },
    ];
    const bundleServers = [
      {
        name: 'github',
        command: 'npx',
        args: ['-y', '@anthropic/server-github'],
        source: '/.vinyan-plugin/plugin.json',
      },
    ];
    const vinyanClientServers = [{ name: 'github', command: 'npx', trust_level: 'trusted' }];

    const deduped = dedupePreVinyanSources(mcpJsonServers, bundleServers);
    const merged = mergeMcpServerSources<Zone>(deduped, vinyanClientServers, TrustMap, 'remote');

    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('github');
    expect(merged[0]?.command).toBe('npx'); // vinyan.json wins on command (matches bundle anyway)
    expect(merged[0]?.args).toEqual(['-y', '@anthropic/server-github']); // bundle args preserved through vinyan.json override
    expect(merged[0]?.trustLevel).toBe('local'); // vinyan.json upgraded trust
  });

  test('vinyan.json-only entry: no bundle / mcp.json source', () => {
    const merged = mergeMcpServerSources<Zone>(
      dedupePreVinyanSources([], []),
      [{ name: 'solo', command: 'cmd', trust_level: 'provisional' }],
      TrustMap,
      'remote',
    );
    expect(merged).toEqual([{ name: 'solo', command: 'cmd', trustLevel: 'network' }]);
  });
});
