/**
 * Classifier prompt builders (plan commit D6).
 *
 * Assemble the user-prompt block fed into the intent-classifier LLM.
 * Extracted from `src/orchestrator/intent-resolver.ts` so the prompt layout
 * is independently testable and future changes (e.g. routing to a
 * prompt-section-registry-driven builder) live in one place.
 *
 * Pure: no I/O, no module state.
 */

import { userConstraintsOnly } from '../constraints/pipeline-constraints.ts';
import { formatUserContextForPrompt } from '../user-context/user-interest-miner.ts';
import type { IntentResolution, TaskInput } from '../types.ts';
import { computeStructuralFeatures, renderStructuralFeatures } from './features.ts';
import { formatAgentCatalog, formatConversationContext } from './formatters.ts';
import type { IntentResolverDeps } from './types.ts';

/**
 * Render the oracle-verified conversation comprehension as a prompt block
 * the classifier can reason over. Keep it short and structured — the LLM
 * parses fields, not prose.
 *
 * The critical signal is `isClarificationAnswer=true`: when the user's
 * message is an answer to a pending question, the classifier MUST preserve
 * the prior workflow (do not re-route to conversational / direct-tool)
 * unless the user explicitly asks for a topic change.
 */
export function buildComprehensionBlock(
  comprehension?: import('../comprehension/types.ts').ComprehendedTaskMessage,
): string {
  if (!comprehension || comprehension.params.type !== 'comprehension') return '';
  const data = comprehension.params.data;
  if (!data) return '';
  const s = data.state;
  const lines: string[] = [];
  lines.push(
    `\nConversation comprehension (oracle-verified, tier=${comprehension.params.tier}):`,
  );
  lines.push(`- isNewTopic: ${s.isNewTopic}`);
  lines.push(`- isClarificationAnswer: ${s.isClarificationAnswer}`);
  lines.push(`- isFollowUp: ${s.isFollowUp}`);
  lines.push(`- hasAmbiguousReferents: ${s.hasAmbiguousReferents}`);
  if (s.rootGoal) {
    const root = s.rootGoal.length > 160 ? `${s.rootGoal.slice(0, 157)}...` : s.rootGoal;
    lines.push(`- rootGoal: "${root}"`);
  }
  if (s.pendingQuestions.length > 0) {
    lines.push(`- pendingQuestions (${s.pendingQuestions.length}):`);
    for (const q of s.pendingQuestions.slice(0, 5)) lines.push(`    - ${q}`);
  }
  if (data.resolvedGoal && data.resolvedGoal !== data.literalGoal) {
    const resolved =
      data.resolvedGoal.length > 160
        ? `${data.resolvedGoal.slice(0, 157)}...`
        : data.resolvedGoal;
    lines.push(`- resolvedGoal (prefer over literal): "${resolved}"`);
  }
  if (s.isClarificationAnswer) {
    lines.push(
      '- ROUTING RULE: the user is answering a prior clarification. Preserve the existing workflow (stay in agentic-workflow / do NOT reclassify as conversational or direct-tool) unless the user explicitly asks to change topic.',
    );
  }
  return lines.join('\n');
}

/**
 * Default tool allowlist surfaced to the classifier when the caller does
 * not provide one. Kept in sync with `normalizeDirectToolCall`'s
 * KNOWN_TOOLS set so the prompt documents what the parser will accept.
 */
const DEFAULT_TOOL_LIST =
  'shell_exec, file_read, file_write, file_edit, directory_list, search_grep, git_status, git_diff';

/** Build the user prompt injected into the classifier LLM. */
export function buildClassifierUserPrompt(
  input: TaskInput,
  deps: IntentResolverDeps,
  deterministic: IntentResolution | null,
): string {
  const toolList = deps.availableTools?.join(', ') ?? DEFAULT_TOOL_LIST;
  const preferencesBlock = deps.userPreferences ? `\n${deps.userPreferences}` : '';
  const conversationBlock = formatConversationContext(deps.conversationHistory);
  const userContextBlock = deps.userInterestMiner
    ? formatUserContextForPrompt(deps.userInterestMiner.mine({ sessionId: deps.sessionId }))
    : '';
  const overrideActive = Boolean(
    input.agentId && deps.agents?.some((a) => a.id === input.agentId),
  );
  const agentsBlock = formatAgentCatalog(deps.agents, overrideActive, input.agentId);
  const structuralBlock = `\n${renderStructuralFeatures(
    computeStructuralFeatures(input.goal, deps.conversationHistory),
  )}`;
  const deterministicBlock = deterministic
    ? `\nRule-based candidate (tier 0.8 — treat as grounding; override only with strong evidence): strategy=${deterministic.strategy}, confidence=${(deterministic.confidence ?? 0).toFixed(2)}${
        'deterministicCandidate' in deterministic &&
        (deterministic as { deterministicCandidate?: { ambiguous?: boolean } })
          .deterministicCandidate?.ambiguous
          ? ', AMBIGUOUS'
          : ''
      }. If the rule is already correct, confirm it — do not fabricate complexity.`
    : '';
  const comprehensionBlock = buildComprehensionBlock(deps.comprehension);

  // Strip orchestrator-internal prefixes — the intent classifier sees only
  // user intent, not JSON payloads / routing metadata that belong to other
  // pipeline stages.
  const userCs = userConstraintsOnly(input.constraints);

  return `User goal: "${input.goal}"
Task type: ${input.taskType}
Target files: ${input.targetFiles?.join(', ') || 'none'}
Constraints: ${userCs.length > 0 ? userCs.join(', ') : 'none'}
Current platform: ${process.platform}
Available tools: ${toolList}${structuralBlock}${deterministicBlock}${comprehensionBlock}${agentsBlock}${preferencesBlock}${userContextBlock}${conversationBlock}`;
}
