/**
 * Engine Lifecycle — deterministic state machine for engine status transitions.
 *
 * Re-exports WorkerLifecycle as EngineLifecycle for the new naming convention.
 * The underlying implementation is unchanged — this is a naming migration.
 */
export { WorkerLifecycle as EngineLifecycle, type WorkerLifecycleConfig as EngineLifecycleConfig } from './worker-lifecycle.ts';
