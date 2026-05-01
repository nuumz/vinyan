/**
 * Adaptive Parameters — public exports.
 *
 * See `parameter-registry.ts` for the philosophy (Guard axioms vs.
 * Ceiling parameters) and the registry of every tunable.
 */
export {
  AXIOM_CATEGORIES,
  getParameterDef,
  listParameterDefs,
  PARAMETER_TYPES,
  validateParameterValue,
  type AxiomCategory,
  type ParameterDef,
  type ParameterType,
} from './parameter-registry.ts';
export { ParameterLedger, type ParameterAdaptationInput, type ParameterAdaptationRecord } from './parameter-ledger.ts';
export { ParameterStore, type ParameterSetResult, type ParameterStoreOptions } from './parameter-store.ts';
