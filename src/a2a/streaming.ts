/**
 * A2A Streaming — ECP progress updates and partial verdicts over SSE.
 *
 * Defines Zod schemas for streaming message types and an SSE channel
 * implementation with backpressure handling.
 *
 * Source of truth: Plan Phase F1
 */
import { z } from 'zod';

// ── Progress Update Schema ────────────────────────────────────────────

export const ECPProgressUpdateSchema = z.object({
  ecp_version: z.literal(1),
  message_type: z.literal('progress'),
  task_id: z.string(),
  phase: z.enum(['routing', 'oracle_dispatch', 'oracle_execution', 'aggregation', 'commit']),
  progress_pct: z.number().min(0).max(100),
  oracle_name: z.string().optional(),
  estimated_remaining_ms: z.number().optional(),
  timestamp: z.number(),
});

export type ECPProgressUpdate = z.infer<typeof ECPProgressUpdateSchema>;

// ── Partial Verdict Schema ────────────────────────────────────────────

export const ECPPartialVerdictSchema = z.object({
  ecp_version: z.literal(1),
  message_type: z.literal('partial_verdict'),
  task_id: z.string(),
  oracle_name: z.string(),
  verified: z.boolean(),
  confidence: z.number().min(0).max(1),
  oracles_completed: z.number().optional(),
  oracles_total: z.number().optional(),
  is_final: z.boolean(),
  timestamp: z.number(),
});

export type ECPPartialVerdict = z.infer<typeof ECPPartialVerdictSchema>;

// ── SSE Channel ───────────────────────────────────────────────────────

export interface A2AStreamingChannel {
  sendProgress(update: ECPProgressUpdate): void;
  sendPartialVerdict(verdict: ECPPartialVerdict): void;
  close(): void;
  readonly isClosed: boolean;
}

/**
 * Create an SSE streaming channel that writes to a ReadableStream controller.
 *
 * Backpressure handling:
 * - Progress updates are dropped when the stream buffer is full (non-essential).
 * - Partial verdicts are always queued (essential for correctness).
 */
export function createA2AStreamingChannel(controller: ReadableStreamDefaultController): A2AStreamingChannel {
  let isClosed = false;

  function send(eventType: string, data: unknown): boolean {
    if (isClosed) return false;
    try {
      const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      controller.enqueue(new TextEncoder().encode(payload));
      return true;
    } catch {
      // Controller may have been closed externally
      isClosed = true;
      return false;
    }
  }

  function hasBackpressure(): boolean {
    try {
      return (controller.desiredSize ?? 1) <= 0;
    } catch {
      return true;
    }
  }

  return {
    sendProgress(update: ECPProgressUpdate): void {
      // Drop progress under backpressure — non-essential
      if (hasBackpressure()) return;
      send('progress', update);
    },

    sendPartialVerdict(verdict: ECPPartialVerdict): void {
      // Always send verdicts — essential for correctness
      send('partial_verdict', verdict);
    },

    close(): void {
      if (isClosed) return;
      isClosed = true;
      try {
        controller.close();
      } catch {
        // Already closed
      }
    },

    get isClosed(): boolean {
      return isClosed;
    },
  };
}
