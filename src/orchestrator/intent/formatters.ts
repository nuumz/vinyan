/**
 * Prompt + output formatters used by the intent resolver.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D4).
 *
 * Includes:
 *   - formatConversationContext: render the last N user/assistant turns
 *   - formatAgentCatalog: render specialist agent roster for classifier
 *   - resolveSelectedAgent: pick the best-fit agent id with precedence
 *     (user override → classifier pick → default → first available)
 *   - buildClarificationRequest: bilingual Thai+English prompt when the
 *     deterministic + LLM tiers disagree or the goal is ambiguous
 *
 * Pure: no I/O, no module-level state.
 */

import type {
  AgentSpec,
  ContentBlock,
  ExecutionStrategy,
  SemanticTaskUnderstanding,
  TaskInput,
  Turn,
} from '../types.ts';

/** Flatten a Turn's blocks into a single string for classifier prompt context. */
function flattenTurnText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(`[tool:${b.name}]`);
    else if (b.type === 'tool_result') parts.push(b.content);
  }
  return parts.join(' ');
}

/**
 * Render the last ~5 turns as plain text for the classifier prompt.
 * Entries longer than 200 characters are truncated.
 *
 * A6: flipped from ConversationEntry[] to Turn[] — tool_use / tool_result
 * blocks are flattened inline so the classifier sees the shape of prior
 * tool activity instead of just a compacted string.
 */
export function formatConversationContext(turns?: Turn[]): string {
  if (!turns?.length) return '';
  const recent = turns.slice(-10); // 10 entries ≈ 5 user+assistant pairs
  const lines = recent.map((t) => {
    const text = flattenTurnText(t.blocks);
    const trimmed = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    return `[${t.role}]: ${trimmed}`;
  });
  return `\nRecent conversation:\n${lines.join('\n')}`;
}

/**
 * Render the specialist-agent catalog block for the classifier prompt.
 * Returns empty string when no agents are available. When `overrideActive`
 * is set, the block instructs the LLM to preserve the user's chosen id
 * rather than re-pick.
 */
export function formatAgentCatalog(
  agents: AgentSpec[] | undefined,
  overrideActive: boolean,
  overrideId?: string,
): string {
  if (!agents || agents.length === 0) return '';

  if (overrideActive && overrideId) {
    return `\nAgent override active: the user selected '${overrideId}'. Return that id in your response agentId field unchanged.`;
  }

  const lines: string[] = [];
  lines.push('Available specialist agents (pick the best-fit for this task):');
  const capabilityVocabulary = new Set<string>();
  for (const a of agents) {
    const hints: string[] = [];
    if (a.routingHints?.preferDomains) hints.push(`domains: ${a.routingHints.preferDomains.join(',')}`);
    if (a.routingHints?.preferExtensions) hints.push(`ext: ${a.routingHints.preferExtensions.join(',')}`);
    if (a.routingHints?.preferFrameworks) hints.push(`frameworks: ${a.routingHints.preferFrameworks.join(',')}`);
    const hintsStr = hints.length > 0 ? ` [${hints.join(' | ')}]` : '';
    const capabilityIds = (a.capabilities ?? []).map((c) => c.id);
    for (const id of capabilityIds) capabilityVocabulary.add(id);
    const capStr = capabilityIds.length > 0 ? ` (capabilities: ${capabilityIds.join(', ')})` : '';
    const rolesStr = a.roles && a.roles.length > 0 ? ` (roles: ${a.roles.join(', ')})` : '';
    lines.push(`  - ${a.id}: ${a.description}${hintsStr}${capStr}${rolesStr}`);
  }
  lines.push('Only return ids from this roster. Do not invent specialist agent ids.');
  lines.push('Return the chosen agent id in the response `agentId` field, with a brief `agentSelectionReason`.');
  if (capabilityVocabulary.size > 0) {
    const vocab = Array.from(capabilityVocabulary).sort().join(', ');
    lines.push('');
    lines.push('Capability extraction (drives deterministic routing — do this honestly):');
    lines.push(
      `  - Emit \`capabilityRequirements\` as an array of { id, weight (0-1), fileExtensions?, actionVerbs?, domains?, frameworkMarkers?, role? }.`,
    );
    lines.push(
      `  - Use ONLY these ids (closed vocabulary, derived from the roster above): ${vocab}`,
    );
    lines.push(
      `  - Weight reflects importance to the task. Use multiple requirements when a task spans concerns (e.g. plot + drafting).`,
    );
    lines.push(
      `  - Omit \`capabilityRequirements\` (or return []) when the task is purely conversational or you have no confident signal — the deterministic router will fall back to its own analysis.`,
    );
    lines.push(
      `  - Do NOT invent ids; an unknown id will be silently ignored by the router and the task will mis-route.`,
    );
  }
  return `\n${lines.join('\n')}`;
}

/**
 * Resolve the agent id for a task. Precedence (first match wins):
 *   1. `input.agentId` if valid (user override via --agent flag)
 *   2. classifier pick (`parsedAgent.agentId`) if valid
 *   3. registry default (`defaultAgentId`) if valid
 *   4. first agent in roster
 *
 * Returns `{}` when no agent roster is available.
 */
export function resolveSelectedAgent(
  input: TaskInput,
  agents: AgentSpec[] | undefined,
  defaultAgentId: string | undefined,
  parsedAgent?: { agentId?: string; agentSelectionReason?: string },
  fallbackReason = 'registry default (no confident pick)',
): { agentId?: string; agentSelectionReason?: string } {
  if (!agents || agents.length === 0) return {};
  const known = new Set(agents.map((a) => a.id));
  if (input.agentId && known.has(input.agentId)) {
    return { agentId: input.agentId, agentSelectionReason: 'user override via --agent flag' };
  }
  if (parsedAgent?.agentId && known.has(parsedAgent.agentId)) {
    return {
      agentId: parsedAgent.agentId,
      agentSelectionReason: parsedAgent.agentSelectionReason ?? 'classifier selection',
    };
  }
  const fallback = defaultAgentId && known.has(defaultAgentId) ? defaultAgentId : agents[0]?.id;
  return { agentId: fallback, agentSelectionReason: fallbackReason };
}

/**
 * Build a clarification request when the deterministic + LLM tiers disagree
 * or when the rule confidence is too low to proceed. Bilingual Thai+English
 * — detects Thai characters in the goal to match the user's language.
 */
export function buildClarificationRequest(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
  ruleStrategy: ExecutionStrategy,
  llmStrategy?: ExecutionStrategy,
): { request: string; options?: string[] } {
  const isThai = /[\u0E00-\u0E7F]/.test(input.goal);
  if (llmStrategy && llmStrategy !== ruleStrategy) {
    const request = isThai
      ? `Vinyan ยังตีความไม่ชัดเจน: กฎบอกว่าเป็น "${ruleStrategy}" แต่การวิเคราะห์ภาษาเห็นว่าน่าจะเป็น "${llmStrategy}" ช่วยอธิบายเพิ่มหน่อยได้ไหมว่าต้องการให้ทำอะไร`
      : `Vinyan is uncertain — rule-based routing says "${ruleStrategy}" but semantic analysis suggests "${llmStrategy}". Could you clarify what outcome you expect?`;
    return {
      request,
      options: [
        isThai ? `ดำเนินการแบบ ${ruleStrategy}` : `Proceed as ${ruleStrategy}`,
        isThai ? `ดำเนินการแบบ ${llmStrategy}` : `Proceed as ${llmStrategy}`,
      ],
    };
  }
  // Pure ambiguity — no LLM override, just a low-confidence rule.
  const domainHint = understanding.taskDomain;
  const request = isThai
    ? `ช่วยให้รายละเอียดเพิ่มเติมหน่อยได้ไหม — goal ของคุณตีความได้หลายแบบ (${domainHint})`
    : `Could you add more detail? The goal is ambiguous (${domainHint}).`;
  return { request };
}
