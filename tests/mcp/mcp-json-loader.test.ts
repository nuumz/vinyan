/**
 * .mcp.json loader tests — G11 Claude Code drop-in compat.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpJsonServers } from '../../src/mcp/mcp-json-loader.ts';

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
    expect(github?.trustLevel).toBe('untrusted');
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

  test('always defaults trustLevel to untrusted (A5 safe default)', () => {
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'x' } } }));
    const result = loadMcpJsonServers(workspace);
    expect(result.servers[0]?.trustLevel).toBe('untrusted');
  });

  test('attemptedPaths reports files that exist', () => {
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const result = loadMcpJsonServers(workspace);
    expect(result.attemptedPaths).toEqual([join(workspace, '.mcp.json'), join(workspace, '.claude', 'mcp.json')]);
  });
});
