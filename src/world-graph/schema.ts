/**
 * SQLite schema for World Graph — architecture.md Decision 2.
 * Content-addressed facts with file hash binding and auto-invalidation.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS facts (
  id          TEXT PRIMARY KEY,
  target      TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  oracle_name TEXT NOT NULL,
  file_hash   TEXT NOT NULL,
  source_file TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  session_id  TEXT,
  confidence  REAL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_facts_target ON facts(target);
CREATE INDEX IF NOT EXISTS idx_facts_file_hash ON facts(file_hash);
CREATE INDEX IF NOT EXISTS idx_facts_source_file ON facts(source_file);

CREATE TABLE IF NOT EXISTS file_hashes (
  path         TEXT PRIMARY KEY,
  current_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS invalidate_facts_on_file_change
AFTER UPDATE OF current_hash ON file_hashes
BEGIN
  DELETE FROM facts WHERE source_file = NEW.path AND file_hash != NEW.current_hash;
END;

CREATE TABLE IF NOT EXISTS fact_evidence_files (
  fact_id   TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  PRIMARY KEY (fact_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_fef_file_path ON fact_evidence_files(file_path);

CREATE TRIGGER IF NOT EXISTS invalidate_facts_on_evidence_file_change
AFTER UPDATE OF current_hash ON file_hashes
BEGIN
  DELETE FROM facts WHERE id IN (
    SELECT fact_id FROM fact_evidence_files WHERE file_path = NEW.path
  ) AND source_file != NEW.path AND file_hash != NEW.current_hash;
END;
`;
