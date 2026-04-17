/**
 * Engine Profile Store — persistence for engine profiles (reasoning engine configurations).
 *
 * Re-exports WorkerStore as EngineProfileStore for the new naming convention.
 * The underlying implementation and table name (worker_profiles) are unchanged.
 */
export { WorkerStore as EngineProfileStore } from './worker-store.ts';
