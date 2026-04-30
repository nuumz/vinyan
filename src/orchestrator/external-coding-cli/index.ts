/**
 * External Coding CLI — public exports.
 *
 * One control-plane drives heterogeneous CLI coding agents (Claude Code,
 * GitHub Copilot, future). Provider adapters absorb each binary's quirks;
 * the controller stays deterministic and treats every CLI as a zero-trust
 * worker whose self-reported "done" must be verified by Vinyan.
 */
export * from './types.ts';
export {
  CodingCliStateMachine,
  StateMachineError,
  type TransitionRecord,
} from './external-coding-cli-state-machine.ts';
export {
  parseFinalResult,
  parseFinalResultWithDiagnosis,
  findResultBlocks,
  type ParseFinalResultOptions,
  type ParseFinalResultDiagnosis,
} from './external-coding-cli-result-parser.ts';
export {
  TranscriptReader,
  TranscriptAccessError,
  type TranscriptReaderOptions,
} from './external-coding-cli-transcript-reader.ts';
export {
  HookBridge,
  HookSink,
  synthWrapperEvent,
  type HookBridgeReport,
  type WrapperEventInput,
} from './external-coding-cli-hook-bridge.ts';
export {
  CodingCliApprovalBridge,
  type ApprovalBridgeContext,
  type ApprovalBridgeOptions,
  type ApprovalResolution,
  type PolicyDecision,
  type PolicyEvaluation,
} from './external-coding-cli-approval-bridge.ts';
export {
  PipeProcess,
  type PipeProcessEvents,
  type PipeProcessLifecycle,
  type PipeProcessOptions,
} from './external-coding-cli-pty-adapter.ts';
export {
  CodingCliRunner,
  InteractiveSessionHandle,
  type HeadlessRunResult,
  type RunnerEvents,
} from './external-coding-cli-runner.ts';
export {
  CodingCliSession,
  type SessionDeps,
  type SessionTimings,
} from './external-coding-cli-session.ts';
export {
  CodingCliVerifier,
  type VerifierOptions,
} from './external-coding-cli-verifier.ts';
export {
  ExternalCodingCliController,
  type CodingCliSessionStore,
  type ControllerOptions,
  type RouteDecision,
} from './external-coding-cli-controller.ts';
export {
  CodingCliWorkflowStrategy,
  EXTERNAL_CODING_CLI_METADATA,
  EXTERNAL_CODING_CLI_STRATEGY,
  registerCodingCliStrategy,
  type CodingCliWorkflowOutcome,
  type CodingCliWorkflowStep,
} from './external-coding-cli-workflow-strategy.ts';
export {
  ProviderDetectionRegistry,
  probeBinary,
  whichBinary,
  type DetectionRecord,
} from './providers/provider-detection.ts';
export {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from './providers/claude-code-adapter.ts';
export {
  GitHubCopilotAdapter,
  type GitHubCopilotAdapterOptions,
} from './providers/github-copilot-adapter.ts';
