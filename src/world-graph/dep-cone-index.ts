export interface DependencyEdge {
  fromFile: string;
  toFile: string;
  edgeType?: string;
}

/**
 * In-memory pre-computed dependency adjacency for µs lookups.
 * Replaces WorldGraph SQL-per-BFS-level with Map lookups.
 */
export class DepConeIndex {
  private dependents = new Map<string, Set<string>>();
  private dependencies = new Map<string, Set<string>>();
  private bfsCache = new Map<string, string[]>();
  private dirtyFiles = new Set<string>();

  constructor() {}

  /** Bulk load from dependency edges. Clears all maps, builds both adjacency lists. */
  loadAll(edges: readonly DependencyEdge[]): void {
    this.dependents.clear();
    this.dependencies.clear();
    this.bfsCache.clear();
    this.dirtyFiles.clear();

    for (const edge of edges) {
      this.addEdge(edge.fromFile, edge.toFile);
    }

    // Mark all files dirty so BFS cache is recomputed on first query
    for (const file of this.allFiles()) {
      this.dirtyFiles.add(file);
    }
  }

  /** 1-hop reverse lookup: who depends on (imports) this file. */
  getDependents(file: string): readonly string[] {
    const set = this.dependents.get(file);
    return set ? Array.from(set) : [];
  }

  /** 1-hop forward lookup: what does this file depend on (import). */
  getDependencies(file: string): readonly string[] {
    const set = this.dependencies.get(file);
    return set ? Array.from(set) : [];
  }

  /** BFS reverse traversal using in-memory adjacency. Caches result per file. */
  queryDependents(file: string, maxDepth = 3): readonly string[] {
    const cacheKey = `${file}:${maxDepth}`;

    if (!this.dirtyFiles.has(file) && this.bfsCache.has(cacheKey)) {
      return this.bfsCache.get(cacheKey)!;
    }

    const visited = new Set<string>();
    let frontier = [file];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const current of frontier) {
        const deps = this.dependents.get(current);
        if (!deps) continue;
        for (const dep of deps) {
          if (dep !== file && !visited.has(dep)) {
            visited.add(dep);
            nextFrontier.push(dep);
          }
        }
      }
      frontier = nextFrontier;
    }

    const result = Array.from(visited);
    this.bfsCache.set(cacheKey, result);
    this.dirtyFiles.delete(file);
    return result;
  }

  /** Incremental update: replace all edges from `fromFile` with new targets. */
  updateEdges(fromFile: string, toFiles: readonly string[]): void {
    // Remove old edges
    const oldTargets = this.dependencies.get(fromFile);
    if (oldTargets) {
      for (const target of oldTargets) {
        const revSet = this.dependents.get(target);
        if (revSet) {
          revSet.delete(fromFile);
          if (revSet.size === 0) this.dependents.delete(target);
        }
      }
      this.dependencies.delete(fromFile);
    }

    // Add new edges
    for (const toFile of toFiles) {
      this.addEdge(fromFile, toFile);
    }

    // Clear entire BFS cache — transitive results may be stale
    this.bfsCache.clear();
    this.dirtyFiles.clear();
  }

  /** Remove all edges where fromFile = file. */
  removeEdgesForFile(file: string): void {
    const targets = this.dependencies.get(file);
    if (!targets) return;

    for (const target of targets) {
      const revSet = this.dependents.get(target);
      if (revSet) {
        revSet.delete(file);
        if (revSet.size === 0) this.dependents.delete(target);
      }
    }
    this.dependencies.delete(file);

    // Clear entire BFS cache — transitive results may be stale
    this.bfsCache.clear();
    this.dirtyFiles.clear();
  }

  get fileCount(): number {
    return this.allFiles().size;
  }

  get edgeCount(): number {
    let count = 0;
    for (const set of this.dependencies.values()) {
      count += set.size;
    }
    return count;
  }

  private addEdge(fromFile: string, toFile: string): void {
    let fwdSet = this.dependencies.get(fromFile);
    if (!fwdSet) {
      fwdSet = new Set();
      this.dependencies.set(fromFile, fwdSet);
    }
    fwdSet.add(toFile);

    let revSet = this.dependents.get(toFile);
    if (!revSet) {
      revSet = new Set();
      this.dependents.set(toFile, revSet);
    }
    revSet.add(fromFile);
  }

  private markDirty(file: string): void {
    this.dirtyFiles.add(file);
    // Also invalidate BFS cache entries for this file
    for (const key of this.bfsCache.keys()) {
      if (key.startsWith(`${file}:`)) {
        this.bfsCache.delete(key);
      }
    }
  }

  private allFiles(): Set<string> {
    const files = new Set<string>();
    for (const key of this.dependencies.keys()) files.add(key);
    for (const key of this.dependents.keys()) files.add(key);
    return files;
  }
}
