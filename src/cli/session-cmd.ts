/**
 * vinyan session — manage conversation sessions.
 *
 * Subcommands:
 *   list           List all sessions
 *   delete <id>    Delete a session and its history
 *   export <id>    Export session as JSON to stdout
 */

import { join } from 'path';
import { SessionStore } from '../db/session-store.ts';
import { SessionManager } from '../api/session-manager.ts';
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
          const status = s.status === 'active' ? '\x1b[32mactive\x1b[0m' : '\x1b[33msuspended\x1b[0m';
          const date = new Date(s.createdAt).toLocaleString();
          console.log(`  ${s.id}  ${status}  tasks=${s.taskCount}  ${date}  source=${s.source}`);
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

      default:
        console.error('Usage: vinyan session <list|delete|export> [options]');
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
