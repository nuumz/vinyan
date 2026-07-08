/**
 * Adaptive Parameters — public exports.
 *
 * See `parameter-registry.ts` for the philosophy (Guard axioms vs.
 * Ceiling parameters) and the registry of every tunable.
 */

export { type ParameterAdaptationInput, type ParameterAdaptationRecord, ParameterLedger } from './parameter-ledger.ts';
export {
  AXIOM_CATEGORIES,
  type AxiomCategory,
  getParameterDef,
  listParameterDefs,
  PARAMETER_TYPES,
  type ParameterDef,
  type ParameterType,
  validateParameterValue,
} from './parameter-registry.ts';
export { type ParameterSetResult, ParameterStore, type ParameterStoreOptions } from './parameter-store.ts';
