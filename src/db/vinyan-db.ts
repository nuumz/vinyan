/**
 * VinyanDB — shared SQLite database for trace storage and model parameters.
 *
 * Follows world-graph/world-graph.ts pattern: WAL mode, foreign keys, schema exec.
 * Path: <workspace>/.vinyan/vinyan.db
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { TRACE_SCHEMA_SQL, MODEL_PARAMS_SCHEMA_SQL } from "./trace-schema.ts";
import { PATTERN_SCHEMA_SQL } from "./pattern-schema.ts";
import { SHADOW_SCHEMA_SQL } from "./shadow-schema.ts";
import { SKILL_SCHEMA_SQL } from "./skill-schema.ts";
import { RULE_SCHEMA_SQL } from "./rule-schema.ts";

export class VinyanDB {
  private db: Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(TRACE_SCHEMA_SQL);
    this.db.exec(MODEL_PARAMS_SCHEMA_SQL);
    this.db.exec(PATTERN_SCHEMA_SQL);
    this.db.exec(SHADOW_SCHEMA_SQL);
    this.db.exec(SKILL_SCHEMA_SQL);
    this.db.exec(RULE_SCHEMA_SQL);
  }

  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
