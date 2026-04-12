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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AmbiguousProposalError,
  approveProposal,
  CONFIDENCE_FLOOR,
  countPendingProposals,
  LEARNED_FILE_REL,
  type LearnedEntry,
  listPendingProposals,
  MAX_PROPOSAL_SIZE,
  type MemoryProposal,
  parseLearnedMdEntries,
  parseProposalFile,
  PENDING_DIR_REL,
  REJECTED_DIR_REL,
  rejectProposal,
  resolveProposalBySlug,
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
    body: '## Rule\n\nAll tests use `bun:test`, not `vitest` or `jest`.\n\n## Rationale\n\nThe repo is a Bun project.',
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
    const out = serializeProposal(makeValidProposal({ applyTo: ['src/**/*.ts', 'tests/**/*.test.ts'] }));
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
    expect(() => writeProposal(workspace, makeValidProposal({ confidence: 0.5 }))).toThrow(/confidence_floor/);
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

// ── countPendingProposals (Phase 3d) ────────────────────────────────

describe('countPendingProposals', () => {
  test('returns 0 when the pending directory does not exist', () => {
    // Fresh workspace — `.vinyan/memory/pending/` has not been created yet.
    expect(countPendingProposals(workspace)).toBe(0);
  });

  test('returns 0 when the pending directory exists but is empty', () => {
    // Create the directory without any proposals — common transient state
    // right after a proposal is approved and the last pending file is
    // unlinked.
    mkdirSync(join(workspace, PENDING_DIR_REL), { recursive: true });
    expect(countPendingProposals(workspace)).toBe(0);
  });

  test('counts only .md files — ignores other extensions and subdirs', () => {
    // Seed the real file, then drop some non-markdown noise that must not
    // be counted. This guards against drift between listPendingProposals
    // (which only returns .md entries) and countPendingProposals.
    writeProposal(workspace, makeValidProposal({ slug: 'real-proposal' }));
    const pendingDir = join(workspace, PENDING_DIR_REL);
    writeFileSync(join(pendingDir, 'README.txt'), 'just a note');
    writeFileSync(join(pendingDir, 'scratch.json'), '{}');
    mkdirSync(join(pendingDir, 'subdir'), { recursive: true });

    expect(countPendingProposals(workspace)).toBe(1);
    // listPendingProposals must stay in lockstep with countPendingProposals.
    expect(listPendingProposals(workspace).length).toBe(1);
  });

  test('returns N when N proposals are present', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rule-one' }));
    writeProposal(workspace, makeValidProposal({ slug: 'rule-two' }));
    writeProposal(workspace, makeValidProposal({ slug: 'rule-three' }));
    expect(countPendingProposals(workspace)).toBe(3);
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
        evidence: [{ file_path: 'package.json', note: 'Bun listed as runtime' }],
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

// ── parseProposalFile ───────────────────────────────────────────────

describe('parseProposalFile', () => {
  test('round-trips the fields emitted by serializeProposal', () => {
    const proposal = makeValidProposal({
      description: 'Keep tests in bun:test — never mix jest.',
      applyTo: ['tests/**/*.test.ts', 'src/**/*.spec.ts'],
    });
    const serialized = serializeProposal(proposal);
    const parsed = parseProposalFile(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.proposedBy).toBe(proposal.proposedBy);
    expect(parsed!.sessionId).toBe(proposal.sessionId);
    expect(parsed!.category).toBe(proposal.category);
    expect(parsed!.tier).toBe(proposal.tier);
    expect(parsed!.confidence).toBe(proposal.confidence);
    expect(parsed!.description).toBe(proposal.description);
    expect(parsed!.applyTo).toEqual(proposal.applyTo!);
    // Body is recoverable even though it lives below the frontmatter.
    expect(parsed!.body).toContain('## Rule');
    expect(parsed!.body).toContain('`bun:test`');
  });

  test('returns null for content without frontmatter', () => {
    expect(parseProposalFile('just plain markdown\n\n# hi')).toBeNull();
  });

  test('returns null for content with unterminated frontmatter', () => {
    expect(parseProposalFile('---\nslug: "x"\nno closing marker')).toBeNull();
  });

  test('decodes escaped newlines, quotes, and backslashes', () => {
    // Simulate what `yamlString` produces for edgy content.
    const content = [
      '---',
      'proposedBy: "worker-1"',
      'proposedAt: "2026-04-12T00:00:00.000Z"',
      'sessionId: "abc"',
      'category: convention',
      'tier: heuristic',
      'confidence: 0.9',
      'description: "has \\"quotes\\" and \\n newlines"',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseProposalFile(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.description).toBe('has "quotes" and \n newlines');
  });
});

// ── resolveProposalBySlug ───────────────────────────────────────────

describe('resolveProposalBySlug', () => {
  test('resolves by bare slug when exactly one match exists', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'lonely-rule' }));
    const result = resolveProposalBySlug(workspace, 'lonely-rule');
    expect(result.filename).toContain('lonely-rule');
  });

  test('resolves by slug with .md suffix', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rule-md' }));
    const result = resolveProposalBySlug(workspace, 'rule-md.md');
    expect(result.filename).toContain('rule-md');
  });

  test('resolves by full filename', () => {
    const write = writeProposal(workspace, makeValidProposal({ slug: 'full-fn' }));
    const filename = write.path.split('/').pop()!;
    const result = resolveProposalBySlug(workspace, filename);
    expect(result.filename).toBe(filename);
  });

  test('throws clean error when no pending files exist', () => {
    expect(() => resolveProposalBySlug(workspace, 'anything')).toThrow(/no pending proposals/);
  });

  test('throws not-found error when slug does not match', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'real-rule' }));
    expect(() => resolveProposalBySlug(workspace, 'ghost-rule')).toThrow(/no pending proposal matching/);
  });

  test('throws AmbiguousProposalError when multiple pending files share a slug', async () => {
    // Need different filenames — same slug, different timestamps.
    writeProposal(workspace, makeValidProposal({ slug: 'twin-rule' }));
    // Bump the clock by a millisecond so the second filename differs.
    await new Promise((r) => setTimeout(r, 5));
    writeProposal(workspace, makeValidProposal({ slug: 'twin-rule' }));

    let thrown: unknown = null;
    try {
      resolveProposalBySlug(workspace, 'twin-rule');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AmbiguousProposalError);
    expect((thrown as AmbiguousProposalError).candidates.length).toBe(2);
    expect((thrown as AmbiguousProposalError).candidates[0]).toContain('twin-rule');
  });
});

// ── approveProposal ─────────────────────────────────────────────────

describe('approveProposal', () => {
  test('creates learned.md and appends the rendered block', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'first-rule' }));
    const result = approveProposal(workspace, 'first-rule', 'alice');

    expect(existsSync(result.learnedPath)).toBe(true);
    const learned = readFileSync(result.learnedPath, 'utf-8');
    expect(learned).toContain('## first-rule (convention)');
    expect(learned).toContain('confidence=0.85');
    expect(learned).toContain('approvedBy=alice');
    expect(learned).toContain('vinyan-memory-entry');
    // The pending file was removed.
    expect(existsSync(join(workspace, PENDING_DIR_REL, result.consumedPending))).toBe(false);
  });

  test('appends subsequent approvals as distinct blocks', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rule-a' }));
    approveProposal(workspace, 'rule-a', 'alice');

    writeProposal(workspace, makeValidProposal({ slug: 'rule-b', description: 'Rule B text' }));
    const second = approveProposal(workspace, 'rule-b', 'alice');

    const learned = readFileSync(second.learnedPath, 'utf-8');
    expect(learned).toContain('## rule-a (convention)');
    expect(learned).toContain('## rule-b (convention)');
    expect(learned).toContain('Rule B text');
    // Two vinyan-memory-entry markers — one per approved proposal.
    const markers = learned.match(/vinyan-memory-entry/g) ?? [];
    expect(markers.length).toBe(2);
  });

  test('includes applyTo line in the rendered block when present', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'scoped', applyTo: ['src/**/*.ts'] }));
    const result = approveProposal(workspace, 'scoped', 'alice');
    expect(result.appendedBlock).toContain('**Applies to**: src/**/*.ts');
  });

  test('throws when the slug cannot be resolved', () => {
    expect(() => approveProposal(workspace, 'does-not-exist', 'alice')).toThrow(/no pending proposals/);
  });

  test('escapes reviewer name so HTML comment stays safe', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'escape-test' }));
    const result = approveProposal(workspace, 'escape-test', 'alice <script>');
    // `<` and `>` are stripped by escapeCommentValue so the HTML comment
    // cannot accidentally close or include a tag.
    expect(result.appendedBlock).not.toContain('<script>');
    expect(result.appendedBlock).toContain('approvedBy=alice script');
  });

  test('writes a header comment when learned.md is created fresh', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'fresh-file' }));
    const result = approveProposal(workspace, 'fresh-file', 'alice');
    const learned = readFileSync(result.learnedPath, 'utf-8');
    expect(learned).toContain('Vinyan M4 learned conventions');
  });

  test('learned.md is at the correct workspace path', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'path-check' }));
    const result = approveProposal(workspace, 'path-check', 'alice');
    expect(result.learnedPath).toContain(LEARNED_FILE_REL);
  });
});

// ── rejectProposal ──────────────────────────────────────────────────

describe('rejectProposal', () => {
  test('moves pending file to rejected/ and prepends a rejection header', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'bad-idea' }));
    const result = rejectProposal(workspace, 'bad-idea', 'alice', 'not actually a convention');

    expect(result.rejectedPath).toContain(REJECTED_DIR_REL);
    expect(existsSync(result.rejectedPath)).toBe(true);

    const archived = readFileSync(result.rejectedPath, 'utf-8');
    expect(archived).toContain('vinyan-memory-rejected');
    expect(archived).toContain('by="alice"');
    expect(archived).toContain('not actually a convention');
    // Original content is preserved below the header.
    expect(archived).toContain('category: convention');
    expect(archived).toContain('## Rule');

    // The pending file is gone.
    expect(existsSync(join(workspace, PENDING_DIR_REL, result.consumedPending))).toBe(false);
  });

  test('learned.md is NOT touched by a rejection', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'rejected-one' }));
    rejectProposal(workspace, 'rejected-one', 'alice', 'no evidence');
    expect(existsSync(join(workspace, LEARNED_FILE_REL))).toBe(false);
  });

  test('escapes malicious reason text so HTML comment stays safe', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'reason-escape' }));
    const result = rejectProposal(
      workspace,
      'reason-escape',
      'alice',
      'contains --> comment-breaker and <tag> injection',
    );
    const archived = readFileSync(result.rejectedPath, 'utf-8');
    // The rejection header is a single HTML comment. Extract its reason field
    // and assert the injection sequences are gone from the reason text itself —
    // the legitimate closing `-->` of the comment is still present by design.
    const reasonMatch = archived.match(/reason="([^"]*)"/);
    expect(reasonMatch).not.toBeNull();
    const reason = reasonMatch![1]!;
    expect(reason).not.toContain('-->');
    expect(reason).not.toContain('<tag>');
    // `--+` runs collapse to en-dash (U+2013).
    expect(reason).toContain('–');
    // And the header still closes cleanly.
    expect(archived).toMatch(/vinyan-memory-rejected:[^\n]*-->/);
  });

  test('throws when slug does not match any pending file', () => {
    writeProposal(workspace, makeValidProposal({ slug: 'real' }));
    expect(() => rejectProposal(workspace, 'fake', 'alice', 'nope')).toThrow(/no pending proposal matching/);
    // Real pending file should still be there.
    const pending = listPendingProposals(workspace);
    expect(pending.length).toBe(1);
  });

  test('rejected directory is created lazily on first rejection', () => {
    expect(existsSync(join(workspace, REJECTED_DIR_REL))).toBe(false);
    writeProposal(workspace, makeValidProposal({ slug: 'lazy-dir' }));
    rejectProposal(workspace, 'lazy-dir', 'alice', 'reason');
    expect(existsSync(join(workspace, REJECTED_DIR_REL))).toBe(true);
    const entries = readdirSync(join(workspace, REJECTED_DIR_REL));
    expect(entries.length).toBe(1);
  });
});

// ── parseLearnedMdEntries (Phase 4 structured reader) ───────────────

describe('parseLearnedMdEntries', () => {
  test('returns empty array on empty input', () => {
    expect(parseLearnedMdEntries('')).toEqual([]);
  });

  test('returns empty array when no entry markers present (hand-authored file)', () => {
    // A plain hand-authored learned.md. Must be treated as opaque by the
    // caller so backwards compat is preserved.
    const content = `<!-- Vinyan M4 learned conventions. -->

## Always use semicolons

This is a hand-authored rule without the approval metadata comment.
`;
    expect(parseLearnedMdEntries(content)).toEqual([]);
  });

  test('parses a single approved entry end-to-end', () => {
    // Match the exact shape emitted by approveProposal → renderApprovedBlock:
    //   <!-- vinyan-memory-entry: slug=..., category=..., tier=..., confidence=..., proposedBy=..., approvedBy=..., approvedAt=... -->
    //   ## <slug> (<category>)
    //
    //   **Summary**: <description>
    //   **Applies to**: <globs>
    //
    //   <body>
    writeProposal(
      workspace,
      makeValidProposal({
        slug: 'prefer-bun',
        applyTo: ['tests/**/*.ts', 'src/**/*.test.ts'],
        description: 'Use bun:test everywhere in this repo.',
      }),
    );
    approveProposal(workspace, 'prefer-bun', 'alice');

    const learned = readFileSync(join(workspace, LEARNED_FILE_REL), 'utf-8');
    const entries = parseLearnedMdEntries(learned);
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.slug).toBe('prefer-bun');
    expect(entry.category).toBe('convention');
    expect(entry.tier).toBe('heuristic');
    expect(entry.confidence).toBeCloseTo(0.85, 5);
    expect(entry.proposedBy).toBe('worker-42');
    expect(entry.approvedBy).toBe('alice');
    expect(entry.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.description).toBe('Use bun:test everywhere in this repo.');
    expect(entry.applyTo).toEqual(['tests/**/*.ts', 'src/**/*.test.ts']);
    // Body retains the heading + summary + applies-to + rule text so
    // downstream consumers can render the entry as-is in debug dumps.
    expect(entry.body).toContain('## prefer-bun (convention)');
    expect(entry.body).toContain('**Summary**: Use bun:test everywhere in this repo.');
    expect(entry.body).toContain('## Rule');
    expect(entry.body).toContain('bun:test');
  });

  test('parses multiple approved entries preserving approval order', () => {
    // Approve three proposals in sequence. Each one is appended to learned.md
    // with a fresh entry marker, so the parser must find all three in order.
    writeProposal(workspace, makeValidProposal({ slug: 'rule-one', description: 'First rule.' }));
    approveProposal(workspace, 'rule-one', 'alice');

    writeProposal(workspace, makeValidProposal({ slug: 'rule-two', description: 'Second rule.' }));
    approveProposal(workspace, 'rule-two', 'bob');

    writeProposal(workspace, makeValidProposal({ slug: 'rule-three', description: 'Third rule.' }));
    approveProposal(workspace, 'rule-three', 'carol');

    const learned = readFileSync(join(workspace, LEARNED_FILE_REL), 'utf-8');
    const entries = parseLearnedMdEntries(learned);
    expect(entries.map((e) => e.slug)).toEqual(['rule-one', 'rule-two', 'rule-three']);
    expect(entries.map((e) => e.approvedBy)).toEqual(['alice', 'bob', 'carol']);
    expect(entries.map((e) => e.description)).toEqual(['First rule.', 'Second rule.', 'Third rule.']);
  });

  test('extracts applyTo list correctly across different proposal shapes', () => {
    // Proposal with no applyTo → entry.applyTo is empty (always-active rule).
    writeProposal(workspace, makeValidProposal({ slug: 'always-on', applyTo: undefined }));
    approveProposal(workspace, 'always-on', 'alice');

    // Proposal with a single glob.
    writeProposal(workspace, makeValidProposal({ slug: 'single-glob', applyTo: ['src/api/**'] }));
    approveProposal(workspace, 'single-glob', 'alice');

    // Proposal with several globs — must all be preserved.
    writeProposal(
      workspace,
      makeValidProposal({
        slug: 'multi-glob',
        applyTo: ['src/api/**', 'src/routes/**', 'tests/api/**'],
      }),
    );
    approveProposal(workspace, 'multi-glob', 'alice');

    const learned = readFileSync(join(workspace, LEARNED_FILE_REL), 'utf-8');
    const entries = parseLearnedMdEntries(learned);
    expect(entries).toHaveLength(3);

    const byS = (s: string): LearnedEntry => entries.find((e) => e.slug === s)!;
    expect(byS('always-on').applyTo).toEqual([]);
    expect(byS('single-glob').applyTo).toEqual(['src/api/**']);
    expect(byS('multi-glob').applyTo).toEqual(['src/api/**', 'src/routes/**', 'tests/api/**']);
  });

  test('is robust to entries with no body below the metadata', () => {
    // A minimally-viable entry: marker + heading only. Still valid — the
    // parser should return it without crashing and the body should contain
    // at least the heading.
    const content = `<!-- vinyan-memory-entry: slug=bare-entry, category=finding, tier=heuristic, confidence=0.75, proposedBy=bot, approvedBy=alice, approvedAt=2026-01-01T00:00:00.000Z -->
## bare-entry (finding)
`;
    const entries = parseLearnedMdEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe('bare-entry');
    expect(entries[0]!.description).toBe('');
    expect(entries[0]!.applyTo).toEqual([]);
    expect(entries[0]!.body).toContain('## bare-entry (finding)');
  });

  test('tolerates whitespace and blank lines between entries', () => {
    // Real approveProposal output uses blank-line separation. The parser
    // must not lose either entry when they are separated by multiple blank
    // lines, indentation-free body text, or trailing newlines.
    const content = `<!-- Vinyan M4 learned conventions. Agent-proposed, human-approved. -->

<!-- vinyan-memory-entry: slug=alpha, category=convention, tier=heuristic, confidence=0.90, proposedBy=worker-1, approvedBy=alice, approvedAt=2026-01-01T00:00:00.000Z -->
## alpha (convention)

**Summary**: Alpha rule.

Body of alpha.


<!-- vinyan-memory-entry: slug=beta, category=finding, tier=deterministic, confidence=0.95, proposedBy=worker-2, approvedBy=alice, approvedAt=2026-01-02T00:00:00.000Z -->
## beta (finding)

**Summary**: Beta rule.
**Applies to**: src/**/*.ts

Body of beta.
`;
    const entries = parseLearnedMdEntries(content);
    expect(entries.map((e) => e.slug)).toEqual(['alpha', 'beta']);
    expect(entries[0]!.tier).toBe('heuristic');
    expect(entries[1]!.tier).toBe('deterministic');
    expect(entries[1]!.applyTo).toEqual(['src/**/*.ts']);
  });

  test('does NOT treat a marker lookalike inside a body as a new entry', () => {
    // A rule body that merely *describes* the marker format (e.g. in
    // documentation) must not fake a new entry. The marker must appear at
    // line start to count. Here we indent the lookalike so the anchored
    // regex misses it.
    const content = `<!-- vinyan-memory-entry: slug=only-one, category=finding, tier=heuristic, confidence=0.8, proposedBy=w, approvedBy=a, approvedAt=2026-01-01T00:00:00.000Z -->
## only-one (finding)

**Summary**: Only one entry expected.

Some body text that mentions the marker in an indented code block:

    <!-- vinyan-memory-entry: slug=fake, category=finding, tier=heuristic, confidence=0.8, proposedBy=x, approvedBy=y, approvedAt=2026-01-01T00:00:00.000Z -->

End of body.
`;
    const entries = parseLearnedMdEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.slug).toBe('only-one');
  });

  test('skips malformed entries (missing closing --> or empty slug)', () => {
    // A dangling marker with no closing `-->` is dropped silently, but
    // subsequent well-formed entries must still be returned.
    const content = `<!-- vinyan-memory-entry: slug=, category=finding, tier=heuristic, confidence=0.8, proposedBy=w, approvedBy=a, approvedAt=2026-01-01T00:00:00.000Z -->
## (finding)

<!-- vinyan-memory-entry: slug=good, category=finding, tier=heuristic, confidence=0.8, proposedBy=w, approvedBy=a, approvedAt=2026-01-01T00:00:00.000Z -->
## good (finding)

**Summary**: Valid entry.
`;
    const entries = parseLearnedMdEntries(content);
    // Empty-slug entry is rejected; good entry is kept.
    expect(entries.map((e) => e.slug)).toEqual(['good']);
  });

  test('round-trips a real approved entry through approveProposal', () => {
    // Belt-and-suspenders: start from a real proposal, approve it via the
    // normal flow, then parse the learned.md that approval produced. The
    // extracted metadata must exactly match the proposal inputs.
    const proposal = makeValidProposal({
      slug: 'round-trip',
      tier: 'deterministic',
      confidence: 0.92,
      description: 'A round-tripped rule.',
      applyTo: ['src/core/**', '*.ts'],
    });
    writeProposal(workspace, proposal);
    approveProposal(workspace, 'round-trip', 'alice');

    const learned = readFileSync(join(workspace, LEARNED_FILE_REL), 'utf-8');
    const entries = parseLearnedMdEntries(learned);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.slug).toBe('round-trip');
    expect(entry.tier).toBe('deterministic');
    expect(entry.confidence).toBeCloseTo(0.92, 5);
    expect(entry.description).toBe('A round-tripped rule.');
    expect(entry.applyTo).toEqual(['src/core/**', '*.ts']);
    expect(entry.proposedBy).toBe('worker-42');
    expect(entry.approvedBy).toBe('alice');
  });
});
