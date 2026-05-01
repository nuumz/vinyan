/**
 * Memory Wiki — public exports.
 *
 * Wire the subsystem with:
 *
 *   import { MemoryWiki } from '@vinyan/memory/wiki';
 *
 *   const wiki = MemoryWiki.create({ db, workspace, bus });
 *   wiki.ingestor.ingestSession({...});
 *   const pack = wiki.retriever.getContextPack({...});
 *
 * `MemoryWiki.create()` is a one-shot wirer that constructs the store,
 * writer, retriever, ingestor, lint, and consolidation in the right
 * order, and returns them as a single bundle. Tests typically wire
 * pieces individually instead of going through the helper.
 */
import type { Database } from 'bun:sqlite';
import type { VinyanBus } from '../../core/bus.ts';
import type { MemoryProvider } from '../provider/types.ts';
import { MemoryWikiConsolidation } from './consolidation.ts';
import { MemoryWikiIngestor } from './ingest.ts';
import { MemoryWikiLint } from './lint.ts';
import { PageWriter } from './page-writer.ts';
import { MemoryWikiRetriever } from './retrieval.ts';
import { MemoryWikiStore } from './store.ts';
import { ensureVaultDirs, resolveVaultLayout, type VaultLayout, type VaultOptions } from './vault.ts';

export interface CreateMemoryWikiOptions {
  readonly db: Database;
  readonly workspace: string;
  readonly bus?: VinyanBus;
  readonly memoryProvider?: MemoryProvider;
  readonly clock?: () => number;
  readonly vault?: Pick<VaultOptions, 'rootOverride' | 'readOnly'>;
  /** Default actor for ingestor-driven proposals. Default `'system:memory-wiki'`. */
  readonly defaultActor?: string;
  /** Strict-wikilinks default for the writer. Default `false` (broken links → lint). */
  readonly strictWikilinks?: boolean;
  /** Skip filesystem vault scaffolding (test mode). Default `false`. */
  readonly skipVault?: boolean;
}

export interface MemoryWikiBundle {
  readonly store: MemoryWikiStore;
  readonly writer: PageWriter;
  readonly retriever: MemoryWikiRetriever;
  readonly ingestor: MemoryWikiIngestor;
  readonly lint: MemoryWikiLint;
  readonly consolidation: MemoryWikiConsolidation;
  readonly layout: VaultLayout | null;
}

export const MemoryWiki = {
  create(opts: CreateMemoryWikiOptions): MemoryWikiBundle {
    const layout: VaultLayout | null = opts.skipVault
      ? null
      : resolveVaultLayout({
          workspace: opts.workspace,
          ...(opts.vault?.rootOverride ? { rootOverride: opts.vault.rootOverride } : {}),
          ...(opts.vault?.readOnly ? { readOnly: opts.vault.readOnly } : {}),
        });
    if (layout && !opts.vault?.readOnly) {
      try {
        ensureVaultDirs(layout);
      } catch {
        /* DB still authoritative; vault scaffolding failure is recoverable */
      }
    }

    const store = new MemoryWikiStore(opts.db, opts.clock ? { clock: opts.clock } : undefined);
    const writer = new PageWriter({
      store,
      ...(layout ? { layout } : {}),
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.strictWikilinks !== undefined ? { strictWikilinks: opts.strictWikilinks } : {}),
    });
    const retriever = new MemoryWikiRetriever({
      store,
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const ingestor = new MemoryWikiIngestor({
      store,
      writer,
      ...(layout ? { layout } : {}),
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.defaultActor ? { defaultActor: opts.defaultActor } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const lint = new MemoryWikiLint({
      store,
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });
    const consolidation = new MemoryWikiConsolidation({
      store,
      writer,
      ...(opts.bus ? { bus: opts.bus } : {}),
      ...(opts.memoryProvider ? { memoryProvider: opts.memoryProvider } : {}),
      ...(opts.clock ? { clock: opts.clock } : {}),
    });

    return { store, writer, retriever, ingestor, lint, consolidation, layout };
  },
};

export { renderContextPackPrompt } from './retrieval.ts';
export {
  computeBodyHash,
  derivePageId,
  deriveSourceId,
  extractProtectedSections,
  mergeProtectedSections,
  parseFrontmatter,
  renderFrontmatter,
} from './schema.ts';
// Re-export public types for callers.
export * from './types.ts';
export { ensureVaultDirs, resolveVaultLayout } from './vault.ts';
export { normalizeTarget, parseWikilinks } from './wikilink-parser.ts';
