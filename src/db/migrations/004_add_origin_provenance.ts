/**
 * Migration 004 — Add `origin` column to rules and skills tables.
 *
 * Tracks instance provenance for Phase 5 A2A multi-instance knowledge sharing.
 * Values: 'local' (default), 'a2a' (from peer instance), 'mcp' (from MCP tool).
 */
import type { Database } from "bun:sqlite";
import type { Migration } from "./migration-runner.ts";

export const migration004: Migration = {
  version: 4,
  description: "Add origin provenance to evolutionary_rules and cached_skills",
  up(db: Database): void {
    db.exec(`
      ALTER TABLE evolutionary_rules ADD COLUMN origin TEXT CHECK(origin IN ('local', 'a2a', 'mcp')) DEFAULT 'local';
    `);
    db.exec(`
      ALTER TABLE cached_skills ADD COLUMN origin TEXT CHECK(origin IN ('local', 'a2a', 'mcp')) DEFAULT 'local';
    `);
  },
};
