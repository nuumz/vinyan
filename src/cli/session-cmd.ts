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
import { IndexRebuilder } from '../db/session-jsonl/rebuild-index.ts';
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
        console.error('Usage: vinyan session <list|delete|export|rebuild-index> [options]');
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
