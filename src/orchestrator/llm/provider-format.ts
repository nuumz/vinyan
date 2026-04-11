/**
 * Provider-specific message formatting — normalizes multi-turn history
 * to Anthropic or OpenAI-compatible message arrays.
 *
 * Phase 6: Agentic Worker Protocol foundation.
 */
import type { HistoryMessage, Message, ToolResultMessage } from '../types.ts';

export type ProviderFamily = 'anthropic' | 'openai-compat';

// ── Anthropic output types ───────────────────────────────────────────

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

// ── OpenAI output types ──────────────────────────────────────────────

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function isToolResult(msg: HistoryMessage): msg is ToolResultMessage {
  return msg.role === 'tool_result';
}

function isMessage(msg: HistoryMessage): msg is Message {
  return msg.role !== 'tool_result';
}

// ── Anthropic normalization ──────────────────────────────────────────

function collectToolResults(
  messages: HistoryMessage[],
  startIndex: number,
): { blocks: AnthropicContentBlock[]; nextIndex: number } {
  const blocks: AnthropicContentBlock[] = [];
  let i = startIndex;
  while (i < messages.length && isToolResult(messages[i] as HistoryMessage)) {
    const tr = messages[i] as ToolResultMessage;
    const block: AnthropicContentBlock = {
      type: 'tool_result',
      tool_use_id: tr.toolCallId,
      content: tr.content,
      ...(tr.isError ? { is_error: true } : {}),
    };
    blocks.push(block);
    i++;
  }
  return { blocks, nextIndex: i };
}

function assistantToAnthropic(m: Message): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = [];
  if (m.thinking) blocks.push({ type: 'thinking', thinking: m.thinking });
  if (m.toolCalls?.length) {
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls) {
      blocks.push({ type: 'tool_use', id: tc.id, name: tc.tool, input: tc.parameters });
    }
  } else {
    blocks.push({ type: 'text', text: m.content });
  }
  return { role: 'assistant', content: blocks };
}

function toAnthropic(messages: HistoryMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i] as HistoryMessage;

    if (isToolResult(msg)) {
      const { blocks, nextIndex } = collectToolResults(messages, i);
      result.push({ role: 'user', content: blocks });
      i = nextIndex;
      continue;
    }

    if (!isMessage(msg)) {
      i++;
      continue;
    }

    // Skip system messages (set separately in Anthropic API)
    if (msg.role === 'system') {
      i++;
      continue;
    }

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else {
      result.push(assistantToAnthropic(msg));
    }
    i++;
  }

  return result;
}

// ── OpenAI normalization ─────────────────────────────────────────────

function toOpenAI(messages: HistoryMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (isToolResult(msg)) {
      result.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: msg.toolCallId,
      });
      continue;
    }

    if (msg.role === 'system' || msg.role === 'user') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // role === 'assistant' — strip thinking (OpenAI doesn't support it)
    const out: OpenAIMessage = { role: 'assistant', content: msg.content || undefined };

    if (msg.toolCalls?.length) {
      out.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.tool, arguments: JSON.stringify(tc.parameters) },
      }));
    }

    result.push(out);
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────

export function normalizeMessages(
  messages: HistoryMessage[],
  family: ProviderFamily,
): AnthropicMessage[] | OpenAIMessage[] {
  return family === 'anthropic' ? toAnthropic(messages) : toOpenAI(messages);
}
