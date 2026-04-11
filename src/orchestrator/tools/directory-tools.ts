/**
 * Directory tools — directory_list.
 */

import { existsSync, readdirSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeResult } from './built-in-tools.ts';

export const directoryList: Tool = {
  name: 'directory_list',
  description: 'List directory contents',
  minIsolationLevel: 0,
  category: 'file_read',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'directory_list',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path to list' } },
        required: [],
      },
      category: 'file_read',
      sideEffect: false,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, context) {
    const dirPath = ((params.path ?? params.directory) as string) ?? '.';
    const callId = (params.callId as string) ?? '';

    // Agentic mode: merge overlay + workspace entries, hide tombstones
    if (context.overlayDir) {
      const entries = new Set<string>();
      const tombstones = new Set<string>();

      const overlayDirPath = resolve(context.overlayDir, dirPath);
      if (existsSync(overlayDirPath)) {
        for (const entry of readdirSync(overlayDirPath)) {
          if (entry.endsWith('.__wh')) tombstones.add(entry.replace('.__wh', ''));
          else entries.add(entry);
        }
      }

      const workspaceDirPath = resolve(context.workspace, dirPath);
      if (existsSync(workspaceDirPath)) {
        for (const e of readdirSync(workspaceDirPath)) {
          if (!tombstones.has(e)) entries.add(e);
        }
      }

      return makeResult(callId, 'directory_list', { output: [...entries].sort().join('\n') });
    }

    const absPath = resolve(context.workspace, dirPath);
    try {
      const entries = readdirSync(absPath, { withFileTypes: true });
      const output = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      return makeResult(callId, 'directory_list', { output });
    } catch (e) {
      return makeResult(callId, 'directory_list', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
