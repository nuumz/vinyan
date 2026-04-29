/**
 * Unified Skill Library catalog service — single read-side aggregator that
 * fans out to the three Vinyan skill stores so the `/api/v1/skills`
 * endpoint can return one consistent surface to the UI.
 *
 *   - **Simple** (Claude-Code-compatible) — user-authored SKILL.md files
 *     loaded by the `SimpleSkillRegistry`. Editable via the API: `editable: true`.
 *   - **Heavy** (epistemic runtime SKILL.md) — content-hashed,
 *     trust-laddered skills owned by `SkillArtifactStore`. Read-only at this
 *     surface; lifecycle goes through the hub importer + trust ledger
 *     (`/api/v1/skills/import` if/when wired). `editable: false`.
 *   - **Cached** (reflex-tier shortcuts) — learned approaches in `cached_skills`.
 *     Promoted by sleep cycle, never directly authored. `editable: false`.
 *
 * The catalog item id encodes the kind so detail/CRUD endpoints route to
 * the correct backing store without ambiguity:
 *
 *   simple:<scope>:<agentId-or-shared>:<name>
 *   heavy:<artifactId>                          (e.g. heavy:local/code-review or heavy:refactor/extract-method)
 *   cached:<task_signature>
 *
 * Per-agent visibility filtering is intentionally NOT applied here — the
 * catalog surface lists every skill the operator can manage, regardless of
 * persona binding. Filter by `agentId` on the read side when surfacing
 * per-agent context (e.g. the Agent drawer's Skills tab).
 */
import type {
  SkillArtifactStore,
} from '../skills/artifact-store.ts';
import type { SimpleSkill, SimpleSkillScope } from '../skills/simple/loader.ts';
import type { SimpleSkillRegistry } from '../skills/simple/registry.ts';
import type { SkillStore } from '../db/skill-store.ts';
import type { CachedSkill } from '../orchestrator/types.ts';
import type { SkillMdRecord } from '../skills/skill-md/index.ts';

export type SkillCatalogKind = 'simple' | 'heavy' | 'cached';

/**
 * Source bucket — coarser than the simple-skill scope and used by the UI to
 * group/filter without unpacking the kind. `'artifact-store'` covers heavy;
 * `'cached_skills'` covers cached. Per-scope detail still rides on
 * `SkillCatalogItem.scope`.
 */
export type SkillCatalogSource =
  | SimpleSkillScope
  | 'artifact-store'
  | 'cached_skills';

export interface SkillCatalogItem {
  /** Unified id — kind-prefixed. Use as React key and for detail/CRUD. */
  readonly id: string;
  readonly kind: SkillCatalogKind;
  readonly name: string;
  readonly description: string;
  readonly source: SkillCatalogSource;
  /** SimpleSkill scope — only set when `kind: 'simple'`. */
  readonly scope?: SimpleSkillScope;
  /** Set when `kind:'simple'` and scope is per-agent, OR `kind:'cached'` with agent_id. */
  readonly agentId?: string;
  /** True only for simple skills. UI shows Edit / Delete buttons accordingly. */
  readonly editable: boolean;
  /** Filesystem path for simple/heavy. Always omitted for cached. */
  readonly path?: string;
  /** Heavy: 'active'|'quarantined'|'retired'. Cached: 'active'|'probation'|'demoted'. */
  readonly status?: string;
  /** Heavy artifact's confidence tier. */
  readonly trustTier?: string;
  /** Cached only — Wilson-LB success rate. */
  readonly successRate?: number;
  /** Cached only. */
  readonly usageCount?: number;
  /** Heavy: SKILL.md hash. */
  readonly contentHash?: string;
  /** ms epoch — best-effort: cached.lastVerifiedAt for cached, undefined for the rest. */
  readonly lastUpdated?: number;
}

/**
 * Detail payload — extends the list item with full body / approach / etc.
 * Returned by `GET /api/v1/skills/:id`. Body is the raw markdown for simple
 * skills; for heavy skills we surface frontmatter + the rendered L1 body.
 */
export interface SkillCatalogDetail extends SkillCatalogItem {
  /** Markdown body verbatim (simple) OR L1-disclosed authored content (heavy). */
  readonly body?: string;
  /** Cached approach text (cached only). */
  readonly approach?: string;
  /** Heavy frontmatter (subset surfaced to UI) — toolsets, whenToUse, etc. */
  readonly heavyFrontmatter?: Record<string, unknown>;
  /** Heavy whitelisted files for L2 disclosure. */
  readonly files?: readonly string[];
  /** Cached only. */
  readonly probationRemaining?: number;
  /** Cached only. */
  readonly verificationProfile?: string;
  /** Cached only. */
  readonly riskAtCreation?: number;
}

export interface SkillCatalogServiceOptions {
  readonly simpleSkillRegistry?: SimpleSkillRegistry;
  readonly artifactStore?: SkillArtifactStore;
  readonly skillStore?: SkillStore;
}

export class SkillCatalogService {
  constructor(private readonly opts: SkillCatalogServiceOptions) {}

  /** Aggregate every skill across the three backing stores. */
  async list(filters?: { kind?: SkillCatalogKind; agentId?: string }): Promise<SkillCatalogItem[]> {
    const items: SkillCatalogItem[] = [];

    if (!filters?.kind || filters.kind === 'simple') {
      items.push(...this.listSimple());
    }
    if (!filters?.kind || filters.kind === 'heavy') {
      items.push(...(await this.listHeavy()));
    }
    if (!filters?.kind || filters.kind === 'cached') {
      items.push(...this.listCached());
    }

    if (filters?.agentId !== undefined) {
      const id = filters.agentId;
      return items.filter((it) => {
        // Shared-scope items (no agentId) are visible to every agent.
        if (!it.agentId) return true;
        return it.agentId === id;
      });
    }
    return items;
  }

  /**
   * Look up a single item by its unified id. Returns the detail payload
   * (markdown body / approach / etc.) so the UI can render a rich detail
   * drawer in one round-trip. Returns null when the id is unknown — caller
   * decides whether to 404.
   */
  async get(id: string): Promise<SkillCatalogDetail | null> {
    const parsed = parseCatalogId(id);
    if (!parsed) return null;

    if (parsed.kind === 'simple') {
      const skills = this.collectSimpleSkills();
      const match = skills.find((s) => simpleSkillKey(s) === parsed.payload);
      if (!match) return null;
      return simpleToDetail(match);
    }

    if (parsed.kind === 'heavy') {
      if (!this.opts.artifactStore) return null;
      try {
        const record = await this.opts.artifactStore.read(parsed.payload);
        const path = this.opts.artifactStore.pathFor(parsed.payload);
        return heavyToDetail(parsed.payload, record, path);
      } catch {
        return null;
      }
    }

    if (parsed.kind === 'cached') {
      const store = this.opts.skillStore;
      if (!store) return null;
      const all = [
        ...store.findByStatus('active'),
        ...store.findByStatus('probation'),
        ...store.findByStatus('demoted'),
      ];
      const found = all.find((s) => s.taskSignature === parsed.payload);
      if (!found) return null;
      return cachedToDetail(found);
    }

    return null;
  }

  // ── per-kind listers (private) ──────────────────────────────────────

  private listSimple(): SkillCatalogItem[] {
    return this.collectSimpleSkills().map(simpleToItem);
  }

  private async listHeavy(): Promise<SkillCatalogItem[]> {
    if (!this.opts.artifactStore) return [];
    let entries: readonly { id: string; absolutePath: string }[] = [];
    try {
      entries = await this.opts.artifactStore.list();
    } catch {
      return [];
    }
    const out: SkillCatalogItem[] = [];
    for (const { id, absolutePath } of entries) {
      try {
        const record = await this.opts.artifactStore.read(id);
        out.push(heavyToItem(id, record, absolutePath));
      } catch {
        // Skip malformed; A9 — boot/list never fails because of one bad file.
      }
    }
    return out;
  }

  private listCached(): SkillCatalogItem[] {
    const store = this.opts.skillStore;
    if (!store) return [];
    const rows = [
      ...store.findByStatus('active'),
      ...store.findByStatus('probation'),
      ...store.findByStatus('demoted'),
    ];
    return rows.map(cachedToItem);
  }

  private collectSimpleSkills(): readonly SimpleSkill[] {
    return this.opts.simpleSkillRegistry?.getAll() ?? [];
  }
}

// ── id encoding/decoding ────────────────────────────────────────────

interface ParsedCatalogId {
  readonly kind: SkillCatalogKind;
  readonly payload: string;
}

export function parseCatalogId(id: string): ParsedCatalogId | null {
  const sepIdx = id.indexOf(':');
  if (sepIdx <= 0) return null;
  const kind = id.slice(0, sepIdx) as SkillCatalogKind;
  const payload = id.slice(sepIdx + 1);
  if (!payload) return null;
  if (kind !== 'simple' && kind !== 'heavy' && kind !== 'cached') return null;
  return { kind, payload };
}

/** Stable per-skill id payload for the simple bucket (used in `simple:<payload>`). */
export function simpleSkillKey(skill: SimpleSkill): string {
  if (skill.scope === 'user-agent' || skill.scope === 'project-agent') {
    return `${skill.scope}:${skill.agentId}:${skill.name}`;
  }
  return `${skill.scope}:${skill.name}`;
}

export function simpleSkillCatalogId(skill: SimpleSkill): string {
  return `simple:${simpleSkillKey(skill)}`;
}

// ── per-kind transformers ───────────────────────────────────────────

function simpleToItem(skill: SimpleSkill): SkillCatalogItem {
  return {
    id: simpleSkillCatalogId(skill),
    kind: 'simple',
    name: skill.name,
    description: skill.description,
    source: skill.scope,
    scope: skill.scope,
    ...(skill.agentId ? { agentId: skill.agentId } : {}),
    editable: true,
    path: skill.path,
  };
}

function simpleToDetail(skill: SimpleSkill): SkillCatalogDetail {
  return {
    ...simpleToItem(skill),
    body: skill.body,
  };
}

function heavyToItem(id: string, record: SkillMdRecord, path: string): SkillCatalogItem {
  const fm = record.frontmatter;
  return {
    id: `heavy:${id}`,
    kind: 'heavy',
    name: fm.name && fm.name.trim().length > 0 ? fm.name : id,
    // Heavy uses `description` in frontmatter; body holds structured sections.
    description: fm.description ?? record.body.overview ?? '',
    source: 'artifact-store',
    editable: false,
    path,
    ...(fm.status ? { status: fm.status } : {}),
    ...(fm.confidence_tier ? { trustTier: fm.confidence_tier } : {}),
    ...(fm.content_hash ? { contentHash: fm.content_hash } : {}),
  };
}

/**
 * Reassemble the heavy SKILL.md body's structured sections into a single
 * markdown string for UI display. Mirrors the loader's section list so the
 * UI sees authored content even though the body schema is structured.
 */
function composeHeavyBody(record: SkillMdRecord): string {
  const parts: string[] = [];
  const body = record.body;
  if (body.overview) parts.push(`## Overview\n\n${body.overview.trim()}`);
  if (body.whenToUse) parts.push(`## When to Use\n\n${body.whenToUse.trim()}`);
  if (body.preconditions) parts.push(`## Preconditions\n\n${body.preconditions.trim()}`);
  if (body.procedure) parts.push(`## Procedure\n\n${body.procedure.trim()}`);
  if (body.falsification?.raw) parts.push(`## Falsification\n\n${body.falsification.raw.trim()}`);
  if (body.unknownSections) {
    for (const [heading, content] of Object.entries(body.unknownSections)) {
      parts.push(`## ${heading}\n\n${content.trim()}`);
    }
  }
  return parts.join('\n\n');
}

function heavyToDetail(id: string, record: SkillMdRecord, path: string): SkillCatalogDetail {
  const item = heavyToItem(id, record, path);
  const body = composeHeavyBody(record);
  const files = record.body.files;
  return {
    ...item,
    ...(body ? { body } : {}),
    ...(files && files.length > 0 ? { files: [...files] } : {}),
    heavyFrontmatter: record.frontmatter as unknown as Record<string, unknown>,
  };
}

function cachedToItem(row: CachedSkill): SkillCatalogItem {
  return {
    id: `cached:${row.taskSignature}`,
    kind: 'cached',
    name: row.taskSignature,
    description: row.approach,
    source: 'cached_skills',
    ...(row.agentId ? { agentId: row.agentId } : {}),
    editable: false,
    status: row.status,
    successRate: row.successRate,
    usageCount: row.usageCount,
    lastUpdated: row.lastVerifiedAt,
  };
}

function cachedToDetail(row: CachedSkill): SkillCatalogDetail {
  return {
    ...cachedToItem(row),
    approach: row.approach,
    probationRemaining: row.probationRemaining,
    verificationProfile: row.verificationProfile,
    riskAtCreation: row.riskAtCreation,
  };
}
