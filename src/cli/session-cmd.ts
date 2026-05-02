/**
 * vinyan session — manage conversation sessions.
 *
 * Subcommands:
 *   list           List all sessions
 *   delete <id>    Delete a session and its history
 *   export <id>    Export session as JSON to stdout
 */

import { join } from 'path';
import { SessionManager } from '../api/session-manager.ts';
import { resolveProfile } from '../config/profile-resolver.ts';
import { migration037 } from '../db/migrations/037_drop_session_turns.ts';
import { migration038 } from '../db/migrations/038_drop_session_store_blobs.ts';
import { MigrationRunner } from '../db/migrations/migration-runner.ts';
import { JsonlAppender } from '../db/session-jsonl/appender.ts';
import { backfillSessions, parseDuration } from '../db/session-jsonl/backfill.ts';
import { exportSession, importSession, readExport, writeExport } from '../db/session-jsonl/export.ts';
import { IndexRebuilder } from '../db/session-jsonl/rebuild-index.ts';
import { recoverStartup } from '../db/session-jsonl/recovery.ts';
import { tombstoneGc } from '../db/session-jsonl/tombstone.ts';
import { SessionStore } from '../db/session-store.ts';
import { VinyanDB } from '../db/vinyan-db.ts';

export async function runSessionCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'list';
  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();
  const dbPath = join(workspace, '.vinyan', 'vinyan.db');

  let db: VinyanDB;
  try {
    db = new VinyanDB(dbPath);
  } catch {
    console.error('Database not found. Run a task first to initialize the database.');
    process.exit(1);
  }

  const store = new SessionStore(db.getDb());
  const manager = new SessionManager(store);

  try {
    switch (sub) {
      case 'list': {
        const sessions = manager.listSessions();
        if (sessions.length === 0) {
          console.log('No sessions.');
          break;
        }
        console.log(`\n  Sessions (${sessions.length})\n`);
        for (const s of sessions) {
          const lifecycle = colorizeLifecycle(s.lifecycleState);
          const activity = colorizeActivity(s.activityState, s.runningTaskCount, s.taskCount);
          const date = new Date(s.updatedAt).toLocaleString();
          console.log(`  ${s.id}  ${lifecycle}  ${activity}  ${date}  source=${s.source}`);
        }
        console.log();
        break;
      }

      case 'delete': {
        const id = argv[1];
        if (!id) {
          console.error('Usage: vinyan session delete <session-id>');
          process.exit(1);
        }
        const session = manager.get(id);
        if (!session) {
          console.error(`Session not found: ${id}`);
          process.exit(1);
        }
        const rawDb = db.getDb();
        rawDb.query('DELETE FROM session_messages WHERE session_id = ?').run(id);
        rawDb.query('DELETE FROM session_tasks WHERE session_id = ?').run(id);
        rawDb.query('DELETE FROM sessions WHERE id = ?').run(id);
        console.log(`Deleted session: ${id}`);
        break;
      }

      case 'export': {
        const id = argv[1];
        if (!id) {
          console.error('Usage: vinyan session export <session-id>');
          process.exit(1);
        }
        const session = manager.get(id);
        if (!session) {
          console.error(`Session not found: ${id}`);
          process.exit(1);
        }
        const history = manager.getConversationHistoryText(id);
        console.log(JSON.stringify({ session, conversation: history }, null, 2));
        break;
      }

      case 'backfill': {
        // Phase 4 prereq: synthesize events.jsonl from existing SQLite
        // tables for sessions that don't have one yet. After this lands,
        // `migrate-phase4` can drop session_turns without losing turn
        // history.
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const sinceFlag = parseSingleFlag(argv, '--since');
        const dryRun = argv.includes('--dry-run');
        const sinceMs = sinceFlag !== undefined ? parseDuration(sinceFlag) : undefined;
        if (sinceFlag !== undefined && sinceMs === undefined) {
          console.error(`Invalid --since value: ${sinceFlag}. Expected like "30d", "48h", "45m", "60s".`);
          process.exit(1);
        }
        const appender = new JsonlAppender({ layout });
        const report = backfillSessions(db.getDb(), layout, appender, { sinceMs, dryRun });
        const tag = dryRun ? '[DRY RUN] ' : '';
        console.log(
          `${tag}Backfill complete: scanned=${report.scanned} backfilled=${report.backfilled} ` +
            `skipped-existing=${report.skippedExisting} skipped-too-old=${report.skippedTooOld} ` +
            `lines=${report.linesWritten}`,
        );
        break;
      }

      case 'migrate-phase4': {
        // Phase 4 destructive migration. Refuses to run if any session
        // still has session_turns rows that haven't been backfilled to
        // JSONL — operator must run `vinyan session backfill` first.
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const dryRun = argv.includes('--dry-run');
        const force = argv.includes('--force');
        const rawDb = db.getDb();
        const tableExists = (name: string): boolean =>
          rawDb.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) != null;

        // Preflight: every session_turns session must have a JSONL log
        // (or `--force` to skip). We implement the check by counting
        // session_store rows whose session_turns has rows and whose
        // events.jsonl is missing. session_turns may already be gone
        // from a partial run — if so the preflight is trivially OK.
        const unbackfilled: string[] = [];
        if (tableExists('session_turns')) {
          const sessions = rawDb.query<{ id: string }, []>(`SELECT DISTINCT session_id AS id FROM session_turns`).all();
          const reader = new (await import('../db/session-jsonl/reader.ts')).JsonlReader(layout);
          for (const row of sessions) {
            const lines = reader.scanAll(row.id).lines;
            if (lines.length === 0) unbackfilled.push(row.id);
          }
        }

        if (unbackfilled.length > 0 && !force) {
          console.error(
            `${unbackfilled.length} session(s) still have session_turns rows without an events.jsonl backfill. ` +
              `Run \`vinyan session backfill\` first (or pass --force to migrate anyway and discard their turn history).`,
          );
          console.error('First few:', unbackfilled.slice(0, 5).join(', '));
          process.exit(2);
        }
        if (unbackfilled.length > 0 && force) {
          console.warn(
            `[WARN] Migrating with ${unbackfilled.length} unbackfilled session(s) — their turn history will be lost.`,
          );
        }

        if (dryRun) {
          console.log(
            '[DRY RUN] Would apply migrations 037 (drop session_turns) and 038 (drop session_store blob columns).',
          );
          break;
        }

        const runner = new MigrationRunner();
        const result = runner.migrate(rawDb, [migration037, migration038]);
        console.log(`Phase 4 migrations applied: ${result.applied.join(', ') || '(already applied)'}`);
        break;
      }

      case 'export-bundle': {
        // Phase 5: dump every JSONL segment + manifest + snapshot for a
        // session into a single JSON file. Round-trips with `import-bundle`.
        const id = argv[1];
        const out = parseSingleFlag(argv, '--out');
        if (!id || !out) {
          console.error('Usage: vinyan session export-bundle <session-id> --out <path.json>');
          process.exit(1);
        }
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const bundle = exportSession(layout, id);
        writeExport(bundle, out);
        console.log(`Exported ${id}: ${bundle.segments.length} segment(s) → ${out}`);
        break;
      }

      case 'import-bundle': {
        // Phase 5: hydrate a session subdir from an export bundle and
        // rebuild its SQLite index. Refuses to clobber an existing
        // session unless --force is passed.
        const path = argv[1];
        if (!path) {
          console.error('Usage: vinyan session import-bundle <path.json> [--force]');
          process.exit(1);
        }
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const force = argv.includes('--force');
        const bundle = readExport(path);
        const { sessionId, segmentsWritten } = importSession(layout, bundle, {
          refuseOverwrite: !force,
        });
        new IndexRebuilder(db.getDb(), layout).rebuildSessionIndex(sessionId);
        console.log(`Imported ${sessionId}: ${segmentsWritten} segment(s); index rebuilt`);
        break;
      }

      case 'recover': {
        // Phase 5: scan every session, comparing session_store.last_line_offset
        // to active segment size. Rebuild any drifted session.
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const dryRun = argv.includes('--dry-run');
        const report = recoverStartup(db.getDb(), layout, { dryRun });
        const tag = dryRun ? '[DRY RUN] ' : '';
        console.log(
          `${tag}Recovery: scanned=${report.scanned} in-sync=${report.inSync} drifted=${report.drifted} missing-jsonl=${report.missingJsonl}`,
        );
        for (const entry of report.perSession) {
          if (entry.status === 'drifted') {
            console.log(`  ${entry.sessionId}  expected=${entry.expectedOffset}  actual=${entry.actualSize}`);
          }
        }
        break;
      }

      case 'tombstone': {
        const sub2 = argv[1];
        if (sub2 !== 'gc') {
          console.error('Usage: vinyan session tombstone gc [--older-than=90d] [--dry-run]');
          process.exit(1);
        }
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const olderThanFlag = parseSingleFlag(argv, '--older-than') ?? '90d';
        const olderThanMs = parseDuration(olderThanFlag);
        if (olderThanMs === undefined) {
          console.error(`Invalid --older-than value: ${olderThanFlag}`);
          process.exit(1);
        }
        const dryRun = argv.includes('--dry-run');
        const report = tombstoneGc(layout, { olderThanMs, dryRun });
        const tag = dryRun ? '[DRY RUN] ' : '';
        console.log(
          `${tag}Tombstone GC: scanned=${report.scanned} pruned=${report.pruned} retained=${report.retained}`,
        );
        if (report.pruned > 0) {
          console.log(`  Pruned: ${report.prunedIds.join(', ')}`);
        }
        break;
      }

      case 'rebuild-index': {
        // Rebuild the SQLite derived index (session_store + session_tasks +
        // session_turn_summary) from the per-session JSONL log. Phase 1
        // dormant: the JSONL writer is wired in Phase 2; this command is
        // useful today only when JSONL files have been seeded by tests or
        // by a future async-repair path.
        const profile = resolveProfile({ flag: parseSingleFlag(argv, '--profile') });
        const layout = { sessionsDir: profile.paths.sessionsDir };
        const rebuilder = new IndexRebuilder(db.getDb(), layout);
        const target = argv[1];
        if (!target) {
          console.error('Usage: vinyan session rebuild-index <session-id|--all>');
          process.exit(1);
        }
        const reports = target === '--all' ? rebuilder.rebuildAll() : [rebuilder.rebuildSessionIndex(target)];
        for (const report of reports) {
          console.log(
            `  ${report.sessionId}  lines=${report.linesRead}  errors=${report.errors}  ` +
              `endOffset=${report.endOffset}  ${report.durationMs}ms`,
          );
        }
        break;
      }

      default:
        console.error(
          'Usage: vinyan session <list|delete|export|rebuild-index|backfill|migrate-phase4|export-bundle|import-bundle|recover|tombstone gc> [options]',
        );
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

const ANSI_RESET = '\x1b[0m';
const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
} as const;

function colorizeLifecycle(state: string): string {
  switch (state) {
    case 'trashed':
      return `${ANSI.red}trashed${ANSI_RESET}`;
    case 'archived':
      return `${ANSI.gray}archived${ANSI_RESET}`;
    case 'compacted':
      return `${ANSI.magenta}compacted${ANSI_RESET}`;
    case 'suspended':
      return `${ANSI.yellow}suspended${ANSI_RESET}`;
    default:
      return `${ANSI.green}${state}${ANSI_RESET}`;
  }
}

function colorizeActivity(state: string, running: number, total: number): string {
  switch (state) {
    case 'in-progress':
      return `${ANSI.blue}running ${running}/${total}${ANSI_RESET}`;
    case 'waiting-input':
      return `${ANSI.yellow}awaiting-input${ANSI_RESET}`;
    case 'idle':
      return `${ANSI.gray}idle (${total} tasks)${ANSI_RESET}`;
    default:
      return `${ANSI.gray}empty${ANSI_RESET}`;
  }
}
