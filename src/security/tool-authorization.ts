/**
 * Tool Authorization — K1.3 capability-based tool access control.
 *
 * Maps tool calls to required capabilities and checks against the
 * agent's contract. Unknown tools are denied by default (A6: zero-trust).
 *
 * K1 scope: static capability matching per contract routing level.
 * K2 adds dynamic, single-use capability tokens.
 */
import type { AgentContract, Capability } from '../core/agent-contract.ts';
import { isReadOnlyCommand } from '../orchestrator/tools/shell-policy.ts';

interface AuthorizationResult {
  authorized: boolean;
  violation?: string;
}

interface RequiredCapability {
  type: Capability['type'];
  scope: string[];
}

/**
 * Check if a tool call is authorized by the agent's contract.
 * Returns { authorized: true } or { authorized: false, violation: string }.
 */
export function authorizeToolCall(
  contract: AgentContract,
  toolName: string,
  args: Record<string, unknown>,
): AuthorizationResult {
  const required = classifyTool(toolName, args);

  for (const cap of contract.capabilities) {
    if (cap.type === required.type) {
      const capScope = 'paths' in cap ? cap.paths : 'commands' in cap ? cap.commands : 'providers' in cap ? cap.providers : [];
      if (matchesScope(required.scope, capScope)) {
        return { authorized: true };
      }
    }
  }

  return {
    authorized: false,
    violation: `Tool '${toolName}' requires ${required.type} capability, not granted at L${contract.routingLevel}`,
  };
}

/** Map a tool name + args to the required capability type and scope. */
export function classifyTool(toolName: string, args: Record<string, unknown>): RequiredCapability {
  // File tools — read
  if (['read_file', 'search_file', 'list_dir', 'grep_search'].includes(toolName)) {
    return { type: 'file_read', scope: [String(args.path ?? args.filePath ?? '')] };
  }
  // File tools — write
  if (['write_file', 'edit_file', 'create_file', 'replace_string_in_file'].includes(toolName)) {
    return { type: 'file_write', scope: [String(args.path ?? args.filePath ?? '')] };
  }
  // Shell tools — use centralized shell policy for read-only classification
  if (toolName === 'run_command' || toolName === 'shell' || toolName === 'run_in_terminal') {
    const cmd = String(args.command ?? '');
    const firstWord = cmd.trim().split(/\s+/)[0] ?? '';
    return {
      type: isReadOnlyCommand(firstWord) ? 'shell_read' : 'shell_exec',
      scope: [firstWord],
    };
  }
  // LLM tools
  if (toolName === 'llm_generate' || toolName === 'llm_call') {
    return { type: 'llm_call', scope: [String(args.provider ?? '*')] };
  }
  // Unknown tool → deny by default (A6: zero-trust)
  return { type: 'shell_exec', scope: ['UNKNOWN_TOOL'] };
}

/** Check if required scope entries match any allowed scope pattern. */
function matchesScope(required: string[], allowed: string[]): boolean {
  if (allowed.includes('**') || allowed.includes('*')) return true;
  for (const req of required) {
    if (!req) continue;
    const matched = allowed.some((pattern) => {
      if (pattern === req) return true;
      // Simple glob: src/** matches src/foo/bar.ts
      if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3);
        return req.startsWith(prefix);
      }
      return false;
    });
    if (!matched) return false;
  }
  return true;
}
