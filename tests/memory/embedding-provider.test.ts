/**
 * Embedding provider contract + helpers (plan commit E).
 */
import { describe, expect, it } from 'bun:test';
import {
  cosineSimilarity,
  embeddingToBuffer,
  NullEmbeddingProvider,
} from '../../src/memory/embedding-provider.ts';

describe('NullEmbeddingProvider', () => {
  it('returns zero vectors of declared dimension', async () => {
    const provider = new NullEmbeddingProvider(32);
    const [vec] = await provider.embed(['hello']);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(32);
    for (const x of vec!) expect(x).toBe(0);
  });

  it('preserves input order for batch embed', async () => {
    const provider = new NullEmbeddingProvider(4);
    const vecs = await provider.embed(['a', 'b', 'c']);
    expect(vecs).toHaveLength(3);
  });

  it('reports active = false so retriever skips semantic layer', () => {
    const provider = new NullEmbeddingProvider();
    expect(provider.active).toBe(false);
    expect(provider.id).toBe('null');
  });

  it('defaults dimension to 1024 (matches migration036)', () => {
    const provider = new NullEmbeddingProvider();
    expect(provider.dimension).toBe(1024);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns 0 (not NaN) for zero-vectors', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(cosineSimilarity(a, a)).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/);
  });

  it('is symmetric', () => {
    const a = new Float32Array([0.3, 0.7, 0.2]);
    const b = new Float32Array([0.8, 0.1, 0.5]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });
});

describe('embeddingToBuffer', () => {
  it('serializes Float32Array as little-endian float32 bytes', () => {
    const vec = new Float32Array([1.0, 2.0, 3.0]);
    const buf = embeddingToBuffer(vec);
    expect(buf.length).toBe(12); // 3 floats * 4 bytes
    // Round-trip: read back as Float32Array
    const roundTrip = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength / 4,
    );
    expect(Array.from(roundTrip)).toEqual([1.0, 2.0, 3.0]);
  });

  it('handles an empty vector', () => {
    const vec = new Float32Array(0);
    const buf = embeddingToBuffer(vec);
    expect(buf.length).toBe(0);
  });
});
