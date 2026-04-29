/**
 * Workflow strategy adapter — exposes the External Coding CLI controller
 * as a workflow step / worker backend.
 *
 * This is the bridge between Vinyan's existing workflow executor and the
 * external CLI subsystem. It registers metadata with the WorkflowRegistry
 * and provides a dispatcher function the executor can call when it
 * encounters a step with `strategy: 'external-coding-cli'`.
 *
 * The dispatcher always runs verification before reporting success — A1
 * separation of generation (CLI) from verification (Vinyan) is enforced
 * here, not elsewhere.
 */
import {
  type WorkflowMetadata,
  type WorkflowRegistry,
} from '../workflow/workflow-registry.ts';
import type { ExternalCodingCliController } from './external-coding-cli-controller.ts';
import type {
  CodingCliCapabilities,
  CodingCliProviderId,
  CodingCliResult,
  CodingCliVerificationOutcome,
} from './types.ts';

export const EXTERNAL_CODING_CLI_STRATEGY = 'external-coding-cli';

export const EXTERNAL_CODING_CLI_METADATA: WorkflowMetadata = {
  strategy: EXTERNAL_CODING_CLI_STRATEGY,
  description:
    'Delegate coding work to an external CLI agent (Claude Code or GitHub Copilot). Vinyan verifies the CLI claim before accepting completion (A1).',
  requiresTools: true,
  routingFloor: 2,
  shortCircuits: true,
  builtIn: true,
};

/** Register the strategy with a WorkflowRegistry instance. */
export function registerCodingCliStrategy(registry: WorkflowRegistry): void {
  if (registry.has(EXTERNAL_CODING_CLI_STRATEGY)) return;
  registry.register(EXTERNAL_CODING_CLI_METADATA);
}

export interface CodingCliWorkflowStep {
  taskId: string;
  rootGoal: string;
  cwd: string;
  sessionId?: string;
  providerId?: CodingCliProviderId;
  mode?: 'headless' | 'interactive' | 'auto';
  approvalPolicy?: Partial<{
    autoApproveReadOnly: boolean;
    requireHumanForWrites: boolean;
    requireHumanForShell: boolean;
    requireHumanForGit: boolean;
    allowDangerousSkipPermissions: boolean;
  }>;
  allowedScope?: string[];
  forbiddenScope?: string[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  notes?: string;
  correlationId?: string;
  model?: string;
  maxOutputBytes?: number;
}

export interface CodingCliWorkflowOutcome {
  status: 'completed' | 'failed' | 'unsupported' | 'cancelled';
  providerId: CodingCliProviderId | null;
  capabilities: CodingCliCapabilities | null;
  sessionId: string;
  claim: CodingCliResult | null;
  verification: CodingCliVerificationOutcome | null;
  reason: string;
}

export class CodingCliWorkflowStrategy {
  constructor(private readonly controller: ExternalCodingCliController) {}

  /**
   * Run a workflow step that delegates to an external coding CLI. Always
   * runs Vinyan-side verification — never marks completion based on the
   * CLI's self-report alone.
   *
   * Returns a structured outcome the caller can fold back into the
   * workflow step result. When `verification.passed` is false, the outcome
   * status is `failed` even if the CLI claimed `completed` (A7 prediction
   * error).
   */
  async run(step: CodingCliWorkflowStep): Promise<CodingCliWorkflowOutcome> {
    try {
      const outcome = await this.controller.runHeadless(
        {
          taskId: step.taskId,
          rootGoal: step.rootGoal,
          cwd: step.cwd,
          sessionId: step.sessionId,
          providerId: step.providerId,
          mode: step.mode ?? 'headless',
          allowedScope: step.allowedScope ?? [],
          forbiddenScope: step.forbiddenScope ?? [],
          model: step.model,
          notes: step.notes,
          correlationId: step.correlationId,
          timeoutMs: step.timeoutMs ?? 15 * 60 * 1000,
          idleTimeoutMs: step.idleTimeoutMs ?? 2 * 60 * 1000,
          maxOutputBytes: step.maxOutputBytes ?? 4 * 1024 * 1024,
          approvalPolicy: {
            autoApproveReadOnly: step.approvalPolicy?.autoApproveReadOnly ?? false,
            requireHumanForWrites: step.approvalPolicy?.requireHumanForWrites ?? true,
            requireHumanForShell: step.approvalPolicy?.requireHumanForShell ?? true,
            requireHumanForGit: step.approvalPolicy?.requireHumanForGit ?? true,
            allowDangerousSkipPermissions: step.approvalPolicy?.allowDangerousSkipPermissions ?? false,
          },
        },
        step.providerId,
      );
      const sessionState = outcome.session.state();
      if (sessionState === 'unsupported-capability') {
        return {
          status: 'unsupported',
          providerId: outcome.session.adapterId as CodingCliProviderId,
          capabilities: outcome.session.capabilities,
          sessionId: outcome.session.id,
          claim: null,
          verification: null,
          reason: 'provider unsupported / limited variant',
        };
      }
      if (!outcome.claim) {
        return {
          status: 'failed',
          providerId: outcome.session.adapterId as CodingCliProviderId,
          capabilities: outcome.session.capabilities,
          sessionId: outcome.session.id,
          claim: null,
          verification: null,
          reason: 'CLI did not emit a structured result envelope',
        };
      }
      if (!outcome.verification.passed) {
        return {
          status: 'failed',
          providerId: outcome.session.adapterId as CodingCliProviderId,
          capabilities: outcome.session.capabilities,
          sessionId: outcome.session.id,
          claim: outcome.claim,
          verification: outcome.verification,
          reason: outcome.verification.reason ?? 'verification failed',
        };
      }
      return {
        status: 'completed',
        providerId: outcome.session.adapterId as CodingCliProviderId,
        capabilities: outcome.session.capabilities,
        sessionId: outcome.session.id,
        claim: outcome.claim,
        verification: outcome.verification,
        reason: 'CLI completed and Vinyan verification passed',
      };
    } catch (err) {
      return {
        status: 'failed',
        providerId: step.providerId ?? null,
        capabilities: null,
        sessionId: '',
        claim: null,
        verification: null,
        reason: `dispatcher error: ${(err as Error).message}`,
      };
    }
  }
}
