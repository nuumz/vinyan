/**
 * Redaction tests — behavior-only. Every test exercises a public function.
 *
 * The privacy invariant under test: redaction runs BEFORE hashing, so any
 * tampered input changes the SHA downstream. We don't test the exporter's
 * hash directly here (see exporter.test.ts) — we verify the primitives.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  applyPolicy,
  BUILT_IN_POLICY,
  hashPolicy,
  loadPolicy,
  type RedactionPolicy,
} from '../../src/trajectory/redaction.ts';

describe('applyPolicy', () => {
  test('redacts /Users/<name>/ prefixes', () => {
    const out = applyPolicy('open /Users/alice/code/foo.ts please', BUILT_IN_POLICY);
    expect(out).toContain('<HOME>');
    expect(out).not.toContain('/Users/alice');
  });

  test('redacts /home/<name>/ prefixes', () => {
    const out = applyPolicy('path=/home/bob/project/a.ts', BUILT_IN_POLICY);
    expect(out).toContain('<HOME>');
    expect(out).not.toContain('/home/bob');
  });

  test('redacts high-entropy tokens ≥24 chars', () => {
    const token = 'sk-ABCdef123XYZ789ghiJKL987MNopq';
    const out = applyPolicy(`key=${token} stuff`, BUILT_IN_POLICY);
    expect(out).toContain('<REDACTED_TOKEN>');
    expect(out).not.toContain(token);
  });

  test('leaves short tokens and plain English alone', () => {
    const out = applyPolicy('the quick brown fox jumps over the lazy dog', BUILT_IN_POLICY);
    expect(out).toBe('the quick brown fox jumps over the lazy dog');
  });

  test('redacts env-looking KEY=VALUE assignments', () => {
    const out = applyPolicy('OPENAI_API_KEY=sk-plain-abc', BUILT_IN_POLICY);
    expect(out).toContain('<ENV>');
    expect(out).not.toContain('sk-plain-abc');
  });

  test('bypass attempt changes the downstream hash', () => {
    // Simulate the exporter pipeline: redact, gzip, hash.
    const good = applyPolicy('touch /Users/x/secret.env', BUILT_IN_POLICY);
    const tampered = 'touch /Users/x/secret.env'; // skipped redaction

    const hashGood = createHash('sha256')
      .update(gzipSync(Buffer.from(good)))
      .digest('hex');
    const hashTampered = createHash('sha256')
      .update(gzipSync(Buffer.from(tampered)))
      .digest('hex');

    expect(hashGood).not.toBe(hashTampered);
  });
});

describe('hashPolicy', () => {
  test('is stable across key reordering', () => {
    const a: RedactionPolicy = {
      version: 'v1',
      rules: [
        { kind: 'high-entropy-token', minLength: 24, replacement: '<X>' },
        { kind: 'home-path', replacement: '<H>' },
      ],
    };
    // Construct an equivalent policy with object keys in reversed order.
    // applyPolicy doesn't care about key order; hashPolicy canonicalizes.
    const b: RedactionPolicy = JSON.parse(
      JSON.stringify({
        rules: [
          { replacement: '<X>', kind: 'high-entropy-token', minLength: 24 },
          { replacement: '<H>', kind: 'home-path' },
        ],
        version: 'v1',
      }),
    );
    expect(hashPolicy(a)).toBe(hashPolicy(b));
  });

  test('differs when a rule actually changes', () => {
    const a: RedactionPolicy = {
      version: 'v1',
      rules: [{ kind: 'home-path', replacement: '<HOME>' }],
    };
    const b: RedactionPolicy = {
      version: 'v1',
      rules: [{ kind: 'home-path', replacement: '<ELSEWHERE>' }],
    };
    expect(hashPolicy(a)).not.toBe(hashPolicy(b));
  });
});

describe('loadPolicy', () => {
  test('returns BUILT_IN_POLICY when file is missing', () => {
    const p = loadPolicy('/does/not/exist/path/policy.json');
    expect(p.version).toBe('built-in-v1');
    expect(p.rules.length).toBeGreaterThan(0);
  });
});
