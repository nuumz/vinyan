/**
 * Runtime barrel — exports the WorkerBackend abstraction and MVP backends.
 * See src/runtime/backend.ts for the interface and Decision 5 for rationale.
 */

export type {
  BackendHandle,
  BackendId,
  BackendSpawnSpec,
  HealthReport,
  HibernationToken,
  IsolationLevel,
  WorkerBackend,
  WorkerInput,
  WorkerOutput,
} from './backend.ts';

export { BackendSelector } from './backend-selector.ts';
export type { BackendSelectorOptions } from './backend-selector.ts';

export { LocalInprocBackend } from './backends/local-inproc.ts';
export type { LocalInprocBackendOptions } from './backends/local-inproc.ts';

export { LocalSubprocBackend } from './backends/local-subproc.ts';
export type {
  LocalSubprocBackendOptions,
  SpawnedProcess,
  SpawnImpl,
} from './backends/local-subproc.ts';
