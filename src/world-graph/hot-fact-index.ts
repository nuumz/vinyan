import type { Fact } from '../core/types.ts';

/**
 * In-memory read cache for WorldGraph facts.
 * Provides O(1) lookups by target, sourceFile, and id.
 */
export class HotFactIndex {
  private factsByTarget = new Map<string, Fact[]>();
  private factsBySourceFile = new Map<string, Set<string>>();
  private factsById = new Map<string, Fact>();

  /** Bulk load from SQLite at boot. Clears existing maps, populates all three indices. */
  loadAll(facts: readonly Fact[]): void {
    this.factsByTarget.clear();
    this.factsBySourceFile.clear();
    this.factsById.clear();

    for (const fact of facts) {
      this.insertIntoIndices(fact);
    }
  }

  /** Pure Map.get lookup. Excludes expired facts (validUntil < Date.now()). */
  query(target: string): readonly Fact[] {
    const bucket = this.factsByTarget.get(target);
    if (!bucket) return [];
    const now = Date.now();
    return bucket.filter((f) => f.validUntil === undefined || f.validUntil >= now);
  }

  /** Add or update a fact in all indices. Handles target-bucket migration on update. */
  upsert(fact: Fact): void {
    const existing = this.factsById.get(fact.id);
    if (existing) {
      this.removeFromIndices(existing);
    }
    this.insertIntoIndices(fact);
  }

  /** Remove ALL facts whose sourceFile matches filePath. */
  invalidateByFile(filePath: string): void {
    const ids = this.factsBySourceFile.get(filePath);
    if (!ids) return;

    for (const id of ids) {
      const fact = this.factsById.get(id);
      if (fact) {
        this.removeFromTargetBucket(fact);
        this.factsById.delete(id);
      }
    }
    this.factsBySourceFile.delete(filePath);
  }

  /** Remove a single fact by id from all indices. */
  remove(factId: string): void {
    const fact = this.factsById.get(factId);
    if (!fact) return;
    this.removeFromIndices(fact);
  }

  get size(): number {
    return this.factsById.size;
  }

  get targetCount(): number {
    return this.factsByTarget.size;
  }

  private insertIntoIndices(fact: Fact): void {
    this.factsById.set(fact.id, fact);

    let bucket = this.factsByTarget.get(fact.target);
    if (!bucket) {
      bucket = [];
      this.factsByTarget.set(fact.target, bucket);
    }
    bucket.push(fact);

    let fileSet = this.factsBySourceFile.get(fact.sourceFile);
    if (!fileSet) {
      fileSet = new Set();
      this.factsBySourceFile.set(fact.sourceFile, fileSet);
    }
    fileSet.add(fact.id);
  }

  private removeFromIndices(fact: Fact): void {
    this.removeFromTargetBucket(fact);
    this.factsById.delete(fact.id);

    const fileSet = this.factsBySourceFile.get(fact.sourceFile);
    if (fileSet) {
      fileSet.delete(fact.id);
      if (fileSet.size === 0) {
        this.factsBySourceFile.delete(fact.sourceFile);
      }
    }
  }

  private removeFromTargetBucket(fact: Fact): void {
    const bucket = this.factsByTarget.get(fact.target);
    if (!bucket) return;
    const idx = bucket.findIndex((f) => f.id === fact.id);
    if (idx !== -1) {
      bucket.splice(idx, 1);
    }
    if (bucket.length === 0) {
      this.factsByTarget.delete(fact.target);
    }
  }
}
