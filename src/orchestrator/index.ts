/**
 * Orchestrator — Phase 1 entry point.
 *
 * Exports the core loop and all dependency interfaces.
 * Phase 0 code does NOT import from this module.
 */
export { executeTask } from "./core-loop.ts";
export type {
  OrchestratorDeps,
  PerceptionAssembler,
  RiskRouter,
  SelfModel,
  TaskDecomposer,
  WorkerPool,
  OracleGate,
  TraceCollector,
} from "./core-loop.ts";

export type {
  // Routing
  RoutingLevel,
  IsolationLevel,
  RoutingDecision,
  RiskFactors,
  // Task lifecycle
  TaskInput,
  TaskResult,
  // Perception & Memory
  PerceptualHierarchy,
  WorkingMemoryState,
  // Self-Model
  SelfModelPrediction,
  PredictionError,
  // Traces
  ExecutionTrace,
  // Task decomposition
  TaskDAG,
  DagValidationCriteria,
  // Worker
  WorkerInput,
  WorkerOutput,
  // Tools
  ToolCall,
  ToolResult,
  // LLM
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from "./types.ts";

export { ECP_PROTOCOL_VERSION } from "./types.ts";
export type { ECPProtocolVersion } from "./types.ts";

export { createBus, type VinyanBus, type VinyanBusEvents } from "../core/bus.ts";

export {
  RoutingLevelSchema,
  IsolationLevelSchema,
  WorkerInputSchema,
  WorkerOutputSchema,
  PerceptualHierarchySchema,
  WorkingMemoryStateSchema,
  TaskDAGSchema,
  ToolCallSchema,
  ToolResultSchema,
  TaskInputSchema,
} from "./protocol.ts";
