/**
 * Memory Wiki — session-lifecycle ingestion bridge.
 *
 * Subscribes the wiki ingestor to session lifecycle events on the bus
 * and turns each event into a `MemoryWikiIngestor.ingestSession()` call.
 * Without this bridge the wiki bundle is wired but starves: the
 * infrastructure exists (store, writer, retriever, vault) yet no
 * runtime path feeds it. With it, every archived/compacted session
 * lands as an immutable source plus deterministic page proposals.
 *
 * Trigger choice — `session:archived` and `session:compacted`:
 *   - archived = user signals "preserve this." Intentional, sparse.
 *   - compacted = system signals "this has accumulated mass." Periodic.
 *
 * Idempotency (post-α): `ingestor.ingestSession` writes
 * content-addressed sources via `deriveSourceId(kind, contentHash)` —
 * pure content-addressed. The HTTP archive path also no longer
 * double-emits (server.ts dedup'd to SessionManager-only emit), so
 * one user-facing archive yields one source row, not two.
 *
 * Cross-archive supersession: archive → unarchive → modify → archive
 * still produces a NEW row because the body bytes differ (more turns,
 * updated_at moves). OLD row retained — the wiki is append-only audit
 * trail of session moments.
 *
 * Shutdown: ingestion is dispatched via `queueMicrotask`. The Node/Bun
 * event loop drains all queued microtasks BEFORE the next macrotask
 * (signal handlers included), so an archive whose response has been
 * sent will complete its ingestion before SIGTERM runs the shutdown
 * sequence. SIGKILL is unprotected — the data-loss window is the gap
 * between bus.emit and microtask drain (effectively zero for graceful
 * shutdown). Calling `bridge.off()` does NOT cancel pending
 * microtasks: the captured ingestor reference stays live, any
 * already-queued ingestion completes after off() unsubscribes.
 *
 * Partial-failure: post-α `ingestor.ingestSession` IS transactional —
 * the source-row INSERT and per-page writes commit together via
 * `MemoryWikiStore.transaction`. A page-writer exception rolls back
 * the source row. Bridge still routes any thrown error through
 * `onError` so the operator sees the failure.
 *
 * Best-effort: every failure is caught and reported through `onError`.
 * The bus and SessionManager never see the error.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { SessionRow, SessionStore, SessionTaskRow } from '../../db/session-store.ts';
import type { ContentBlock, Turn } from '../../orchestrator/types.ts';
import type { MemoryWikiIngestor } from './ingest.ts';

/** Hard upper bound on the markdown body that gets written to the source. */
const SUMMARY_BODY_CAP = 32 * 1024;
const TURN_SNIPPET_CAP = 800;
const MAX_TURNS_FOR_SUMMARY = 24;
const WORKING_MEMORY_SNIPPET_CAP = 2_000;

export type SessionIngestionTrigger = 'session:archived' | 'session:compacted';

export interface SessionIngestionBridgeOptions {
  readonly bus: VinyanBus;
  readonly sessionStore: SessionStore;
  readonly ingestor: MemoryWikiIngestor;
  readonly defaultProfile: string;
  readonly clock?: () => number;
  readonly dispatcher?: (fn: () => void) => void;
  readonly onError?: (trigger: SessionIngestionTrigger, sessionId: string, err: unknown) => void;
}

export interface SessionIngestionBridge {
  off(): void;
}

const defaultDispatcher = (fn: () => void): void => {
  queueMicrotask(fn);
};

const defaultOnError = (
  trigger: SessionIngestionTrigger,
  sessionId: string,
  err: unknown,
): void => {
  console.warn(
    `[vinyan-wiki] ${trigger} ingestion failed for ${sessionId}:`,
    err instanceof Error ? err.message : err,
  );
};

export function attachSessionIngestionBridge(
  opts: SessionIngestionBridgeOptions,
): SessionIngestionBridge {
  const dispatch = opts.dispatcher ?? defaultDispatcher;
  const onError = opts.onError ?? defaultOnError;

  const handle = (trigger: SessionIngestionTrigger, sessionId: string): void => {
    dispatch(() => {
      try {
        const session = opts.sessionStore.getSession(sessionId);
        if (!session) return;
        const recentTurns = opts.sessionStore.getRecentTurns(sessionId, MAX_TURNS_FOR_SUMMARY);
        const totalTurns = opts.sessionStore.countTurns(sessionId);
        const tasks = opts.sessionStore.listSessionTasks(sessionId);

        if (!hasIngestableContent(session, recentTurns, tasks)) return;

        const summaryMarkdown = buildSessionSummaryMarkdown({
          session,
          recentTurns,
          totalTurns,
          tasks,
          trigger,
        });
        if (!summaryMarkdown || summaryMarkdown.length < 50) return;

        opts.ingestor.ingestSession({
          profile: opts.defaultProfile,
          sessionId,
          summaryMarkdown,
          metadata: {
            trigger,
            totalTurns,
            taskCount: tasks.length,
            ...(session.title ? { title: session.title } : {}),
          },
        });
      } catch (err) {
        onError(trigger, sessionId, err);
      }
    });
  };

  const offArchived = opts.bus.on('session:archived', (e) => handle('session:archived', e.sessionId));
  const offCompacted = opts.bus.on('session:compacted', (e) =>
    handle('session:compacted', e.sessionId),
  );

  let detached = false;
  return {
    off(): void {
      if (detached) return;
      detached = true;
      offArchived();
      offCompacted();
    },
  };
}

// ── Pure builders (exported for tests) ──────────────────────────────────

export interface SessionSummaryInput {
  readonly session: SessionRow;
  readonly recentTurns: readonly Turn[];
  readonly totalTurns: number;
  readonly tasks: readonly SessionTaskRow[];
  readonly trigger: SessionIngestionTrigger;
}

export function hasIngestableContent(
  session: SessionRow,
  recentTurns: readonly Turn[],
  tasks: readonly SessionTaskRow[],
): boolean {
  if (recentTurns.length > 0) return true;
  if (tasks.length > 0) return true;
  if (session.working_memory_json && session.working_memory_json !== 'null') return true;
  return false;
}

export function buildSessionSummaryMarkdown(input: SessionSummaryInput): string {
  const { session, recentTurns, totalTurns, tasks, trigger } = input;
  const lines: string[] = [];
  const heading = session.title?.trim() || `Session ${session.id}`;
  lines.push(`# ${heading}`);
  lines.push('');
  lines.push(`- **Trigger**: ${trigger}`);
  lines.push(`- **Session ID**: ${session.id}`);
  lines.push(`- **Source**: ${session.source}`);
  lines.push(`- **Status**: ${session.status}`);
  lines.push(`- **Created**: ${new Date(session.created_at).toISOString()}`);
  lines.push(`- **Updated**: ${new Date(session.updated_at).toISOString()}`);
  lines.push(`- **Turns**: ${totalTurns}`);
  lines.push(`- **Tasks**: ${tasks.length}`);
  if (session.archived_at) {
    lines.push(`- **Archived**: ${new Date(session.archived_at).toISOString()}`);
  }

  if (session.description?.trim()) {
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(session.description.trim());
  }

  const wmSnippet = renderWorkingMemorySnippet(session.working_memory_json);
  if (wmSnippet) {
    lines.push('');
    lines.push('## Working Memory');
    lines.push('');
    lines.push('```json');
    lines.push(wmSnippet);
    lines.push('```');
  }

  if (recentTurns.length > 0) {
    lines.push('');
    const omitted = totalTurns - recentTurns.length;
    const header =
      omitted > 0
        ? `## Recent Turns (latest ${recentTurns.length} of ${totalTurns})`
        : `## Turns (${totalTurns})`;
    lines.push(header);
    lines.push('');
    for (const turn of recentTurns) {
      const text = extractTurnText(turn);
      if (!text) continue;
      const snippet = collapseWhitespace(text).slice(0, TURN_SNIPPET_CAP);
      const cancelled = turn.cancelledAt ? ' _(cancelled)_' : '';
      lines.push(`- **${turn.role}**${cancelled}: ${snippet}`);
    }
  }

  if (tasks.length > 0) {
    lines.push('');
    lines.push(`## Tasks (${tasks.length})`);
    lines.push('');
    for (const task of tasks) {
      const goal = extractTaskGoal(task.task_input_json);
      const goalPart = goal ? ` — ${goal}` : '';
      lines.push(`- \`${task.task_id}\` — ${task.status}${goalPart}`);
    }
  }

  const body = lines.join('\n');
  if (body.length <= SUMMARY_BODY_CAP) return body;
  const truncated = body.slice(0, SUMMARY_BODY_CAP);
  const lastNewline = truncated.lastIndexOf('\n');
  const safe = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return `${safe}\n\n_…truncated at ${SUMMARY_BODY_CAP} bytes._\n`;
}

function renderWorkingMemorySnippet(rawJson: string | null): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (parsed === null || parsed === undefined) return null;
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.length <= WORKING_MEMORY_SNIPPET_CAP) return pretty;
    return `${pretty.slice(0, WORKING_MEMORY_SNIPPET_CAP)}\n…[truncated]`;
  } catch {
    return null;
  }
}

function extractTurnText(turn: Turn): string {
  if (!Array.isArray(turn.blocks)) return '';
  const parts: string[] = [];
  for (const block of turn.blocks) parts.push(renderBlockText(block));
  return parts.filter(Boolean).join(' ');
}

function renderBlockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return '';
    case 'tool_use':
      return `[tool ${block.name}]`;
    case 'tool_result':
      return block.is_error ? `[tool error]` : '';
    default:
      return '';
  }
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function extractTaskGoal(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as { goal?: unknown };
    if (typeof parsed.goal === 'string') {
      return collapseWhitespace(parsed.goal).slice(0, 160);
    }
  } catch {
    /* fall through */
  }
  return null;
}
