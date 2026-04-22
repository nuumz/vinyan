/**
 * agentskills.io registry adapter — SKELETON.
 *
 * The public agentskills.io API is not reachable during this PR; the
 * assumed API shape is documented here. Tests exercise this adapter with
 * an injected `fetchImpl` returning fixture responses.
 *
 * Assumed API (subject to change once the real endpoint is reachable):
 *
 *   GET  {base}/api/skills?q=<query>&limit=<n>
 *        200 → JSON array of SkillListingL0-compatible objects:
 *              [{ id, name, version, description, confidenceTier, author? }, ...]
 *        404 → registry offline (treated as empty list)
 *
 *   GET  {base}/api/skills/{id}
 *        200 → {
 *          skill_md: string,
 *          files?: Record<string, string>,
 *          signature?: { algorithm: 'ed25519', signer: string, value: string }
 *        }
 *        404 → SkillNotFoundError
 *
 * When the real endpoint stabilizes this skeleton gets a URL swap and a
 * proper Zod schema for response validation. Not done here to avoid
 * churn from endpoint drift before the first real ping.
 */
import {
  type FetchImpl,
  type SkillFetchResult,
  SkillNotFoundError,
  SkillRegistryError,
  type SkillListingL0,
  type SkillRegistryAdapter,
} from '../registry-adapter.ts';

export interface AgentskillsIoAdapterOptions {
  readonly fetchImpl?: FetchImpl;
  readonly apiBase?: string;
  /** Optional bearer token once the real endpoint gates search. */
  readonly token?: string;
}

interface FetchResponseShape {
  skill_md?: string;
  skillMd?: string;
  files?: Record<string, string>;
  signature?: { algorithm?: string; signer?: string; value?: string };
}

export class AgentskillsIoAdapter implements SkillRegistryAdapter {
  readonly name = 'agentskills-io' as const;

  private readonly fetchImpl: FetchImpl;
  private readonly apiBase: string;
  private readonly token: string | undefined;

  constructor(opts: AgentskillsIoAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? defaultFetchImpl;
    this.apiBase = opts.apiBase ?? 'https://agentskills.io';
    this.token = opts.token;
  }

  async list(query: string, opts?: { limit?: number }): Promise<readonly SkillListingL0[]> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 100));
    const url = `${this.apiBase}/api/skills?q=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await this.request(url);
    if (res === null) return [];

    if (!Array.isArray(res)) {
      throw new SkillRegistryError(
        `agentskills-io /api/skills returned non-array body (${typeof res})`,
        'agentskills-io',
      );
    }
    const listings: SkillListingL0[] = [];
    for (const raw of res) {
      if (!isRecord(raw)) continue;
      const id = strField(raw, 'id');
      const name = strField(raw, 'name');
      const version = strField(raw, 'version') ?? '0.0.0';
      const description = strField(raw, 'description') ?? '';
      const confidenceTier = strField(raw, 'confidenceTier') ?? strField(raw, 'confidence_tier') ?? 'speculative';
      const author = strField(raw, 'author');
      if (!id || !name) continue;
      listings.push({
        id,
        name,
        version,
        description,
        confidenceTier: normalizeTier(confidenceTier),
        ...(author ? { author } : {}),
      });
    }
    return listings;
  }

  async fetch(id: string): Promise<SkillFetchResult> {
    const url = `${this.apiBase}/api/skills/${encodeURIComponent(id)}`;
    const res = await this.request(url);
    if (res === null) {
      throw new SkillNotFoundError('agentskills-io', id);
    }
    if (!isRecord(res)) {
      throw new SkillRegistryError(`agentskills-io fetch for '${id}' returned non-object body`, 'agentskills-io');
    }
    const body = res as FetchResponseShape;
    const skillMd = body.skill_md ?? body.skillMd;
    if (typeof skillMd !== 'string' || skillMd.length === 0) {
      throw new SkillRegistryError(`agentskills-io fetch for '${id}' missing 'skill_md' field`, 'agentskills-io');
    }
    const files = new Map<string, string>();
    if (body.files && typeof body.files === 'object') {
      for (const [key, value] of Object.entries(body.files)) {
        if (typeof value === 'string') files.set(key, value);
      }
    }

    if (
      body.signature &&
      body.signature.algorithm === 'ed25519' &&
      typeof body.signature.signer === 'string' &&
      typeof body.signature.value === 'string'
    ) {
      return {
        skillMd,
        files,
        signature: {
          algorithm: 'ed25519',
          signer: body.signature.signer,
          value: body.signature.value,
        },
      };
    }
    return { skillMd, files };
  }

  private async request(url: string): Promise<unknown | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'vinyan-skills-hub',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const response = await this.fetchImpl(url, { headers }).catch((err: unknown) => {
      throw new SkillRegistryError(
        `agentskills-io request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        'agentskills-io',
        err,
      );
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SkillRegistryError(
        `agentskills-io request failed for ${url}: HTTP ${response.status}`,
        'agentskills-io',
      );
    }
    return response.json();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function normalizeTier(raw: string): SkillListingL0['confidenceTier'] {
  if (raw === 'deterministic' || raw === 'heuristic' || raw === 'probabilistic' || raw === 'speculative') {
    return raw;
  }
  return 'speculative';
}

const defaultFetchImpl: FetchImpl = async (input, init) => {
  const res = await (globalThis.fetch as (...args: unknown[]) => Promise<Response>)(input, init);
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    text: () => res.text(),
    json: () => res.json(),
  };
};
