/**
 * Derive a persona's runtime capability set from its persona spec, its loaded
 * skills, and (later) per-skill outcome history. The Phase-2 bridge between
 * persona and skill subsystems.
 *
 * Returned shape:
 *   - capabilities: persona's builtin claims ⊕ skill-derived claims
 *   - effectiveAcl: persona ACL ∩ ⋂(skill ACL) — skills can ONLY narrow (A6)
 *   - loadedSkills: SkillMdRecord list, in deterministic load order
 *   - missingSkills: refs that could not be resolved (A9 — keeps load alive)
 *   - skipped: skills excluded for ACL/hash/status reasons, with rule id
 *
 * Axiom anchors:
 *   - A1: derivation never invokes an LLM. Pure data transform.
 *   - A4: a `SkillRef.contentHash` pin is verified against the resolved
 *     skill's `content_hash`; mismatch → skip with `pin-mismatch`.
 *   - A5: claim `evidence` and tier come from skill metadata, not from skill
 *     authoring. A skill cannot claim 'evolved' it hasn't earned.
 *   - A6: ACL composition is intersection-only. Skills with `acl.network=true`
 *     do NOT widen a persona whose floor is `network=false`.
 *   - A8 (proposed): every skip emits a structured warning so the decision is
 *     replayable from logs. Persona id, skill id, rule id, timestamp.
 *   - A9 (proposed): missing/malformed skill is non-fatal — collected into
 *     `missingSkills` and logged, never throws.
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import { TIER_CONFIDENCE_CEILING } from '../../core/confidence-tier.ts';
import type { SkillMdFrontmatter, SkillMdRecord } from '../../skills/skill-md/index.ts';
import type { AgentCapabilityOverrides, AgentSpec, CapabilityClaim, CapabilityEvidence, SkillRef } from '../types.ts';

/**
 * Resolves a `SkillRef` into a parsed `SkillMdRecord`. Implementations wrap
 * `SkillArtifactStore` (filesystem) or test doubles. Async because the
 * underlying artifact store is async.
 */
export interface SkillResolver {
  resolve(ref: SkillRef): Promise<SkillMdRecord | null>;
}

/** Synchronous variant for tests and registry-load path that pre-resolves. */
export interface SyncSkillResolver {
  resolve(ref: SkillRef): SkillMdRecord | null;
}

export type SkillSkipReason = 'not-found' | 'pin-mismatch' | 'version-mismatch' | 'demoted' | 'retired' | 'quarantined';

export interface SkippedSkill {
  ref: SkillRef;
  reason: SkillSkipReason;
  detail?: string;
}

export interface DerivedCapabilities {
  /** Persona claims plus skill-derived claims, ready for the capability router. */
  capabilities: CapabilityClaim[];
  /** Effective ACL after intersecting persona floor with every loaded skill's ACL. */
  effectiveAcl: AgentCapabilityOverrides;
  /** Successfully loaded skills, in deterministic order (tier desc, id asc). */
  loadedSkills: SkillMdRecord[];
  /** Refs that resolved cleanly. Useful for trace-store / A8 replay. */
  resolvedRefs: SkillRef[];
  /** Refs that did not load — see `reason`. Phase-2 logs but does not fail. */
  skipped: SkippedSkill[];
}

/**
 * Compute the persona's effective capability surface.
 *
 * @param persona - the loaded persona spec (after registry merge)
 * @param refs    - combined base + bound skills (callers concat)
 * @param resolver - how to fetch SKILL.md by ref
 */
export function derivePersonaCapabilities(
  persona: AgentSpec,
  refs: readonly SkillRef[],
  resolver: SyncSkillResolver,
): DerivedCapabilities {
  const loaded: SkillMdRecord[] = [];
  const resolved: SkillRef[] = [];
  const skipped: SkippedSkill[] = [];

  for (const ref of refs) {
    const result = tryResolveSkill(ref, resolver);
    if (result.ok) {
      loaded.push(result.record);
      resolved.push(ref);
    } else {
      skipped.push({ ref, reason: result.reason, detail: result.detail });
      // A8: structured log line so the decision is replayable from console capture
      console.warn(
        `[skill:load-skipped] persona='${persona.id}' skill='${ref.id}' reason='${result.reason}'${result.detail ? ` detail='${result.detail}'` : ''}`,
      );
    }
  }

  // Deterministic order — tier desc (deterministic first), then id asc.
  loaded.sort(deterministicSkillOrder);

  const personaClaims = (persona.capabilities ?? []).map(cloneClaim);
  const skillClaims = loaded.flatMap(skillToClaims);

  const effectiveAcl = composeAcl(persona.capabilityOverrides, loaded);

  return {
    capabilities: dedupeClaimsByLast(personaClaims.concat(skillClaims)),
    effectiveAcl,
    loadedSkills: loaded,
    resolvedRefs: resolved,
    skipped,
  };
}

// ── ACL composition ─────────────────────────────────────────────────

/**
 * Compose the persona's ACL floor with every loaded skill's ACL. Skills can
 * ONLY narrow — `false` on the skill side wins; `true` is a request that
 * persona-level `false` overrides.
 *
 * Examples:
 *   persona { network: false } + skill { network: true }  →  { network: false }
 *   persona { network: true  } + skill { network: false } →  { network: false }
 *   persona { network: true  } + skill { acl: undefined } →  { network: true  }
 *   persona {} (defaults)      + skill { network: false } →  { network: false }
 */
export function composeAcl(
  base: AgentCapabilityOverrides | undefined,
  skills: readonly SkillMdRecord[],
): AgentCapabilityOverrides {
  const acl: AgentCapabilityOverrides = { ...(base ?? {}) };
  for (const skill of skills) {
    const sa = skill.frontmatter.acl;
    if (!sa) continue;
    narrowField(acl, 'readAny', sa.read_any);
    narrowField(acl, 'writeAny', sa.write_any);
    narrowField(acl, 'network', sa.network);
    narrowField(acl, 'shell', sa.shell);
  }
  return acl;
}

function narrowField(
  acl: AgentCapabilityOverrides,
  field: keyof AgentCapabilityOverrides,
  skillValue: boolean | undefined,
): void {
  if (skillValue === false) {
    // Skill explicitly forbids → narrow to false regardless of persona setting.
    acl[field] = false;
  }
  // skillValue === true or undefined: never widens.
}

// ── Skill → CapabilityClaim mapping ─────────────────────────────────

/**
 * Map a skill into one or more capability claims.
 *
 * Source of truth: `frontmatter.provides_capabilities` when declared. Otherwise
 * a default minimal claim is synthesized so the skill at least surfaces as
 * `skill.<id>` in the capability layer.
 */
export function skillToClaims(skill: SkillMdRecord): CapabilityClaim[] {
  const fm = skill.frontmatter;
  const evidence = deriveEvidence(fm);
  const confidence = deriveConfidence(fm.confidence_tier);

  if (fm.provides_capabilities && fm.provides_capabilities.length > 0) {
    return fm.provides_capabilities.map((c) => ({
      id: c.id,
      label: c.label ?? fm.name,
      fileExtensions: c.file_extensions ? [...c.file_extensions] : undefined,
      actionVerbs: c.action_verbs ? [...c.action_verbs] : undefined,
      domains: c.domains ? [...c.domains] : undefined,
      frameworkMarkers: c.framework_markers ? [...c.framework_markers] : undefined,
      role: c.role,
      evidence,
      confidence,
    }));
  }

  // Default: one synthetic claim keyed on the skill id so the router sees it.
  return [
    {
      id: `skill.${fm.id}`,
      label: fm.name,
      evidence,
      confidence,
    },
  ];
}

/**
 * Derive `CapabilityEvidence` from a skill's governance metadata. Skills do
 * NOT self-declare evidence — the system maps origin/status into the trust
 * ladder (A5).
 *
 *   active + local                  → 'builtin'   (curated)
 *   active + (a2a | mcp | hub)      → 'synthesized' (external, verified)
 *   probation                       → 'synthesized' (untested locally)
 *   demoted | retired | quarantined → caller should not load — defensive 'inferred'
 */
export function deriveEvidence(fm: SkillMdFrontmatter): CapabilityEvidence {
  if (fm.status === 'demoted' || fm.status === 'retired' || fm.status === 'quarantined') {
    return 'inferred';
  }
  if (fm.status === 'probation') return 'synthesized';
  // status === 'active'
  if (fm.origin === 'local') return 'builtin';
  return 'synthesized';
}

/**
 * Derive a static confidence value for a claim from the skill's tier. Phase-4
 * autonomous-creator outcome data will override this through `effectiveTrust`
 * + Wilson LB; until then the tier ceiling is a sane conservative cap.
 */
export function deriveConfidence(tier: ConfidenceTier): number {
  return TIER_CONFIDENCE_CEILING[tier];
}

// ── Skill prompt envelope ────────────────────────────────────────────

/**
 * Maximum chars per skill card injected into a system prompt. Whole-block-or-skip:
 * if a card would exceed the cap, the renderer omits it entirely and emits an
 * `agent:skill_skipped_too_large` warning rather than corrupting the prompt by
 * mid-skill truncation (risk C5 mitigation).
 */
export const MAX_SKILL_CARD_CHARS = 1500;

export interface SkillCardView {
  /** Stable id, e.g. `local:typescript-coding@1.4.0`. */
  source: string;
  /** Content hash for in-band integrity verification (A4). */
  hash: string | null;
  tier: ConfidenceTier;
  status: SkillMdFrontmatter['status'];
  /** Pre-rendered L0 view text (excludes envelope). */
  body: string;
}

/** Build a card view from a parsed skill record. The body is the L0 catalog text. */
export function toSkillCardView(skill: SkillMdRecord): SkillCardView {
  const fm = skill.frontmatter;
  const lines: string[] = [
    `${fm.name} (${fm.id}@${fm.version}) — ${fm.description}`,
    `tier: ${fm.confidence_tier} | origin: ${fm.origin} | status: ${fm.status}`,
  ];
  if (fm.requires_toolsets.length > 0) {
    lines.push(`requires: ${fm.requires_toolsets.join(', ')}`);
  }
  if (skill.body.whenToUse) {
    lines.push('when to use:');
    lines.push(skill.body.whenToUse.trim());
  }
  return {
    source: `${fm.origin}:${fm.id}@${fm.version}`,
    hash: fm.content_hash ?? null,
    tier: fm.confidence_tier,
    status: fm.status,
    body: lines.join('\n'),
  };
}

/**
 * Render a skill card as an integrity-stamped envelope. The envelope wraps
 * authored prose (which the LLM may interpret as instructions) with hash and
 * source metadata so prompt-injection attempts inside skill bodies are
 * structurally distinguishable from system instructions (risk H5 mitigation).
 *
 * Returns null when the rendered card would exceed `MAX_SKILL_CARD_CHARS` —
 * callers should skip the skill rather than truncate.
 */
export function renderSkillCard(view: SkillCardView): string | null {
  const open = `<skill-card source="${view.source}" hash="${view.hash ?? 'unsigned'}" tier="${view.tier}" status="${view.status}">`;
  const close = '</skill-card>';
  const card = `${open}\n${view.body}\n${close}`;
  if (card.length > MAX_SKILL_CARD_CHARS) return null;
  return card;
}

// ── internal helpers ────────────────────────────────────────────────

interface ResolveOk {
  ok: true;
  record: SkillMdRecord;
}
interface ResolveErr {
  ok: false;
  reason: SkillSkipReason;
  detail?: string;
}

function tryResolveSkill(ref: SkillRef, resolver: SyncSkillResolver): ResolveOk | ResolveErr {
  const record = resolver.resolve(ref);
  if (!record) return { ok: false, reason: 'not-found' };
  const fm = record.frontmatter;

  if (fm.status === 'demoted') return { ok: false, reason: 'demoted' };
  if (fm.status === 'retired') return { ok: false, reason: 'retired' };
  if (fm.status === 'quarantined') return { ok: false, reason: 'quarantined' };

  if (ref.pinnedVersion && ref.pinnedVersion !== fm.version) {
    return { ok: false, reason: 'version-mismatch', detail: `pinned ${ref.pinnedVersion}, got ${fm.version}` };
  }
  if (ref.contentHash && ref.contentHash !== fm.content_hash) {
    return {
      ok: false,
      reason: 'pin-mismatch',
      detail: `pinned ${ref.contentHash.slice(0, 18)}…, got ${fm.content_hash?.slice(0, 18) ?? 'unsigned'}…`,
    };
  }
  return { ok: true, record };
}

const TIER_ORDER: Record<ConfidenceTier, number> = {
  deterministic: 0,
  heuristic: 1,
  pragmatic: 2,
  probabilistic: 3,
  speculative: 4,
};

function deterministicSkillOrder(a: SkillMdRecord, b: SkillMdRecord): number {
  const ta = TIER_ORDER[a.frontmatter.confidence_tier];
  const tb = TIER_ORDER[b.frontmatter.confidence_tier];
  if (ta !== tb) return ta - tb;
  return a.frontmatter.id.localeCompare(b.frontmatter.id);
}

function cloneClaim(c: CapabilityClaim): CapabilityClaim {
  return {
    ...c,
    fileExtensions: c.fileExtensions ? [...c.fileExtensions] : undefined,
    actionVerbs: c.actionVerbs ? [...c.actionVerbs] : undefined,
    domains: c.domains ? [...c.domains] : undefined,
    frameworkMarkers: c.frameworkMarkers ? [...c.frameworkMarkers] : undefined,
  };
}

/**
 * Last claim with a given id wins. Lets a more recently loaded skill replace
 * an earlier persona's builtin claim of the same id (e.g. a TypeScript skill
 * promoting `code.mutation.ts` from coarse 'builtin' to specific 'synthesized'
 * with file extensions).
 */
function dedupeClaimsByLast(claims: CapabilityClaim[]): CapabilityClaim[] {
  const byId = new Map<string, CapabilityClaim>();
  for (const c of claims) byId.set(c.id, c);
  return [...byId.values()];
}
