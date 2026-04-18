/**
 * SoulStore — filesystem CRUD for agent SOUL.md documents.
 *
 * SOUL.md files live at `.vinyan/souls/{agentId}.soul.md` and are:
 *   - Human-readable and human-editable
 *   - Git-trackable (part of project state)
 *   - Source of truth for agent identity (DB column is a denormalized cache)
 *
 * Source of truth: Living Agent Soul plan
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { type SoulDocument, parseSoulMd, renderSoulMd } from './soul-schema.ts';

export class SoulStore {
  private soulsDir: string;

  constructor(workspace: string) {
    this.soulsDir = join(workspace, '.vinyan', 'souls');
  }

  private ensureDir(): void {
    if (!existsSync(this.soulsDir)) {
      mkdirSync(this.soulsDir, { recursive: true });
    }
  }

  private filePath(agentId: string): string {
    // Sanitize agentId for safe filesystem path (replace / with __)
    const safeId = agentId.replace(/\//g, '__');
    return join(this.soulsDir, `${safeId}.soul.md`);
  }

  /** Load and parse a soul document. Returns null if no soul exists. */
  loadSoul(agentId: string): SoulDocument | null {
    const path = this.filePath(agentId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf-8');
      return parseSoulMd(raw);
    } catch {
      return null;
    }
  }

  /** Load raw markdown for direct prompt injection. Returns null if no soul exists. */
  loadSoulRaw(agentId: string): string | null {
    const path = this.filePath(agentId);
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Save a soul document to filesystem. Creates directory if needed. */
  saveSoul(soul: SoulDocument): void {
    this.ensureDir();
    const path = this.filePath(soul.agentId);
    writeFileSync(path, renderSoulMd(soul), 'utf-8');
  }

  /** List all agent IDs that have soul files. */
  listSouls(): string[] {
    if (!existsSync(this.soulsDir)) return [];
    try {
      return readdirSync(this.soulsDir)
        .filter((f) => f.endsWith('.soul.md'))
        .map((f) => basename(f, '.soul.md').replace(/__/g, '/'));
    } catch {
      return [];
    }
  }

  /** Check if an agent has a soul file. */
  hasSoul(agentId: string): boolean {
    return existsSync(this.filePath(agentId));
  }
}
