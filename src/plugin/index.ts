/**
 * Plugin Registry — public surface.
 *
 * Re-exports the types + functions + classes that consumers outside the
 * `src/plugin/` folder should import from. Internal helpers (semver-lite
 * matcher, discovery scanners) stay hidden.
 */

export type {
  BundleAgentRef,
  BundleManifest,
  BundleMcpServer,
  BundleSkillRef,
  LoadBundleResult,
} from './bundle-manifest.ts';
export { BundleManifestSchema, loadBundleManifests } from './bundle-manifest.ts';
export type { DiscoverOptions, DiscoveryWarning } from './discovery.ts';
export { discoverPlugins } from './discovery.ts';
export type { InprocLoaderOptions, LoadOutcome } from './loader.ts';
export { InprocLoader, satisfiesApiRange } from './loader.ts';
export type {
  PluginAgentContractDeclaration,
  PluginCategory,
  PluginManifest,
} from './manifest.ts';
export {
  isSingleCategory,
  MULTI_CATEGORIES,
  PluginCategorySchema,
  PluginManifestSchema,
  parseManifestFromFile,
  parseManifestFromJson,
  SINGLE_CATEGORIES,
} from './manifest.ts';
export type { RegistryDeps } from './registry.ts';
export { PluginRegistry } from './registry.ts';
export type {
  IntegrityResult,
  SignatureResult,
  TrustConfig,
  TrustedPublisher,
} from './signature.ts';
export {
  effectiveTrustTier,
  verifyIntegrity,
  verifySignature,
} from './signature.ts';
export type {
  DiscoveredPlugin,
  LoadedPlugin,
  PluginAuditEvent,
  PluginAuditRecord,
  PluginSlot,
  PluginState,
} from './types.ts';
export {
  PluginActivationError,
  PluginLoadError,
} from './types.ts';
