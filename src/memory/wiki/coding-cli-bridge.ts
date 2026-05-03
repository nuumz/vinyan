/**
 * Memory Wiki — external coding-CLI ingestion bridge.
 *
 * Subscribes to terminal coding-cli events (`coding-cli:completed`,
 * `coding-cli:failed`) and turns each settled run into a
 * `MemoryWikiIngestor.ingestExternalCodingCliRun()` call.
 *
 * Why these two events:
 *   - `coding-cli:completed` carries the final summary the adapter
 *     emitted at end of run (`finalStatus: 'completed' | 'partial'`).
 *   - `coding-cli:failed` carries `errorClass` (cli_crash | timeout |
 *     verification | policy | unknown) and a reason string. Failure
 *     captures are *especially* wiki-worthy — they expose A6 / A7
 *     adversarial behaviour the orchestrator should remember.
 *
 * Other coding-cli events (output_delta, tool_started, etc.) fire too
 * frequently to be useful sources; the verification-completed event is
 * already an oracle verdict the trace bridge picks up. We deliberately
 * limit this bridge to terminal lifecycle.
 *
 * Idempotent: same coding-cli session firing both completed AND failed
 * (degenerate adapter) collapses on content hash, since the body
 * derivation depends only on the event payload.
 *
 * Best-effort: errors swallowed via `onError`.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type {
  CodingCliCompletedEvent,
  CodingCliFailedEvent,
} from '../../orchestrator/external-coding-cli/types.ts';
import type { MemoryWikiIngestor } from './ingest.ts';

export interface CodingCliBridgeOptions {
  readonly bus: VinyanBus;
  readonly ingestor: MemoryWikiIngestor;
  readonly defaultProfile: string;
  readonly clock?: () => number;
  readonly dispatcher?: (fn: () => void) => void;
  readonly onError?: (
    trigger: 'coding-cli:completed' | 'coding-cli:failed',
    taskId: string,
    err: unknown,
  ) => void;
}

export interface CodingCliBridge {
  off(): void;
}

const defaultDispatcher = (fn: () => void): void => {
  queueMicrotask(fn);
};

const defaultOnError = (
  trigger: 'coding-cli:completed' | 'coding-cli:failed',
  taskId: string,
  err: unknown,
): void => {
  console.warn(
    `[vinyan-wiki] ${trigger} ingestion failed for task ${taskId}:`,
    err instanceof Error ? err.message : err,
  );
};

export function attachCodingCliBridge(opts: CodingCliBridgeOptions): CodingCliBridge {
  const dispatch = opts.dispatcher ?? defaultDispatcher;
  const onError = opts.onError ?? defaultOnError;

  const handleCompleted = (event: CodingCliCompletedEvent): void => {
    dispatch(() => {
      try {
        const md = renderCompletedMarkdown(event);
        opts.ingestor.ingestExternalCodingCliRun({
          profile: opts.defaultProfile,
          taskId: event.taskId,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          transcriptMarkdown: md,
          verdict: event.finalStatus,
          metadata: {
            providerId: event.providerId,
            codingCliSessionId: event.codingCliSessionId,
            ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
          },
        });
      } catch (err) {
        onError('coding-cli:completed', event.taskId, err);
      }
    });
  };

  const handleFailed = (event: CodingCliFailedEvent): void => {
    dispatch(() => {
      try {
        const md = renderFailedMarkdown(event);
        opts.ingestor.ingestExternalCodingCliRun({
          profile: opts.defaultProfile,
          taskId: event.taskId,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          transcriptMarkdown: md,
          verdict: 'failed',
          metadata: {
            providerId: event.providerId,
            codingCliSessionId: event.codingCliSessionId,
            errorClass: event.errorClass,
            ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
          },
        });
      } catch (err) {
        onError('coding-cli:failed', event.taskId, err);
      }
    });
  };

  const offCompleted = opts.bus.on('coding-cli:completed', handleCompleted);
  const offFailed = opts.bus.on('coding-cli:failed', handleFailed);

  let detached = false;
  return {
    off(): void {
      if (detached) return;
      detached = true;
      offCompleted();
      offFailed();
    },
  };
}

// ── Pure markdown renderers (exported for tests) ────────────────────────

export function renderCompletedMarkdown(event: CodingCliCompletedEvent): string {
  const lines: string[] = [];
  lines.push(`# Coding CLI Run — task ${event.taskId} (${event.finalStatus})`);
  lines.push('');
  lines.push(`- **Provider**: ${event.providerId}`);
  lines.push(`- **State**: ${event.state}`);
  lines.push(`- **Final status**: ${event.finalStatus}`);
  lines.push(`- **Coding-CLI session**: ${event.codingCliSessionId}`);
  if (event.providerSessionId) lines.push(`- **Provider session**: ${event.providerSessionId}`);
  if (event.sessionId) lines.push(`- **Vinyan session**: ${event.sessionId}`);
  lines.push(`- **Timestamp**: ${new Date(event.ts).toISOString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(event.summary.slice(0, 8_000));
  return lines.join('\n');
}

export function renderFailedMarkdown(event: CodingCliFailedEvent): string {
  const lines: string[] = [];
  lines.push(`# Coding CLI Run — task ${event.taskId} (FAILED)`);
  lines.push('');
  lines.push(`- **Provider**: ${event.providerId}`);
  lines.push(`- **Error class**: ${event.errorClass}`);
  lines.push(`- **State at failure**: ${event.state}`);
  lines.push(`- **Coding-CLI session**: ${event.codingCliSessionId}`);
  if (event.providerSessionId) lines.push(`- **Provider session**: ${event.providerSessionId}`);
  if (event.sessionId) lines.push(`- **Vinyan session**: ${event.sessionId}`);
  lines.push(`- **Timestamp**: ${new Date(event.ts).toISOString()}`);
  lines.push('');
  lines.push('## Reason');
  lines.push('');
  lines.push(event.reason.slice(0, 4_000));
  return lines.join('\n');
}
