/**
 * vinyan clean — database maintenance.
 *
 * Usage:
 *   vinyan clean                       VACUUM + WAL checkpoint
 *   vinyan clean --purge-before 30     Delete traces/sessions older than N days
 */

import { join } from 'path';
import { VinyanDB } from '../db/vinyan-db.ts';

export async function runCleanCommand(argv: string[]): Promise<void> {
  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();
  const purgeDays = parseInt(parseSingleFlag(argv, '--purge-before') ?? '0', 10);

  const dbPath = join(workspace, '.vinyan', 'vinyan.db');
  let db: VinyanDB;
  try {
    db = new VinyanDB(dbPath);
  } catch {
    console.error('Database not found.');
    process.exit(1);
    return;
  }

  const rawDb = db.getDb();

  try {
    // Purge old data if requested
    if (purgeDays > 0) {
      const cutoff = Date.now() - purgeDays * 24 * 60 * 60 * 1000;
      const tracesDeleted = rawDb.query('DELETE FROM traces WHERE timestamp < ?').run(cutoff);
      const sessionsDeleted = rawDb.query("DELETE FROM sessions WHERE created_at < ? AND status = 'suspended'").run(cutoff);
      console.log(`Purged data older than ${purgeDays} days:`);
      console.log(`  Traces:   ${(tracesDeleted as { changes: number }).changes} deleted`);
      console.log(`  Sessions: ${(sessionsDeleted as { changes: number }).changes} deleted`);
    }

    // WAL checkpoint
    try {
      rawDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      console.log('WAL checkpoint: done');
    } catch {
      console.log('WAL checkpoint: skipped (not in WAL mode)');
    }

    // VACUUM
    rawDb.exec('VACUUM');
    console.log('VACUUM: done');

    // Show DB size
    const { statSync } = await import('fs');
    const stats = statSync(dbPath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`Database size: ${sizeMB} MB`);
  } finally {
    db.close();
  }
}

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
