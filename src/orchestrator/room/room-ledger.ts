/**
 * RoomLedger — append-only, in-memory, hash-chained log of room messages.
 *
 * Each entry binds to its predecessor via `prevHash = previous.contentHash`
 * and computes its own `contentHash = sha256(canonicalJson(entry))` excluding
 * the hashes themselves. Tampering with any prior entry breaks the chain and
 * `verifyIntegrity()` detects it.
 *
 * A4 Content-Addressed Truth: every committed message is bound to a hash of
 * its payload + position. A3 determinism: canonical JSON ensures the same
 * payload produces the same hash across runs. No I/O.
 */
import { createHash } from 'node:crypto';
import { LEDGER_GENESIS_PREV_HASH, type LedgerEntry, type LedgerEntryType } from './types.ts';

/** Input to `RoomLedger.append()` — the caller provides everything except
 *  `seq`, `contentHash`, and `prevHash`, which the ledger assigns. */
export interface LedgerAppendInput {
  author: string;
  authorRole: string;
  type: LedgerEntryType;
  payload: unknown;
  /** Optional timestamp override (for deterministic tests). */
  timestamp?: number;
}

/** Stable, key-sorted JSON stringification for deterministic hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export class RoomLedger {
  private entries: LedgerEntry[] = [];
  /** Timestamp source — injectable for deterministic tests. */
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /** Append a new entry. Seq + hashes are assigned; the returned entry is immutable. */
  append(input: LedgerAppendInput): LedgerEntry {
    const seq = this.entries.length;
    // biome-ignore lint/style/noNonNullAssertion: seq > 0 guarantees the prior entry exists.
    const prevHash = seq === 0 ? LEDGER_GENESIS_PREV_HASH : this.entries[seq - 1]!.contentHash;
    const timestamp = input.timestamp ?? this.clock();
    const contentHash = sha256Hex(
      canonicalJson({
        seq,
        prevHash,
        timestamp,
        author: input.author,
        authorRole: input.authorRole,
        type: input.type,
        payload: input.payload,
      }),
    );
    const entry: LedgerEntry = {
      seq,
      timestamp,
      author: input.author,
      authorRole: input.authorRole,
      type: input.type,
      contentHash,
      prevHash,
      payload: input.payload,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Return a shallow copy of the full chain. */
  readAll(): LedgerEntry[] {
    return [...this.entries];
  }

  /** Return entries with `seq >= sinceSeq` (inclusive). */
  readSince(sinceSeq: number): LedgerEntry[] {
    if (sinceSeq <= 0) return this.readAll();
    return this.entries.slice(sinceSeq);
  }

  /** Latest entry or undefined when the ledger is empty. */
  latest(): LedgerEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** Number of entries. */
  size(): number {
    return this.entries.length;
  }

  /**
   * Recompute every contentHash + prevHash linkage. Returns `true` when the
   * chain is intact, `false` when any entry has been mutated out-of-band.
   * Intended for tests and R2 crash-recovery replay.
   */
  verifyIntegrity(): boolean {
    let expectedPrevHash = LEDGER_GENESIS_PREV_HASH;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.seq !== i) return false;
      if (entry.prevHash !== expectedPrevHash) return false;
      const recomputed = sha256Hex(
        canonicalJson({
          seq: entry.seq,
          prevHash: entry.prevHash,
          timestamp: entry.timestamp,
          author: entry.author,
          authorRole: entry.authorRole,
          type: entry.type,
          payload: entry.payload,
        }),
      );
      if (recomputed !== entry.contentHash) return false;
      expectedPrevHash = entry.contentHash;
    }
    return true;
  }
}
