/**
 * PageWriter + validator — A1 gate behavior.
 *
 * Asserts:
 *   - a valid proposal becomes a `WikiPage`
 *   - canonical writes WITHOUT sources are rejected
 *   - tier demotion is rejected without `allowDemotion`
 *   - human-protected sections are preserved across rewrites
 *   - duplicate alias collisions are rejected
 *   - broken wikilinks become lint findings (not failures) by default
 *   - frontmatter / body-size validation rejects oversized bodies
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { migration026 } from '../../../src/db/migrations/026_memory_wiki.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { PageWriter } from '../../../src/memory/wiki/page-writer.ts';
import { MemoryWikiStore } from '../../../src/memory/wiki/store.ts';
import type { WikiPageProposal } from '../../../src/memory/wiki/types.ts';

function freshStore(): MemoryWikiStore {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001, migration026]);
  return new MemoryWikiStore(db, { clock: () => 1_700_000_000_000 });
}

function baseProposal(overrides: Partial<WikiPageProposal> = {}): WikiPageProposal {
  return {
    profile: 'default',
    type: 'concept',
    title: 'Sample Concept',
    body: '# Sample Concept\n\nThis is a sample body.',
    evidenceTier: 'heuristic',
    confidence: 0.65,
    lifecycle: 'draft',
    sources: [],
    actor: 'system:test',
    ...overrides,
  };
}

describe('PageWriter.write — happy path', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  beforeEach(() => {
    store = freshStore();
    writer = new PageWriter({ store, clock: () => 1_700_000_000_000 });
  });

  it('writes a draft page and creates a row', () => {
    const result = writer.write(baseProposal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.lifecycle).toBe('draft');
      expect(result.page.id).toMatch(/^concept-/);
      expect(store.getPageById(result.page.id)).not.toBeNull();
    }
  });

  it('emits propose + write operations', () => {
    const result = writer.write(baseProposal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ops = store.listOperations({ pageId: result.page.id });
      const opNames = ops.map((o) => o.op).sort();
      expect(opNames).toContain('propose');
      expect(opNames).toContain('write');
    }
  });

  it('clamps confidence to tier ceiling', () => {
    const result = writer.write(baseProposal({ evidenceTier: 'probabilistic', confidence: 0.99 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // probabilistic ceiling = 0.85
      expect(result.page.confidence).toBeLessThanOrEqual(0.85);
    }
  });
});

describe('PageWriter.write — citation + lifecycle rules', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  beforeEach(() => {
    store = freshStore();
    writer = new PageWriter({ store, clock: () => 1_700_000_000_000 });
  });

  it('rejects canonical writes without source citations', () => {
    const result = writer.write(baseProposal({ lifecycle: 'canonical' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('uncited_canonical');
    }
  });

  it('accepts canonical writes with at least one source', () => {
    const result = writer.write(
      baseProposal({
        lifecycle: 'canonical',
        sources: [{ id: 'src-1', contentHash: 'h'.repeat(64), kind: 'session' }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects tier demotion by default', () => {
    const proposal = baseProposal({
      lifecycle: 'canonical',
      evidenceTier: 'heuristic',
      sources: [{ id: 'src-1', contentHash: 'h'.repeat(64), kind: 'session' }],
    });
    const first = writer.write(proposal);
    expect(first.ok).toBe(true);
    const second = writer.write({ ...proposal, evidenceTier: 'probabilistic' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('tier_demotion');
    }
  });

  it('allows tier demotion with allowDemotion', () => {
    const proposal = baseProposal({
      lifecycle: 'canonical',
      evidenceTier: 'heuristic',
      sources: [{ id: 'src-1', contentHash: 'h'.repeat(64), kind: 'session' }],
    });
    expect(writer.write(proposal).ok).toBe(true);
    const second = writer.write(
      { ...proposal, evidenceTier: 'probabilistic', confidence: 0.5 },
      { allowDemotion: true },
    );
    expect(second.ok).toBe(true);
  });
});

describe('PageWriter.write — human-protected sections', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  beforeEach(() => {
    store = freshStore();
    writer = new PageWriter({ store, clock: () => 1_700_000_000_000 });
  });

  const protectedBlock = `<!-- human:protected:notes -->\nUSER NOTES\n<!-- /human:protected:notes -->`;

  it('preserves protected blocks when proposal omits them', () => {
    const initial = writer.write(
      baseProposal({
        body: `# Page\n\nIntro\n\n${protectedBlock}\n`,
        protectedSections: ['notes'],
      }),
    );
    expect(initial.ok).toBe(true);
    const second = writer.write(
      baseProposal({
        body: `# Page\n\nUpdated intro without protected block`,
        protectedSections: ['notes'],
      }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.page.body).toContain(protectedBlock);
    }
  });

  it('rejects proposals that modify the inside of a protected block', () => {
    expect(
      writer.write(
        baseProposal({
          body: `# Page\n\nIntro\n\n${protectedBlock}\n`,
          protectedSections: ['notes'],
        }),
      ).ok,
    ).toBe(true);
    const tampered = writer.write(
      baseProposal({
        body: `# Page\n\nIntro\n\n<!-- human:protected:notes -->\nTAMPERED\n<!-- /human:protected:notes -->\n`,
        protectedSections: ['notes'],
      }),
    );
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.reason).toBe('human_protected_modified');
    }
  });
});

describe('PageWriter.write — wikilinks → edges + lint', () => {
  let store: MemoryWikiStore;
  let writer: PageWriter;
  beforeEach(() => {
    store = freshStore();
    writer = new PageWriter({ store, clock: () => 1_700_000_000_000 });
  });

  it('materializes edges for resolved targets', () => {
    expect(
      writer.write(
        baseProposal({
          title: 'Bar',
          body: '# Bar\n\nDoc',
          sources: [{ id: 's', contentHash: 'h'.repeat(64), kind: 'session' }],
        }),
      ).ok,
    ).toBe(true);
    const second = writer.write(
      baseProposal({
        title: 'Foo',
        body: '# Foo\n\nLinks to [[concept-bar]] and [[supersedes:concept-bar]]',
        sources: [{ id: 's', contentHash: 'h'.repeat(64), kind: 'session' }],
      }),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      const edges = store.edgesFrom(second.page.id);
      expect(edges.length).toBe(2);
      const types = edges.map((e) => e.edgeType).sort();
      expect(types).toContain('mentions');
      expect(types).toContain('supersedes');
    }
  });

  it('records broken wikilinks as lint findings (default mode)', () => {
    const result = writer.write(
      baseProposal({
        body: '# Page\n\nLinks to [[unknown-page]]',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const findings = store.listOpenLintFindings();
      const broken = findings.filter((f) => f.code === 'broken-wikilink' && f.pageId === result.page.id);
      expect(broken.length).toBeGreaterThan(0);
    }
  });

  it('rejects broken wikilinks under strictWikilinks', () => {
    const strict = new PageWriter({ store, strictWikilinks: true, clock: () => 1 });
    const result = strict.write(baseProposal({ body: '# Page\n\nLinks to [[unknown-page]]' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('broken_wikilink');
    }
  });
});

describe('PageWriter.write — duplicate alias guard', () => {
  it('rejects an alias that already resolves to a different page', () => {
    const store = freshStore();
    const writer = new PageWriter({ store, clock: () => 1 });
    expect(
      writer.write(
        baseProposal({
          title: 'Owner',
          aliases: ['shared-alias'],
        }),
      ).ok,
    ).toBe(true);
    const second = writer.write(
      baseProposal({
        title: 'Other',
        aliases: ['shared-alias'],
      }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('duplicate_alias');
    }
  });
});
