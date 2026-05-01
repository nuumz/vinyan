/**
 * Migration 026 — Memory Wiki / Second Brain substrate.
 *
 * Six tables + one FTS5 virtual table. Backing store for
 * `src/memory/wiki/` — the compiled knowledge layer modelled after the
 * LLM Wiki pattern.
 *
 * Design anchor: `docs/design/llm-memory-wiki-system-design.md` §5.
 *
 * Tables:
 *   memory_wiki_sources      — immutable raw source records (A4)
 *   memory_wiki_pages        — compiled wiki pages (validated writes only)
 *   memory_wiki_edges        — typed graph edges parsed from [[wikilinks]]
 *   memory_wiki_claims       — page-scoped sourced assertions
 *   memory_wiki_operations   — append-only op log (A8)
 *   memory_wiki_lint_findings — lint results (referenced by sleep-cycle)
 *
 * The FTS5 virtual table is kept in sync via triggers so retrieval can
 * BM25-rank by title/body/tags without re-indexing the base table.
 */
import type { Database } from 'bun:sqlite';
import type { Migration } from './migration-runner.ts';

export const migration026: Migration = {
  version: 26,
  description: 'Memory Wiki — sources, pages, edges, claims, operations, lint findings',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_wiki_sources (
        id            TEXT PRIMARY KEY,
        profile       TEXT NOT NULL DEFAULT 'default',
        kind          TEXT NOT NULL
                        CHECK(kind IN ('session','trace','user-note','web-capture','coding-cli-run','verification','approval')),
        content_hash  TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        session_id    TEXT,
        task_id       TEXT,
        agent_id      TEXT,
        user_id       TEXT,
        body          TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mwsrc_profile_kind  ON memory_wiki_sources(profile, kind);
      CREATE INDEX IF NOT EXISTS idx_mwsrc_content_hash  ON memory_wiki_sources(content_hash);
      CREATE INDEX IF NOT EXISTS idx_mwsrc_session       ON memory_wiki_sources(session_id) WHERE session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mwsrc_task          ON memory_wiki_sources(task_id) WHERE task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS memory_wiki_pages (
        id              TEXT PRIMARY KEY,
        profile         TEXT NOT NULL DEFAULT 'default',
        type            TEXT NOT NULL
                          CHECK(type IN ('concept','entity','project','decision','failure-pattern',
                                         'workflow-pattern','source-summary','task-memory',
                                         'agent-profile','open-question')),
        title           TEXT NOT NULL,
        aliases_json    TEXT NOT NULL DEFAULT '[]',
        tags_json       TEXT NOT NULL DEFAULT '[]',
        body            TEXT NOT NULL,
        evidence_tier   TEXT NOT NULL
                          CHECK(evidence_tier IN ('deterministic','heuristic','pragmatic','probabilistic','speculative')),
        confidence      REAL NOT NULL,
        lifecycle       TEXT NOT NULL
                          CHECK(lifecycle IN ('draft','canonical','stale','disputed','archived')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        valid_until     INTEGER,
        protected_json  TEXT NOT NULL DEFAULT '[]',
        body_hash       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mwpage_profile_type      ON memory_wiki_pages(profile, type);
      CREATE INDEX IF NOT EXISTS idx_mwpage_profile_lifecycle ON memory_wiki_pages(profile, lifecycle);
      CREATE INDEX IF NOT EXISTS idx_mwpage_updated           ON memory_wiki_pages(updated_at);

      CREATE TABLE IF NOT EXISTS memory_wiki_edges (
        from_id    TEXT NOT NULL,
        to_id      TEXT NOT NULL,
        edge_type  TEXT NOT NULL DEFAULT 'mentions'
                     CHECK(edge_type IN ('mentions','cites','supersedes','contradicts',
                                         'derived-from','implements','belongs-to')),
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id, edge_type)
      );
      CREATE INDEX IF NOT EXISTS idx_mwedge_to ON memory_wiki_edges(to_id);

      CREATE TABLE IF NOT EXISTS memory_wiki_claims (
        id             TEXT PRIMARY KEY,
        page_id        TEXT NOT NULL,
        text           TEXT NOT NULL,
        source_ids     TEXT NOT NULL DEFAULT '[]',
        evidence_tier  TEXT NOT NULL,
        confidence     REAL NOT NULL,
        created_at     INTEGER NOT NULL,
        FOREIGN KEY (page_id) REFERENCES memory_wiki_pages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mwclaim_page ON memory_wiki_claims(page_id);

      CREATE TABLE IF NOT EXISTS memory_wiki_operations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        op           TEXT NOT NULL
                       CHECK(op IN ('ingest','propose','write','reject','stale',
                                    'promote','demote','lint','archive','restore')),
        page_id      TEXT,
        source_id    TEXT,
        actor        TEXT NOT NULL,
        reason       TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mwop_ts        ON memory_wiki_operations(ts);
      CREATE INDEX IF NOT EXISTS idx_mwop_page      ON memory_wiki_operations(page_id) WHERE page_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mwop_op        ON memory_wiki_operations(op);

      CREATE TABLE IF NOT EXISTS memory_wiki_lint_findings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        code         TEXT NOT NULL,
        severity     TEXT NOT NULL
                       CHECK(severity IN ('error','warn','info')),
        page_id      TEXT,
        detail       TEXT,
        resolved_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mwlint_code ON memory_wiki_lint_findings(code);
      CREATE INDEX IF NOT EXISTS idx_mwlint_open ON memory_wiki_lint_findings(ts) WHERE resolved_at IS NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_wiki_pages_fts USING fts5(
        id UNINDEXED,
        profile UNINDEXED,
        type UNINDEXED,
        title,
        body,
        tags,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS mwpage_ai AFTER INSERT ON memory_wiki_pages BEGIN
        INSERT INTO memory_wiki_pages_fts (id, profile, type, title, body, tags)
        VALUES (new.id, new.profile, new.type, new.title, new.body, new.tags_json);
      END;

      CREATE TRIGGER IF NOT EXISTS mwpage_ad AFTER DELETE ON memory_wiki_pages BEGIN
        DELETE FROM memory_wiki_pages_fts WHERE id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS mwpage_au AFTER UPDATE ON memory_wiki_pages BEGIN
        UPDATE memory_wiki_pages_fts
           SET profile = new.profile,
               type    = new.type,
               title   = new.title,
               body    = new.body,
               tags    = new.tags_json
         WHERE id = old.id;
      END;
    `);
  },
};
