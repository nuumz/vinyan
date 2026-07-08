/**
 * External Coding CLI — public exports.
 *
 * One control-plane drives heterogeneous CLI coding agents (Claude Code,
 * GitHub Copilot, future). Provider adapters absorb each binary's quirks;
 * the controller stays deterministic and treats every CLI as a zero-trust
 * worker whose self-reported "done" must be verified by Vinyan.
 *
 * ── Agent vocabulary ─────────────────────────────────────────────────
 * This module deals with **Agent type #3 — CLI Delegate** (a.k.a.
 * External Coding CLI): vendor binaries (Claude Code, GitHub Copilot)
 * that Vinyan **spawns as subprocesses** to perform delegated coding
 * tasks. Trust tier: `zero-trust` per A6 + A1 verification — every CLI
 * claim runs through Vinyan's verifier before completion.
 *
 * IMPORTANT — distinguish from **#4 Host CLI**: the same Claude Code
 * binary is also what a human developer might use to write Vinyan source
 * code. That's #4 and Vinyan does NOT see it. When parsing user prompts
 * that mention "Claude Code", the intent classifier MUST distinguish:
 *   - "ask Claude Code to ..."  → #3, route here
 *   - "what is Claude Code?"    → conversational, NOT here
 *   - (developer's own toolchain) → #4, outside Vinyan entirely
 *
 * The 2026-04-30 routing bug ("dangerous metacharacter" rejection on a
 * Thai delegation prompt) was a #3-vs-shell-exec confusion that the
 * vocabulary discipline prevents from recurring.
 *
 * Full taxonomy: `docs/foundation/agent-vocabulary.md`.
 * Branded ID type: `CliDelegateProviderId` from `src/core/agent-vocabulary.ts`.
 */

export {
  type ApprovalBridgeContext,
  type ApprovalBridgeOptions,
  type ApprovalResolution,
  CodingCliApprovalBridge,
  type PolicyDecision,
  type PolicyEvaluation,
} from './external-coding-cli-approval-bridge.ts';
export {
  type CodingCliSessionStore,
  type ControllerOptions,
  ExternalCodingCliController,
  type RouteDecision,
} from './external-coding-cli-controller.ts';
export {
  HookBridge,
  type HookBridgeReport,
  HookSink,
  synthWrapperEvent,
  type WrapperEventInput,
} from './external-coding-cli-hook-bridge.ts';
export {
  PipeProcess,
  type PipeProcessEvents,
  type PipeProcessLifecycle,
  type PipeProcessOptions,
} from './external-coding-cli-pty-adapter.ts';
export {
  findResultBlocks,
  type ParseFinalResultDiagnosis,
  type ParseFinalResultOptions,
  parseFinalResult,
  parseFinalResultWithDiagnosis,
} from './external-coding-cli-result-parser.ts';
export {
  CodingCliRunner,
  type HeadlessRunResult,
  InteractiveSessionHandle,
  type RunnerEvents,
} from './external-coding-cli-runner.ts';
export {
  CodingCliSession,
  type SessionDeps,
  type SessionTimings,
} from './external-coding-cli-session.ts';
export {
  CodingCliStateMachine,
  StateMachineError,
  type TransitionRecord,
} from './external-coding-cli-state-machine.ts';
export {
  TranscriptAccessError,
  TranscriptReader,
  type TranscriptReaderOptions,
} from './external-coding-cli-transcript-reader.ts';
export {
  CodingCliVerifier,
  type VerifierOptions,
} from './external-coding-cli-verifier.ts';
export {
  type CodingCliWorkflowOutcome,
  type CodingCliWorkflowStep,
  CodingCliWorkflowStrategy,
  EXTERNAL_CODING_CLI_METADATA,
  EXTERNAL_CODING_CLI_STRATEGY,
  registerCodingCliStrategy,
} from './external-coding-cli-workflow-strategy.ts';
export {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from './providers/claude-code-adapter.ts';
export {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterOptions,
} from './providers/github-copilot-adapter.ts';
export {
  type DetectionRecord,
  ProviderDetectionRegistry,
  probeBinary,
  whichBinary,
} from './providers/provider-detection.ts';
export * from './types.ts';
