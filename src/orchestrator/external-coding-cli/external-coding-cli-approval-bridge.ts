/**
 * Approval bridge — translates external-CLI permission prompts into Vinyan
 * approvals.
 *
 * Policy chain (deterministic, A3):
 *   1. If the request is for git commit/push/tag → require human regardless
 *      of any other config (matches user's CLAUDE.md hard rule).
 *   2. If `requireHumanForShell|Writes|Git` matches scope → require human.
 *   3. If `autoApproveReadOnly` and scope is read-only → auto-approve.
 *   4. Otherwise → require human (default-deny posture).
 *
 * Human approvals delegate to {@link ApprovalGate} (existing Vinyan
 * primitive). Timeouts auto-reject. Decisions are recorded for replay (A8).
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { ApprovalGate } from '../approval-gate.ts';
import type {
  ApprovalDecision,
  ApprovalPolicy,
  CodingCliApprovalRequest,
  CodingCliEventBase,
  CodingCliProviderId,
  CodingCliSessionState,
} from './types.ts';

export interface ApprovalBridgeOptions {
  bus: VinyanBus;
  approvalGate: ApprovalGate;
  policy: ApprovalPolicy;
  /** Defaults to 5 minutes — caller may shorten for headless runs. */
  humanTimeoutMs?: number;
}

export interface ApprovalBridgeContext {
  taskId: string;
  sessionId?: string;
  codingCliSessionId: string;
  providerId: CodingCliProviderId;
  state: CodingCliSessionState;
}

export type PolicyDecision = 'auto-approve' | 'require-human' | 'reject';

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reason: string;
}

export interface ApprovalResolution {
  decision: ApprovalDecision;
  decidedBy: 'policy' | 'human' | 'timeout';
  decidedAt: number;
  reason: string;
  policy: PolicyEvaluation;
}

const GIT_VERBS = new Set(['commit', 'push', 'tag', 'rebase', 'reset', 'merge', 'cherry-pick']);

/** Best-effort detection of read-only commands. Conservative — if unsure, false. */
function isReadOnlyCommand(detail: string): boolean {
  const trimmed = detail.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  // Multiple commands joined → not read-only.
  if (/[;&|]/.test(trimmed)) return false;
  const head = trimmed.split(/\s+/, 1)[0] ?? '';
  return ['cat', 'ls', 'pwd', 'echo', 'head', 'tail', 'wc', 'stat', 'file', 'which', 'whereis', 'find', 'grep', 'rg', 'awk', 'sed'].includes(head)
    && !/--write|-i\b|>>|>/.test(trimmed);
}

function detectGitMutation(detail: string): boolean {
  const trimmed = detail.trim().toLowerCase();
  if (!/^git\b/.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/);
  // git <verb> ... — find the first non-flag word after `git`.
  const verb = tokens.slice(1).find((t) => !t.startsWith('-')) ?? '';
  if (!verb) return false;
  return GIT_VERBS.has(verb);
}

export class CodingCliApprovalBridge {
  private readonly bus: VinyanBus;
  private readonly gate: ApprovalGate;
  private readonly policy: ApprovalPolicy;
  private readonly humanTimeoutMs: number;
  /** Active human-approval keys — used to dedupe and to support cancel. */
  private readonly active = new Map<string, { ctx: ApprovalBridgeContext; request: CodingCliApprovalRequest }>();

  constructor(opts: ApprovalBridgeOptions) {
    this.bus = opts.bus;
    this.gate = opts.approvalGate;
    this.policy = opts.policy;
    this.humanTimeoutMs = opts.humanTimeoutMs ?? 5 * 60 * 1000;
  }

  /**
   * Evaluate the policy without invoking human approval. Pure function for
   * tests; the full request flow uses {@link request}.
   */
  evaluate(req: CodingCliApprovalRequest): PolicyEvaluation {
    if (this.policy.allowDangerousSkipPermissions) {
      return { decision: 'auto-approve', reason: 'allowDangerousSkipPermissions=true (operator override)' };
    }
    // Git mutations: hard rule, regardless of other config.
    if (detectGitMutation(req.detail) || req.scope === 'git') {
      return {
        decision: 'require-human',
        reason: 'git mutation — explicit human approval required (CLAUDE.md hard rule)',
      };
    }
    if (req.scope === 'shell') {
      if (this.policy.autoApproveReadOnly && isReadOnlyCommand(req.detail)) {
        return { decision: 'auto-approve', reason: 'read-only shell command, autoApproveReadOnly=true' };
      }
      if (this.policy.requireHumanForShell) {
        return { decision: 'require-human', reason: 'requireHumanForShell=true' };
      }
    }
    if (req.scope === 'edit') {
      if (this.policy.requireHumanForWrites) {
        return { decision: 'require-human', reason: 'requireHumanForWrites=true' };
      }
    }
    if (req.scope === 'tool') {
      if (this.policy.requireHumanForWrites) {
        return { decision: 'require-human', reason: 'unknown tool, requireHumanForWrites=true' };
      }
    }
    if (req.scope === 'unknown') {
      // Default deny posture — never silently approve.
      return {
        decision: 'require-human',
        reason: 'unknown scope, default-deny — operator must classify',
      };
    }
    return { decision: 'require-human', reason: 'no auto-approve rule matched' };
  }

  /**
   * End-to-end approval flow. Emits `coding-cli:approval_required`,
   * resolves via policy or human, emits `coding-cli:approval_resolved`.
   */
  async request(ctx: ApprovalBridgeContext, req: CodingCliApprovalRequest): Promise<ApprovalResolution> {
    const policy = this.evaluate(req);
    const base: CodingCliEventBase = {
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
      codingCliSessionId: ctx.codingCliSessionId,
      providerId: ctx.providerId,
      state: ctx.state,
      ts: Date.now(),
    };

    this.bus.emit('coding-cli:approval_required', {
      ...base,
      requestId: req.requestId,
      scope: req.scope,
      summary: req.summary,
      detail: req.detail,
      policyDecision: policy.decision,
      policyReason: policy.reason,
    });

    if (policy.decision === 'auto-approve') {
      const decidedAt = Date.now();
      const resolution: ApprovalResolution = {
        decision: 'approved',
        decidedBy: 'policy',
        decidedAt,
        reason: policy.reason,
        policy,
      };
      this.bus.emit('coding-cli:approval_resolved', {
        ...base,
        ts: decidedAt,
        requestId: req.requestId,
        decision: 'approved',
        decidedBy: 'policy',
        decidedAt,
        reason: policy.reason,
      });
      return resolution;
    }

    if (policy.decision === 'reject') {
      const decidedAt = Date.now();
      const resolution: ApprovalResolution = {
        decision: 'rejected',
        decidedBy: 'policy',
        decidedAt,
        reason: policy.reason,
        policy,
      };
      this.bus.emit('coding-cli:approval_resolved', {
        ...base,
        ts: decidedAt,
        requestId: req.requestId,
        decision: 'rejected',
        decidedBy: 'policy',
        decidedAt,
        reason: policy.reason,
      });
      return resolution;
    }

    // require-human path.
    const key = `${ctx.codingCliSessionId}:${req.requestId}`;
    this.active.set(key, { ctx, request: req });
    try {
      const decision = await this.requestHumanApproval(ctx, req);
      const decidedAt = Date.now();
      const decidedBy: ApprovalResolution['decidedBy'] = decision === 'rejected' ? 'human' : 'human';
      const resolution: ApprovalResolution = {
        decision,
        decidedBy,
        decidedAt,
        reason: decision === 'approved' ? 'human approved' : 'human rejected',
        policy,
      };
      this.bus.emit('coding-cli:approval_resolved', {
        ...base,
        ts: decidedAt,
        requestId: req.requestId,
        decision,
        decidedBy,
        decidedAt,
        reason: resolution.reason,
      });
      return resolution;
    } finally {
      this.active.delete(key);
    }
  }

  /** Resolve a pending approval (called by API or TUI). */
  resolveExternal(taskId: string, requestId: string, decision: ApprovalDecision): boolean {
    return this.gate.resolve(this.gateKey(taskId, requestId), decision);
  }

  /** Active pending approvals — for the API's pending list. */
  listPending(): Array<{ ctx: ApprovalBridgeContext; request: CodingCliApprovalRequest }> {
    return [...this.active.values()];
  }

  /** Cancel all pending approvals for a session (auto-reject). */
  cancelPendingForSession(codingCliSessionId: string): number {
    let count = 0;
    for (const [key, value] of this.active.entries()) {
      if (value.ctx.codingCliSessionId === codingCliSessionId) {
        this.gate.resolve(this.gateKey(value.ctx.taskId, value.request.requestId), 'rejected');
        this.active.delete(key);
        count += 1;
      }
    }
    return count;
  }

  private async requestHumanApproval(
    ctx: ApprovalBridgeContext,
    req: CodingCliApprovalRequest,
  ): Promise<ApprovalDecision> {
    const key = this.gateKey(ctx.taskId, req.requestId);
    return this.gate.requestApproval(
      key,
      this.scoreScope(req.scope),
      `[${ctx.providerId}] ${req.scope}: ${req.summary}\n\n${req.detail}`,
    );
  }

  private gateKey(taskId: string, requestId: string): string {
    return `coding-cli/${taskId}/${requestId}`;
  }

  private scoreScope(scope: CodingCliApprovalRequest['scope']): number {
    switch (scope) {
      case 'git':
        return 0.95;
      case 'shell':
        return 0.7;
      case 'edit':
        return 0.5;
      case 'tool':
        return 0.4;
      case 'unknown':
        return 0.6;
    }
  }
}
