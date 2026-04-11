/**
 * File tools — file_read, file_write, file_edit.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeEvidence, makeResult } from './built-in-tools.ts';

export const fileRead: Tool = {
  name: 'file_read',
  description: 'Read file contents',
  minIsolationLevel: 0,
  category: 'file_read',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_read',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path to the file to read' } },
        required: ['file_path'],
      },
      category: 'file_read',
      sideEffect: false,
      minRoutingLevel: 0,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const callId = (params.callId as string) ?? '';

    // Agentic mode: CoW read (overlay-first, workspace fallback)
    if (context.overlayDir) {
      const overlayPath = resolve(context.overlayDir, filePath);
      const tombstone = `${overlayPath}.__wh`;
      if (existsSync(tombstone)) {
        return makeResult(callId, 'file_read', { status: 'error', error: `File ${filePath} has been deleted` });
      }
      if (existsSync(overlayPath)) {
        const content = readFileSync(overlayPath, 'utf-8');
        return makeResult(callId, 'file_read', { output: content, evidence: makeEvidence(filePath, content) });
      }
      // Fall through to workspace read
    }

    const absPath = resolve(context.workspace, filePath);
    try {
      const content = readFileSync(absPath, 'utf-8');
      return makeResult(callId, 'file_read', {
        output: content,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult(callId, 'file_read', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileWrite: Tool = {
  name: 'file_write',
  description: 'Write content to a file',
  minIsolationLevel: 1,
  category: 'file_write',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_write',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['file_path', 'content'],
      },
      category: 'file_write',
      sideEffect: true,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const content = params.content as string;
    const callId = (params.callId as string) ?? '';

    // Agentic mode: always write to overlay
    if (context.overlayDir) {
      const overlayPath = resolve(context.overlayDir, filePath);
      const tombstone = `${overlayPath}.__wh`;
      if (existsSync(tombstone)) rmSync(tombstone);
      mkdirSync(dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, content);
      return makeResult(callId, 'file_write', {
        output: `Wrote ${content.length} bytes to ${filePath} (overlay)`,
        evidence: makeEvidence(filePath, content),
      });
    }

    const absPath = resolve(context.workspace, filePath);
    try {
      writeFileSync(absPath, content);
      return makeResult(callId, 'file_write', {
        output: `Wrote ${content.length} bytes to ${filePath}`,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult(callId, 'file_write', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const fileEdit: Tool = {
  name: 'file_edit',
  description: 'Apply an edit to a file (read, modify, write)',
  minIsolationLevel: 1,
  category: 'file_write',
  sideEffect: true,
  descriptor(): ToolDescriptor {
    return {
      name: 'file_edit',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit' },
          old_string: { type: 'string', description: 'String to replace' },
          new_string: { type: 'string', description: 'Replacement string' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      category: 'file_write',
      sideEffect: true,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const oldStr = params.old_string as string;
    const newStr = params.new_string as string;
    const callId = (params.callId as string) ?? '';

    // Agentic mode: read overlay-first, write to overlay
    if (context.overlayDir) {
      const overlayPath = resolve(context.overlayDir, filePath);
      let original: string;
      if (existsSync(overlayPath)) {
        original = readFileSync(overlayPath, 'utf-8');
      } else {
        const absPath = resolve(context.workspace, filePath);
        if (!existsSync(absPath)) {
          return makeResult(callId, 'file_edit', { status: 'error', error: `File ${filePath} not found` });
        }
        original = readFileSync(absPath, 'utf-8');
      }
      if (!original.includes(oldStr)) {
        return makeResult(callId, 'file_edit', { status: 'error', error: `old_string not found in ${filePath}` });
      }
      const updated = original.replaceAll(oldStr, newStr);
      mkdirSync(dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, updated);
      return makeResult(callId, 'file_edit', {
        output: `Edited ${filePath} (overlay)`,
        evidence: makeEvidence(filePath, updated),
      });
    }

    const absPath = resolve(context.workspace, filePath);
    try {
      const original = readFileSync(absPath, 'utf-8');
      if (!original.includes(oldStr)) {
        return makeResult(callId, 'file_edit', {
          status: 'error',
          error: `old_string not found in ${filePath}`,
        });
      }
      const updated = original.replaceAll(oldStr, newStr);
      writeFileSync(absPath, updated);
      return makeResult(callId, 'file_edit', {
        output: `Edited ${filePath}`,
        evidence: makeEvidence(filePath, updated),
      });
    } catch (e) {
      return makeResult(callId, 'file_edit', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
