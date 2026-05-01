/**
 * Memory Wiki — vault filesystem layer.
 *
 * The vault is the human-readable projection of the wiki DB:
 *   .vinyan/wiki/raw/<source-id>.md         — immutable source snapshots
 *   .vinyan/wiki/pages/<type>/<page-id>.md  — compiled pages
 *   .vinyan/wiki/index.md                   — top-level MOC
 *   .vinyan/wiki/log.md                     — append-only operation log
 *   .vinyan/wiki/MEMORY_SCHEMA.md           — schema reference
 *
 * Path safety:
 *   - all writes resolve under the configured vault root (rejected otherwise);
 *   - symlinks rejected (lstat check before write);
 *   - file size capped per write;
 *   - atomic write via temp + rename.
 *
 * The DB is the source of truth. Vault files are projections — the vault
 * can be deleted and regenerated from the DB.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  computeBodyHash,
  FRONTMATTER_FENCE,
  type PageFrontmatter,
  parseFrontmatter,
  renderFrontmatter,
} from './schema.ts';
import {
  MAX_PAGE_BODY_BYTES,
  MAX_SOURCE_BODY_BYTES,
  type WikiPage,
  type WikiSource,
  type WikiSourceRef,
} from './types.ts';

export interface VaultLayout {
  readonly root: string;
  readonly raw: string;
  readonly pages: string;
  readonly moc: string;
  readonly tasks: string;
  readonly agents: string;
  readonly index: string;
  readonly log: string;
  readonly schema: string;
}

export interface VaultOptions {
  /** Workspace root. Vault is rooted at `<workspace>/.vinyan/wiki/`. */
  readonly workspace: string;
  /** Override vault root (test injection). */
  readonly rootOverride?: string;
  /** Skip filesystem writes (test/headless mode). DB still authoritative. */
  readonly readOnly?: boolean;
}

const VAULT_DIR_NAME = '.vinyan';
const WIKI_SUBDIR = 'wiki';

export function resolveVaultLayout(opts: VaultOptions): VaultLayout {
  const root = opts.rootOverride ? resolve(opts.rootOverride) : resolve(opts.workspace, VAULT_DIR_NAME, WIKI_SUBDIR);
  return {
    root,
    raw: join(root, 'raw'),
    pages: join(root, 'pages'),
    moc: join(root, 'moc'),
    tasks: join(root, 'tasks'),
    agents: join(root, 'agents'),
    index: join(root, 'index.md'),
    log: join(root, 'log.md'),
    schema: join(root, 'MEMORY_SCHEMA.md'),
  };
}

// ── Path safety ─────────────────────────────────────────────────────────

/**
 * Verify that `target` resolves under `root`. Rejects:
 *   - parent escapes via `..`
 *   - absolute paths outside root
 *   - existing path that is a symlink (so rewriting it can't redirect to /etc/...).
 */
export function assertPathSafe(root: string, target: string): void {
  const absRoot = resolve(root);
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(absRoot, target);
  const rel = relative(absRoot, absTarget);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`vault: path escapes root (${target})`);
  }
  if (existsSync(absTarget)) {
    const stat = lstatSync(absTarget);
    if (stat.isSymbolicLink()) {
      throw new Error(`vault: refusing to overwrite symlink at ${target}`);
    }
  }
}

/**
 * Filename-safe slug: caps the slug length and rejects characters outside
 * `[a-z0-9-]`. The caller (writer/ingestor) is expected to derive ids
 * via `derivePageId` which already produces safe slugs; this is a
 * defense-in-depth check before turning the id into a path component.
 */
export function safeIdComponent(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`vault: unsafe id component (${id})`);
  }
  if (id.length > 100) {
    throw new Error(`vault: id too long (${id.length})`);
  }
  return id;
}

// ── Atomic write ────────────────────────────────────────────────────────

function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempName = `.${createHash('sha256').update(`${path}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16)}.tmp`;
  const tempPath = join(dir, tempName);
  writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tempPath, path);
}

// ── Page paths / serialization ──────────────────────────────────────────

export function pagePath(layout: VaultLayout, page: WikiPage): string {
  safeIdComponent(page.id);
  return join(layout.pages, page.type, `${page.id}.md`);
}

export function renderPageFile(page: WikiPage): string {
  if (page.body.length > MAX_PAGE_BODY_BYTES) {
    throw new Error(`vault: page body too large (${page.body.length} bytes)`);
  }
  const fm: PageFrontmatter = {
    id: page.id,
    type: page.type,
    title: page.title,
    aliases: [...page.aliases],
    tags: [...page.tags],
    sourceHashes: page.sources.map((s) => s.contentHash),
    evidenceTier: page.evidenceTier,
    confidence: page.confidence,
    lifecycle: page.lifecycle,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    ...(page.validUntil !== undefined ? { validUntil: page.validUntil } : {}),
    protectedSections: [...page.protectedSections],
    profile: page.profile,
    bodyHash: page.bodyHash,
    schemaVersion: 1,
  };
  return `${renderFrontmatter(fm)}\n\n${page.body}\n`;
}

export function readPageFile(path: string): { fm: Partial<PageFrontmatter>; body: string } | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return null;
  const content = readFileSync(path, { encoding: 'utf-8' });
  return parseFrontmatter(content);
}

export function writePageFile(layout: VaultLayout, page: WikiPage): void {
  const path = pagePath(layout, page);
  assertPathSafe(layout.root, path);
  atomicWrite(path, renderPageFile(page));
}

// ── Source paths ────────────────────────────────────────────────────────

const RAW_FRONTMATTER_LINES = (s: WikiSource): string[] => [
  FRONTMATTER_FENCE,
  `id: ${s.id}`,
  `kind: ${s.kind}`,
  `contentHash: ${s.contentHash}`,
  `createdAt: ${s.createdAt}`,
  `profile: ${s.provenance.profile}`,
  ...(s.provenance.sessionId ? [`sessionId: ${s.provenance.sessionId}`] : []),
  ...(s.provenance.taskId ? [`taskId: ${s.provenance.taskId}`] : []),
  ...(s.provenance.agentId ? [`agentId: ${s.provenance.agentId}`] : []),
  ...(s.provenance.user ? [`user: ${s.provenance.user}`] : []),
  FRONTMATTER_FENCE,
];

export function sourcePath(layout: VaultLayout, source: WikiSource): string {
  safeIdComponent(source.id.slice(0, 64));
  return join(layout.raw, `${source.id}.md`);
}

export function renderSourceFile(source: WikiSource): string {
  if (source.body.length > MAX_SOURCE_BODY_BYTES) {
    throw new Error(`vault: source body too large (${source.body.length} bytes)`);
  }
  const fm = RAW_FRONTMATTER_LINES(source).join('\n');
  return `${fm}\n\n${source.body}\n`;
}

export function writeSourceFile(layout: VaultLayout, source: WikiSource): void {
  const path = sourcePath(layout, source);
  assertPathSafe(layout.root, path);
  atomicWrite(path, renderSourceFile(source));
}

// ── Log + index ─────────────────────────────────────────────────────────

export interface LogEntry {
  readonly ts: number;
  readonly op: string;
  readonly actor: string;
  readonly pageId?: string;
  readonly sourceId?: string;
  readonly reason?: string;
}

export function appendLogEntry(layout: VaultLayout, entry: LogEntry): void {
  const ts = new Date(entry.ts).toISOString();
  const subject = entry.pageId ?? entry.sourceId ?? '-';
  const reason = entry.reason ? ` — ${entry.reason}` : '';
  const line = `- ${ts} | ${entry.op} | ${subject} | ${entry.actor}${reason}\n`;
  const path = layout.log;
  assertPathSafe(layout.root, path);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, '# Memory Wiki — Operation Log\n\n', { encoding: 'utf-8' });
  }
  // append (not atomic — append is OS-atomic for small writes on POSIX/APFS)
  const fd = require('node:fs').openSync(path, 'a');
  try {
    require('node:fs').writeSync(fd, line);
  } finally {
    require('node:fs').closeSync(fd);
  }
}

export function writeIndexFile(layout: VaultLayout, pages: readonly WikiPage[], generatedAt: number): void {
  const path = layout.index;
  assertPathSafe(layout.root, path);
  const byType = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const list = byType.get(page.type) ?? [];
    list.push(page);
    byType.set(page.type, list);
  }
  const lines: string[] = [
    '# Memory Wiki — Index',
    '',
    `Generated: ${new Date(generatedAt).toISOString()}`,
    `Pages: ${pages.length}`,
    '',
  ];
  const sortedTypes = [...byType.keys()].sort();
  for (const type of sortedTypes) {
    lines.push(`## ${type}`);
    lines.push('');
    const list = byType.get(type) ?? [];
    list.sort((a, b) => a.title.localeCompare(b.title));
    for (const page of list) {
      const status = page.lifecycle === 'canonical' ? '' : ` _(${page.lifecycle})_`;
      lines.push(`- [[${page.id}|${page.title}]]${status}`);
    }
    lines.push('');
  }
  atomicWrite(path, lines.join('\n'));
}

// ── Schema reference ────────────────────────────────────────────────────

const SCHEMA_REFERENCE = `# MEMORY_SCHEMA — Vinyan Memory Wiki

This file is generated by Vinyan and consumed by both humans and the
Memory Wiki validator. Do not edit fields prefixed with \`schemaVersion\`
without bumping the version number — the writer rejects pages whose
schemaVersion is unknown.

## Page types
- concept, entity, project, decision, failure-pattern,
  workflow-pattern, source-summary, task-memory, agent-profile,
  open-question.

## Lifecycle states
- draft, canonical, stale, disputed, archived.

## Citation
Every \`canonical\` page must cite at least one source via
\`sourceHashes:\` in frontmatter and at least one inline \`[Source: <hash>]\`
reference in the body.

## Wikilinks
Use \`[[target]]\` for default \`mentions\` edges, or
\`[[<edge-type>:target]]\` for typed edges
(supersedes / cites / contradicts / derived-from / implements / belongs-to).

## Human-protected sections
Wrap content with
\`<!-- human:protected:NAME -->\` and \`<!-- /human:protected:NAME -->\`.
The validator preserves these blocks across rewrites — proposals that
modify the inside of a protected block are rejected.
`;

export function ensureSchemaFile(layout: VaultLayout): void {
  const path = layout.schema;
  assertPathSafe(layout.root, path);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SCHEMA_REFERENCE, { encoding: 'utf-8' });
}

export function ensureVaultDirs(layout: VaultLayout): void {
  for (const dir of [layout.root, layout.raw, layout.pages, layout.moc, layout.tasks, layout.agents]) {
    mkdirSync(dir, { recursive: true });
  }
  ensureSchemaFile(layout);
}
