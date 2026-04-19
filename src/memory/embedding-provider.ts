/**
 * Embedding provider — pluggable vector generator for semantic retrieval.
 *
 * Plan commit E. See /root/.claude/plans/cached-zooming-platypus.md.
 */

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  readonly active: boolean;
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'null';
  readonly active = false;
  constructor(readonly dimension = 1024) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimension));
  }
}

export function embeddingToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
