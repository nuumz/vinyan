/**
 * Engine Router — capability-based reasoning engine routing.
 *
 * Re-exports WorkerSelector as EngineRouter for the new naming convention.
 * The underlying implementation is unchanged — this is a naming migration.
 */
export { WorkerSelector as EngineRouter, type WorkerSelectorConfig as EngineRouterConfig } from './worker-selector.ts';
