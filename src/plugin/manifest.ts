/**
 * Plugin manifest — Zod schema + parsing helpers (W2).
 *
 * The manifest is the only thing the registry reads from disk before loading
 * code. It declares WHAT a plugin is (`pluginId`, `category`), HOW to verify
 * it (`sha256`, optional `signature`), WHAT it expects (`vinyanApi`), and the
 * least-privilege envelope that the future Worker sandbox + AgentContract
 * intersection will enforce (`agentContract`).
 *
 * Contract anchors:
 *   - w1-contracts §5 Category cardinality — `PluginCategorySchema` enum
 *     mirrors the authoritative table verbatim. Sibling tracks must not
 *     re-declare this union.
 *   - `src/core/agent-contract.ts` — `CapabilitySchema` is reused so manifests
 *     speak the same capability vocabulary as runtime contracts (A6).
 *
 * Regex choices are intentionally strict:
 *   - `pluginId`: lowercase reverse-DNS-ish, e.g. `acme.oracle.k8s`.
 *   - `version` + `vinyanApi`: conservative semver-lite so we never need a
 *     semver library — see `loader.satisfiesApiRange` for the matching rules.
 */
import { z } from 'zod/v4';
import { CapabilitySchema } from '../core/agent-contract.ts';

// ── Category enum (w1-contracts §5) ──────────────────────────────────────

export const PluginCategorySchema = z.enum([
  'memory', // single (active) + fallback chain
  'context', // single
  'oracle', // multi
  'backend', // multi — worker backend (local, docker, modal, etc.)
  'messaging-adapter', // multi
  'skill-registry', // single (active)
]);

export type PluginCategory = z.infer<typeof PluginCategorySchema>;

/** Which categories allow exactly one active plugin at a time. */
export const SINGLE_CATEGORIES: ReadonlySet<PluginCategory> = new Set<PluginCategory>([
  'memory',
  'context',
  'skill-registry',
]);

/** Which categories allow multiple plugins active simultaneously. */
export const MULTI_CATEGORIES: ReadonlySet<PluginCategory> = new Set<PluginCategory>([
  'oracle',
  'backend',
  'messaging-adapter',
]);

export function isSingleCategory(category: PluginCategory): boolean {
  return SINGLE_CATEGORIES.has(category);
}

// ── Manifest schema ──────────────────────────────────────────────────────

const PluginSignatureSchema = z.object({
  algorithm: z.literal('minisign'),
  /** Base64-encoded public key. */
  publicKey: z.string().min(1),
  /** Base64-encoded signature over the entry file bytes. */
  value: z.string().min(1),
});

const AgentContractDeclarationSchema = z.object({
  tools: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default(['*']),
    })
    .default(() => ({ allow: [], deny: ['*'] })),
  fs: z
    .object({
      read: z.array(z.string()).default([]),
      write: z.array(z.string()).default([]),
    })
    .default(() => ({ read: [], write: [] })),
  network: z.enum(['deny-all', 'egress-proxy-only', 'open']).default('deny-all'),
  capabilities: z.array(CapabilitySchema).default([]),
});

export const PluginManifestSchema = z.object({
  /** Reverse-DNS-ish, lowercase, e.g. `acme.oracle.k8s`. */
  pluginId: z.string().regex(/^[a-z][a-z0-9.-]*$/, 'pluginId must match /^[a-z][a-z0-9.-]*$/'),
  /** Strict semver MAJOR.MINOR.PATCH, no pre-release in MVP. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be MAJOR.MINOR.PATCH'),
  category: PluginCategorySchema,
  /** Relative path from manifest dir to the entry file, e.g. `./dist/index.js`. */
  entry: z.string().min(1),
  /** Hex-encoded SHA-256 over entry file bytes. 64 lowercase hex chars. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex chars'),
  signature: PluginSignatureSchema.optional(),
  /**
   * Supported Vinyan API range. Accepted shapes (see `loader.satisfiesApiRange`):
   *   - exact:    `1.2.3`
   *   - caret:    `^1.2.3`
   *   - range:    `>=1.2 <1.5`
   *   - wildcard: `*`
   */
  vinyanApi: z.string().min(1),
  agentContract: AgentContractDeclarationSchema,
  /** Capability strings this plugin offers, e.g. `oracle.k8s-dryrun`. */
  provides: z.array(z.string()).default([]),
  /** Capability strings this plugin expects from the host. */
  consumes: z.array(z.string()).default([]),
  description: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginAgentContractDeclaration = z.infer<typeof AgentContractDeclarationSchema>;

// ── Parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse manifest JSON text. Throws a ZodError on invalid input so callers
 * get structured field-level diagnostics in tests + CLI.
 */
export function parseManifestFromJson(json: string): PluginManifest {
  const raw = JSON.parse(json);
  return PluginManifestSchema.parse(raw);
}

/**
 * Read + parse a manifest file. Uses Bun's file API so we don't pull Node's
 * fs promises into this path (Bun-first per CLAUDE.md).
 */
export async function parseManifestFromFile(path: string): Promise<PluginManifest> {
  const text = await Bun.file(path).text();
  return parseManifestFromJson(text);
}
