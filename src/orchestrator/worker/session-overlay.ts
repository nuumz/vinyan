/**
 * Session Overlay — Copy-on-Write filesystem layer for worker sessions.
 *
 * Writes go to a temporary overlay directory; reads check overlay first,
 * then fall through to the workspace. Deletions use whiteout tombstones.
 * OCC (Optimistic Concurrency Control) via SHA-256 base hashes at commit time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface ProposedMutation {
  file: string;
  content: string | null;
  diff: string;
  explanation: string;
}

export class SessionOverlay {
  readonly dir: string;
  private baseHashes: Map<string, string> = new Map();

  static create(workspace: string, taskId: string): SessionOverlay {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      throw new Error(`Invalid taskId: ${taskId}`);
    }
    const dir = join(workspace, '.vinyan', 'sessions', taskId, 'overlay');
    mkdirSync(dir, { recursive: true });
    return new SessionOverlay(workspace, dir);
  }

  private constructor(
    private workspace: string,
    dir: string,
  ) {
    this.dir = dir;
  }

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private validatePath(relPath: string): void {
    if (relPath.includes('..') || relPath.startsWith('/')) {
      throw new Error(`Invalid relative path: ${relPath}`);
    }
  }

  /** CoW read: overlay first, then workspace fallback */
  readFile(relPath: string): string | null {
    this.validatePath(relPath);
    const overlayPath = join(this.dir, relPath);
    const tombstone = overlayPath + '.__wh';

    if (existsSync(tombstone)) return null;

    if (existsSync(overlayPath)) {
      return readFileSync(overlayPath, 'utf-8');
    }

    const workspacePath = join(this.workspace, relPath);
    if (existsSync(workspacePath)) {
      const content = readFileSync(workspacePath, 'utf-8');
      if (!this.baseHashes.has(relPath)) {
        this.baseHashes.set(relPath, this.sha256(content));
      }
      return content;
    }

    return null;
  }

  /** List directory — merge overlay + workspace, hide tombstones */
  listDir(relPath: string): string[] {
    this.validatePath(relPath);
    const entries = new Set<string>();
    const tombstones = new Set<string>();

    const overlayDirPath = join(this.dir, relPath);
    if (existsSync(overlayDirPath)) {
      for (const entry of readdirSync(overlayDirPath)) {
        if (entry.endsWith('.__wh')) {
          tombstones.add(entry.replace('.__wh', ''));
        } else {
          entries.add(entry);
        }
      }
    }

    const workspaceDirPath = join(this.workspace, relPath);
    if (existsSync(workspaceDirPath)) {
      for (const entry of readdirSync(workspaceDirPath)) {
        if (!tombstones.has(entry)) {
          entries.add(entry);
        }
      }
    }

    return [...entries].sort();
  }

  /** Write to overlay (never to workspace directly) */
  writeFile(relPath: string, content: string): void {
    this.validatePath(relPath);
    const overlayPath = join(this.dir, relPath);

    if (!this.baseHashes.has(relPath)) {
      const workspacePath = join(this.workspace, relPath);
      if (existsSync(workspacePath)) {
        this.baseHashes.set(relPath, this.sha256(readFileSync(workspacePath, 'utf-8')));
      }
    }

    const tombstone = overlayPath + '.__wh';
    if (existsSync(tombstone)) rmSync(tombstone);

    mkdirSync(dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, content, 'utf-8');
  }

  /** Delete via tombstone */
  deleteFile(relPath: string): void {
    this.validatePath(relPath);
    const overlayPath = join(this.dir, relPath);
    const tombstone = overlayPath + '.__wh';

    if (!this.baseHashes.has(relPath)) {
      const workspacePath = join(this.workspace, relPath);
      if (existsSync(workspacePath)) {
        this.baseHashes.set(relPath, this.sha256(readFileSync(workspacePath, 'utf-8')));
      }
    }

    if (existsSync(overlayPath)) rmSync(overlayPath);

    mkdirSync(dirname(tombstone), { recursive: true });
    writeFileSync(tombstone, '', 'utf-8');
  }

  /** Compute mutations (overlay diff vs workspace) */
  computeDiff(): ProposedMutation[] {
    const mutations: ProposedMutation[] = [];
    this.walkOverlay(this.dir, '', mutations);
    return mutations;
  }

  private walkOverlay(dirPath: string, prefix: string, mutations: ProposedMutation[]): void {
    if (!existsSync(dirPath)) return;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        this.walkOverlay(fullPath, relPath, mutations);
        continue;
      }

      if (entry.name.endsWith('.__wh')) {
        const deletedFile = relPath.replace('.__wh', '');
        mutations.push({
          file: deletedFile,
          content: null,
          diff: `--- a/${deletedFile}\n+++ /dev/null\n@@ -1 +0,0 @@\n-[file deleted]`,
          explanation: 'File deleted by session overlay',
        });
        continue;
      }

      const overlayContent = readFileSync(fullPath, 'utf-8');
      const workspacePath = join(this.workspace, relPath);
      const isNew = !existsSync(workspacePath);
      const original = isNew ? '' : readFileSync(workspacePath, 'utf-8');

      const diff = this.createSimpleDiff(relPath, original, overlayContent);

      mutations.push({
        file: relPath,
        content: overlayContent,
        diff,
        explanation: isNew ? 'New file created' : 'File modified',
      });
    }
  }

  private createSimpleDiff(file: string, original: string, modified: string): string {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');
    let diff = `--- a/${file}\n+++ b/${file}\n`;
    diff += `@@ -1,${origLines.length} +1,${modLines.length} @@\n`;
    for (const line of origLines) diff += `-${line}\n`;
    for (const line of modLines) diff += `+${line}\n`;
    return diff;
  }

  /** OCC-safe commit — check SHA-256 before writing */
  commit(): { committed: string[]; conflicts: string[] } {
    const committed: string[] = [];
    const conflicts: string[] = [];
    const mutations = this.computeDiff();

    for (const mutation of mutations) {
      if (mutation.content === null) {
        const workspacePath = join(this.workspace, mutation.file);
        if (existsSync(workspacePath)) {
          const currentHash = this.sha256(readFileSync(workspacePath, 'utf-8'));
          const baseHash = this.baseHashes.get(mutation.file);
          if (baseHash && currentHash !== baseHash) {
            conflicts.push(mutation.file);
            continue;
          }
          rmSync(workspacePath);
          committed.push(mutation.file);
        }
        continue;
      }

      const workspacePath = join(this.workspace, mutation.file);
      const baseHash = this.baseHashes.get(mutation.file);
      if (baseHash && existsSync(workspacePath)) {
        const currentHash = this.sha256(readFileSync(workspacePath, 'utf-8'));
        if (currentHash !== baseHash) {
          conflicts.push(mutation.file);
          continue;
        }
      }

      mkdirSync(dirname(workspacePath), { recursive: true });
      writeFileSync(workspacePath, mutation.content, 'utf-8');
      committed.push(mutation.file);
    }

    return { committed, conflicts };
  }

  /** Clean up overlay directory — MUST be called in finally blocks */
  cleanup(): void {
    if (existsSync(this.dir)) {
      const sessionDir = dirname(this.dir);
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
}
