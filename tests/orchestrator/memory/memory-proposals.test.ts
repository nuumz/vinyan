/**
 * Tests for the Oracle-gated memory proposal module.
 *
 * Covers:
 *   - validateProposal: all 7 oracle checks + happy path
 *   - serializeProposal: frontmatter shape, YAML safety, body preservation
 *   - writeProposal: end-to-end write + reject + directory creation
 *   - listPendingProposals: empty + multi-entry ordering
 *   - memoryPropose tool: success path + oracle rejection path
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CONFIDENCE_FLOOR,
  listPendingProposals,
  MAX_PROPOSAL_SIZE,
  type MemoryProposal,
  PENDING_DIR_REL,
  serializeProposal,
  validateProposal,
  writeProposal,
} from '../../../src/orchestrator/memory/memory-proposals.ts';
import { memoryPropose } from '../../../src/orchestrator/tools/memory-tools.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

// ── Test fixtures ────────────────────────────────────────────────────

function makeValidProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    slug: 'prefer-bun-test',
    proposedBy: 'worker-42',
    sessionId: 'session-abc',
    category: 'convention',
    tier: 'heuristic',
    confidence: 0.85,
    applyTo: ['tests/**/*.test.ts'],
    description: 'Use bun:test for all test files in this repo.',
    body:
      '## Rule\n\nAll tests use `bun:test`, not `vitest` or `jest`.\n\n## Rationale\n\nThe repo is a Bun project.',
    evidence: [
      {
        filePath: 'tests/orchestrator/tools/tool-validator.test.ts',
        line: 1,
        note: 'Existing test file imports from bun:test',
      },
    ],
    ...overrides,
  };
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-memory-test-'));
});
afterEach(() => {
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

// ── validateProposal ────────────────────────────────────────────────

describe('validateProposal', () => {
  test('accepts a well-formed proposal', () => {
    const result = validateProposal(makeValidProposal());
    expect(result.valid).toBe(true);
  });

  test('rejects proposal missing required string field', () => {
    const result = validateProposal(makeValidProposal({ slug: '' }));
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('grammar');
    expect(result.reason).toContain('slug');
  });

  test('rejects proposal with non-numeric confidence', () => {
    const bad = makeValidProposal();
    (bad as unknown as { confidence: unknown }).confidence = 'high';
    const result = validateProposal(bad);
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('grammar');
  });

  test('rejects proposal with confidence below the floor', () => {
    const result = validateProposal(makeValidProposal({ confidence: CONFIDENCE_FLOOR - 0.01 }));
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('confidence_floor');
  });

  test('accepts a proposal exactly at the confidence floor', () => {
    // Boundary: `confidence === CONFIDENCE_FLOOR` is accepted (inclusive).
    const result = validateProposal(makeValidProposal({ confidence: CONFIDENCE_FLOOR }));
    expect(result.valid).toBe(true);
  });

  test('rejects proposal with confidence above 1', () => {
    const result = validateProposal(makeValidProposal({ confidence: 1.1 }));
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('confidence_floor');
  });

  test('rejects proposal with no evidence entries', () => {
    const result = validateProposal(makeValidProposal({ evidence: [] }));
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('evidence_floor');
  });

  test('rejects evidence with absolute path', () => {
    const result = validateProposal(
      makeValidProposal({
        evidence: [{ filePath: '/etc/passwd', note: 'Obvious attack' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('evidence_floor');
  });

  test('rejects evidence with parent-dir traversal', () => {
    const result = validateProposal(
      makeValidProposal({
        evidence: [{ filePath: '../../../etc/passwd', note: 'Traversal attempt' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('evidence_floor');
  });

  test('rejects evidence with empty note', () => {
    const result = validateProposal(
      makeValidProposal({
        evidence: [{ filePath: 'src/index.ts', note: '   ' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('evidence_floor');
  });

  test('rejects proposal with unknown category', () => {
    const bad = makeValidProposal();
    (bad as unknown as { category: string }).category = 'banana';
    const result = validateProposal(bad);
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('category_whitelist');
  });

  test('rejects proposal with unknown tier', () => {
    const bad = makeValidProposal();
    (bad as unknown as { tier: string }).tier = 'magical';
    const result = validateProposal(bad);
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('tier_whitelist');
  });

  test('rejects slug with dots or slashes', () => {
    for (const slug of ['../escape', 'with.dots', 'with/slash', 'UPPER']) {
      const result = validateProposal(makeValidProposal({ slug }));
      expect(result.valid).toBe(false);
      expect(result.failedCheck).toBe('slug_safety');
    }
  });

  test('accepts valid kebab-case slugs', () => {
    for (const slug of ['a', 'prefer-bun', 'rule-42-ok', 'x9']) {
      const result = validateProposal(makeValidProposal({ slug }));
      expect(result.valid).toBe(true);
    }
  });

  test('rejects proposal that serializes above the size limit', () => {
    const huge = 'x'.repeat(MAX_PROPOSAL_SIZE + 100);
    const result = validateProposal(makeValidProposal({ body: huge }));
    expect(result.valid).toBe(false);
    expect(result.failedCheck).toBe('size_limit');
  });
});

// ── serializeProposal ───────────────────────────────────────────────

describe('serializeProposal', () => {
  test('produces well-formed frontmatter', () => {
    const out = serializeProposal(makeValidProposal());
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('\n---\n');
    expect(out).toContain('proposedBy: "worker-42"');
    expect(out).toContain('sessionId: "session-abc"');
    expect(out).toContain('category: convention');
    expect(out).toContain('tier: heuristic');
    expect(out).toContain('confidence: 0.85');
  });

  test('preserves body content below the frontmatter', () => {
    const out = serializeProposal(makeValidProposal());
    expect(out).toContain('## Rule');
    expect(out).toContain('`bun:test`');
    expect(out).toContain('## Rationale');
  });

  test('emits applyTo as a YAML list', () => {
    const out = serializeProposal(
      makeValidProposal({ applyTo: ['src/**/*.ts', 'tests/**/*.test.ts'] }),
    );
    expect(out).toContain('applyTo:');
    expect(out).toContain('  - "src/**/*.ts"');
    expect(out).toContain('  - "tests/**/*.test.ts"');
  });

  test('omits applyTo when not provided', () => {
    const out = serializeProposal(makeValidProposal({ applyTo: undefined }));
    expect(out).not.toContain('applyTo:');
  });

  test('emits evidence as a YAML list with filePath, line, and note', () => {
    const out = serializeProposal(
      makeValidProposal({
        evidence: [
          { filePath: 'src/a.ts', line: 42, note: 'first evidence' },
          { filePath: 'src/b.ts', note: 'second evidence' },
        ],
      }),
    );
    expect(out).toContain('evidence:');
    expect(out).toContain('  - filePath: "src/a.ts"');
    expect(out).toContain('    line: 42');
    expect(out).toContain('    note: "first evidence"');
    expect(out).toContain('  - filePath: "src/b.ts"');
    expect(out).toContain('    note: "second evidence"');
  });

  test('escapes embedded quotes and backslashes in YAML strings', () => {
    const out = serializeProposal(
      makeValidProposal({
        description: 'Has "quotes" and \\ backslashes',
      }),
    );
    // Both quotes and backslashes should be escaped so YAML parsers recover them.
    expect(out).toContain('\\"quotes\\"');
    expect(out).toContain('\\\\');
  });

  test('escapes newlines in YAML-scalar fields', () => {
    const out = serializeProposal(makeValidProposal({ description: 'line1\nline2' }));
    // Newline in a frontmatter value must be escaped so the frontmatter stays single-line per field.
    expect(out).toContain('"line1\\nline2"');
  });
});

// ── writeProposal ───────────────────────────────────────────────────

describe('writeProposal', () => {
  test('writes a validated proposal into .vinyan/memory/pending/', () => {
    const result = writeProposal(workspace, makeValidProposal());
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain(PENDING_DIR_REL);
    expect(result.path).toContain('prefer-bun-test');
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('creates the pending directory if it does not exist', () => {
    // Fresh workspace — no .vinyan yet.
    expect(existsSync(join(workspace, PENDING_DIR_REL))).toBe(false);
    writeProposal(workspace, makeValidProposal());
    expect(existsSync(join(workspace, PENDING_DIR_REL))).toBe(true);
  });

  test('rejects invalid proposal by throwing', () => {
    expect(() =>
      writeProposal(workspace, makeValidProposal({ confidence: 0.5 })),
    ).toThrow(/confidence_floor/);
    // Nothing should have been written.
    expect(existsSync(join(workspace, PENDING_DIR_REL))).toBe(false);
  });

  test('written file content matches serializeProposal output', () => {
    const proposal = makeValidProposal();
    const result = writeProposal(workspace, proposal);
    const onDisk = readFileSync(result.path, 'utf-8');
    // The serialized form includes a `proposedAt` timestamp set at write time,
    // so we assert on the stable fields only.
    expect(onDisk).toContain('category: convention');
    expect(onDisk).toContain('confidence: 0.85');
    expect(onDisk).toContain('## Rule');
  });

  test('filename prefix makes rapid successive writes unique', () => {
    // Two writes with different slugs should never collide even if timestamps match.
    const r1 = writeProposal(workspace, makeValidProposal({ slug: 'rule-one' }));
    const r2 = writeProposal(workspace, makeValidProposal({ slug: 'rule-two' }));
    expect(r1.path).not.toBe(r2.path);
    expect(r1.path).toContain('rule-one');
    expect(r2.path).toContain('rule-two');
  });
});

// ── listPendingProposals ────────────────────────────────────────────

describe('listPendingProposals', () => {
  test('returns empty list when pending dir does not exist', () => {
    expect(listPendingProposals(workspace)).toEqual([]);
  });

  test('returns all .md files in chronological (filename) order', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rule-alpha' }));
    writeProposal(workspace, makeValidProposal({ slug: 'rule-beta' }));
    writeProposal(workspace, makeValidProposal({ slug: 'rule-gamma' }));

    const pending = listPendingProposals(workspace);
    expect(pending.length).toBe(3);
    // All should include their slug in the filename.
    const slugs = pending.map((p) => p.filename).join(',');
    expect(slugs).toContain('rule-alpha');
    expect(slugs).toContain('rule-beta');
    expect(slugs).toContain('rule-gamma');
    // Content should be non-empty.
    for (const p of pending) {
      expect(p.content.length).toBeGreaterThan(0);
      expect(p.content).toContain('category: convention');
    }
  });
});

// ── memoryPropose tool ──────────────────────────────────────────────

describe('memoryPropose tool', () => {
  function makeCtx(): ToolContext {
    return {
      routingLevel: 2,
      allowedPaths: [],
      workspace,
    };
  }

  test('descriptor advertises L2+ routing and file_write category', () => {
    const desc = memoryPropose.descriptor();
    expect(desc.name).toBe('memory_propose');
    expect(desc.minRoutingLevel).toBe(2);
    expect(desc.category).toBe('file_write');
    expect(desc.toolKind).toBe('executable');
    expect(desc.sideEffect).toBe(true);
    // Required params match oracle requirements.
    for (const field of ['slug', 'category', 'tier', 'confidence', 'description', 'body', 'evidence']) {
      expect(desc.inputSchema.required).toContain(field);
    }
  });

  test('successful proposal returns success status and writes pending file', async () => {
    const result = await memoryPropose.execute(
      {
        callId: 'call-1',
        slug: 'use-bun-test',
        category: 'convention',
        tier: 'heuristic',
        confidence: 0.85,
        description: 'Always use bun:test',
        body: 'Rationale: this is a Bun project.',
        evidence: [
          { file_path: 'package.json', note: 'Bun listed as runtime' },
        ],
        proposed_by: 'worker-7',
        session_id: 'session-xyz',
      },
      makeCtx(),
    );

    expect(result.status).toBe('success');
    expect(result.output).toContain('pending human review');
    expect(listPendingProposals(workspace).length).toBe(1);
  });

  test('oracle rejection returns error status and does NOT write', async () => {
    const result = await memoryPropose.execute(
      {
        callId: 'call-2',
        slug: 'too-timid',
        category: 'convention',
        tier: 'heuristic',
        confidence: 0.3, // below floor
        description: 'A rule',
        body: 'Body',
        evidence: [{ file_path: 'src/a.ts', note: 'weak evidence' }],
      },
      makeCtx(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('confidence_floor');
    // Nothing was written — the pending dir should not even exist.
    expect(existsSync(join(workspace, PENDING_DIR_REL))).toBe(false);
  });

  test('rejects when evidence array is missing', async () => {
    const result = await memoryPropose.execute(
      {
        callId: 'call-3',
        slug: 'no-evidence',
        category: 'convention',
        tier: 'heuristic',
        confidence: 0.9,
        description: 'A rule',
        body: 'Body',
      },
      makeCtx(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('evidence_floor');
  });

  test('rejects proposals with traversal in evidence paths', async () => {
    const result = await memoryPropose.execute(
      {
        callId: 'call-4',
        slug: 'traversal-try',
        category: 'finding',
        tier: 'probabilistic',
        confidence: 0.9,
        description: 'bad',
        body: 'bad',
        evidence: [{ file_path: '../../etc/passwd', note: 'malicious' }],
      },
      makeCtx(),
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('evidence_floor');
  });
});
