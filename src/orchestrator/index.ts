/**
 * Orchestrator — Phase 1 entry point.
 *
 * Exports the core loop and all dependency interfaces.
 * Phase 0 code does NOT import from this module.
 */

export { createBus, type VinyanBus, type VinyanBusEvents } from '../core/bus.ts';
export type {
  OracleGate,
  OrchestratorDeps,
  PerceptionAssembler,
  RiskRouter,
  SelfModel,
  TaskDecomposer,
  TraceCollector,
  WorkerPool,
} from './core-loop.ts';
export { executeTask } from './core-loop.ts';
export {
  IsolationLevelSchema,
  PerceptualHierarchySchema,
  RoutingLevelSchema,
  TaskDAGSchema,
  TaskInputSchema,
  ToolCallSchema,
  ToolResultSchema,
  WorkerInputSchema,
  WorkerOutputSchema,
  WorkingMemoryStateSchema,
} from './protocol.ts';
export type {
  DagValidationCriteria,
  ECPProtocolVersion,
  // Traces
  ExecutionTrace,
  IsolationLevel,
  // LLM
  LLMProvider,
  LLMRequest,
  LLMResponse,
  // Perception & Memory
  PerceptualHierarchy,
  PredictionError,
  RiskFactors,
  RoutingDecision,
  // Routing
  RoutingLevel,
  // Self-Model
  SelfModelPrediction,
  // Task decomposition
  TaskDAG,
  // Task lifecycle
  TaskInput,
  TaskResult,
  // Tools
  ToolCall,
  ToolResult,
  // Worker
  WorkerInput,
  WorkerOutput,
  WorkingMemoryState,
} from './types.ts';
export { ECP_PROTOCOL_VERSION } from './types.ts';
