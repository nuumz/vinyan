/**
 * Shared streaming delta types for LLM providers.
 *
 * A structured superset of the legacy `OnTextDelta` callback — preserved for
 * backwards compat by the `LLMStreamOptions.onDelta` path. Providers that
 * support extended thinking or structured tool-use streaming emit the richer
 * kinds; providers that only stream content text emit `{ type: 'content', ... }`.
 *
 * Purely observational — governance decisions never depend on stream deltas (A3).
 */

export type LLMStreamDelta =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use_start'; id: string; tool: string }
  | { type: 'tool_use_input'; id: string; partialJson: string }
  | { type: 'tool_use_end'; id: string };

export type LLMStreamDeltaKind = LLMStreamDelta['type'];

/**
 * Stream options accepted by the rich generateStream path. Providers may
 * ignore kinds they can't produce — callers must tolerate that.
 */
export interface LLMStreamOptions {
  taskId?: string;
  onDelta: (delta: LLMStreamDelta) => void;
}
