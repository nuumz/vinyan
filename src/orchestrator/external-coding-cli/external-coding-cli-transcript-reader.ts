/**
 * Transcript reader — safe access to provider-managed transcript files.
 *
 * Security:
 *   - Path traversal blocked: caller passes a session-rooted dir; the reader
 *     only resolves files inside that root.
 *   - Size cap: refuse to read > maxBytes.
 *   - Symlinks are not followed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TranscriptReaderOptions {
  /** Hard root the reader is allowed to access. All reads must stay inside. */
  root: string;
  /** Per-call read cap. Default 16 MiB. */
  maxBytes?: number;
}

export class TranscriptAccessError extends Error {
  constructor(
    public readonly code: 'outside-root' | 'too-large' | 'not-found' | 'symlink-blocked' | 'io-error',
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptAccessError';
  }
}

export class TranscriptReader {
  private readonly rootResolved: string;
  private readonly maxBytes: number;

  constructor(opts: TranscriptReaderOptions) {
    this.rootResolved = path.resolve(opts.root);
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  }

  /** Read the full file as UTF-8, enforcing path/size guards. */
  read(relativeOrAbsolutePath: string): string {
    const abs = this.resolveSafe(relativeOrAbsolutePath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TranscriptAccessError('not-found', `transcript not found: ${abs}`);
      }
      throw new TranscriptAccessError('io-error', (err as Error).message);
    }
    if (stat.isSymbolicLink()) {
      throw new TranscriptAccessError('symlink-blocked', `symlink blocked: ${abs}`);
    }
    if (stat.size > this.maxBytes) {
      throw new TranscriptAccessError(
        'too-large',
        `transcript ${abs} exceeds cap (${stat.size} > ${this.maxBytes})`,
      );
    }
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (err) {
      throw new TranscriptAccessError('io-error', (err as Error).message);
    }
  }

  /** Read trailing chunk (last `bytes`) — useful for live tailing. */
  readTail(relativeOrAbsolutePath: string, bytes: number): string {
    const abs = this.resolveSafe(relativeOrAbsolutePath);
    const cap = Math.min(bytes, this.maxBytes);
    let fd: number | null = null;
    try {
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        throw new TranscriptAccessError('symlink-blocked', `symlink blocked: ${abs}`);
      }
      const start = Math.max(0, stat.size - cap);
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      fd = fs.openSync(abs, 'r');
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf8');
    } catch (err) {
      if (err instanceof TranscriptAccessError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new TranscriptAccessError('not-found', `transcript not found: ${abs}`);
      }
      throw new TranscriptAccessError('io-error', (err as Error).message);
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private resolveSafe(input: string): string {
    const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.rootResolved, input);
    const rel = path.relative(this.rootResolved, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new TranscriptAccessError('outside-root', `path escapes transcript root: ${abs}`);
    }
    return abs;
  }
}
