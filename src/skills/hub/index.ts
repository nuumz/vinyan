/**
 * Skills Hub import pipeline — public surface.
 *
 * The Skills Hub turns external SKILL.md files (GitHub, agentskills.io,
 * community hubs) into epistemically-verified local skills. Every import
 * passes Oracle Gate + Critic dry-run before it can promote out of
 * speculative quarantine (A1 + A5 + A6).
 */

export { AgentskillsIoAdapter, type AgentskillsIoAdapterOptions } from './adapters/agentskills-io.ts';
export { GitHubAdapter, type GitHubAdapterOptions, parseGithubSkillId } from './adapters/github.ts';
export {
  DEFAULT_IMPORTER_GUARDRAILS,
  type ImporterCriticFn,
  type ImporterCriticRequest,
  type ImporterCriticVerdict,
  type ImporterGateFn,
  type ImporterGateRequest,
  type ImporterGateVerdict,
  type ImporterGuardrails,
  type ImportState,
  SkillImporter,
  type SkillImporterDeps,
} from './importer.ts';
export {
  type CriticResultLike,
  decidePromotion,
  type GateVerdictLike,
  HUB_IMPORT_GATE_CONFIDENCE_FLOOR,
  HUB_IMPORT_RULE_ID,
  type PromotionDecision,
  type PromotionInputs,
  type StaticScanResult,
} from './promotion-rules.ts';
export {
  type FetchImpl,
  type SkillFetchResult,
  type SkillListingL0,
  SkillNotFoundError,
  type SkillRegistryAdapter,
  SkillRegistryError,
  type SkillRegistryName,
} from './registry-adapter.ts';
export {
  InMemorySkillTrustLedger,
  type SkillTrustLedger,
  type SkillTrustLedgerEntry,
  type SkillTrustLedgerOptions,
  StoreBackedSkillTrustLedger,
} from './trust-ledger.ts';
export { buildImporterGateFn, type GateAdapterDeps, type RunGateFn } from './gate-adapter.ts';
export { buildImporterCriticFn, type CriticAdapterDeps } from './critic-adapter.ts';
export {
  setupSkillImporter,
  type SetupGuardrails,
  type SetupSkillImporterOptions,
  type SkillImporterHandle,
} from './wiring.ts';
