import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TranscriptAccessError,
  TranscriptReader,
} from '../../../src/orchestrator/external-coding-cli/external-coding-cli-transcript-reader.ts';

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyan-transcript-'));
  return dir;
}

describe('TranscriptReader', () => {
  test('reads inside root', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'log.txt'), 'hello');
    const reader = new TranscriptReader({ root });
    expect(reader.read('log.txt')).toBe('hello');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('blocks path traversal outside root', () => {
    const root = makeRoot();
    const reader = new TranscriptReader({ root });
    expect(() => reader.read('../etc/passwd')).toThrow(TranscriptAccessError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('blocks symlinks', () => {
    const root = makeRoot();
    const target = path.join(os.tmpdir(), 'vinyan-symlink-target.txt');
    fs.writeFileSync(target, 'secret');
    const link = path.join(root, 'evil');
    fs.symlinkSync(target, link);
    const reader = new TranscriptReader({ root });
    expect(() => reader.read('evil')).toThrow(TranscriptAccessError);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
  });

  test('rejects oversized file', () => {
    const root = makeRoot();
    const file = path.join(root, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(2_000));
    const reader = new TranscriptReader({ root, maxBytes: 100 });
    expect(() => reader.read('big.txt')).toThrow(TranscriptAccessError);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('readTail returns last bytes', () => {
    const root = makeRoot();
    const file = path.join(root, 'tail.txt');
    fs.writeFileSync(file, 'a'.repeat(100) + 'TAIL');
    const reader = new TranscriptReader({ root });
    const tail = reader.readTail('tail.txt', 4);
    expect(tail).toBe('TAIL');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
