/**
 * Search tools — search_grep, search_semantic.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeEvidence, makeResult, TOOL_TIMEOUT_MS } from './built-in-tools.ts';

export const searchGrep: Tool = {
  name: 'search_grep',
  description: 'Search file contents with grep',
  minIsolationLevel: 0,
  category: 'search',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'search_grep',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (regex)' },
          path: { type: 'string', description: 'Path to search in' },
        },
        required: ['pattern'],
      },
      category: 'search',
      sideEffect: false,
      minRoutingLevel: 1,
    };
  },
  async execute(params, context) {
    const pattern = params.pattern as string;
    const path = (params.path ?? '.') as string;
    // Path containment — reject traversal outside workspace
    const absPath = resolve(context.workspace, path);
    if (!absPath.startsWith(`${context.workspace}/`) && absPath !== context.workspace) {
      return makeResult((params.callId as string) ?? '', 'search_grep', {
        status: 'error',
        error: `Path '${path}' escapes workspace`,
      });
    }
    try {
      const proc = Bun.spawn(['grep', '-rn', pattern, path], {
        cwd: context.workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timeoutPromise = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), TOOL_TIMEOUT_MS));
      const processPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout;
      })();
      const result = await Promise.race([processPromise, timeoutPromise]);
      if (result === 'timeout') {
        proc.kill();
        return makeResult((params.callId as string) ?? '', 'search_grep', {
          status: 'error',
          error: 'search_grep timed out after 30s',
        });
      }
      return makeResult((params.callId as string) ?? '', 'search_grep', { output: result });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'search_grep', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

export const searchSemantic: Tool = {
  name: 'search_semantic',
  description: 'AST-based symbol search — find symbols by name in a file using TypeScript compiler API',
  minIsolationLevel: 0,
  category: 'search',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'search_semantic',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File to search in' },
          symbol: { type: 'string', description: 'Symbol name to search for' },
        },
        required: ['file_path', 'symbol'],
      },
      category: 'search',
      sideEffect: false,
      minRoutingLevel: 1,
    };
  },
  async execute(params, context) {
    const filePath = (params.file_path ?? params.path) as string;
    const symbolName = params.symbol as string;
    if (!filePath || !symbolName) {
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        status: 'error',
        error: 'Both file_path and symbol are required',
      });
    }
    const absPath = resolve(context.workspace, filePath);
    try {
      const ts = (await import('typescript')).default;
      const content = readFileSync(absPath, 'utf-8');
      const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true);

      const matches: Array<{ line: number; snippet: string }> = [];

      function visit(node: import('typescript').Node) {
        let name: string | undefined;

        if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isClassDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isInterfaceDeclaration(node) && node.name) name = node.name.text;
        else if (ts.isTypeAliasDeclaration(node)) name = node.name.text;
        else if (ts.isEnumDeclaration(node)) name = node.name.text;
        else if (ts.isMethodDeclaration(node) && node.name) name = node.name.getText(sf);
        else if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach((decl) => {
            if (ts.isIdentifier(decl.name) && decl.name.text.includes(symbolName)) {
              const line = sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1;
              const text = decl.getText(sf);
              matches.push({ line, snippet: text.length > 120 ? `${text.slice(0, 117)}...` : text });
            }
          });
        }

        if (name?.includes(symbolName)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const text = node.getText(sf);
          matches.push({ line, snippet: text.length > 120 ? `${text.slice(0, 117)}...` : text });
        }

        ts.forEachChild(node, visit);
      }

      ts.forEachChild(sf, visit);

      const output =
        matches.length > 0
          ? matches.map((m) => `${filePath}:${m.line}: ${m.snippet}`).join('\n')
          : `No symbol matching "${symbolName}" found in ${filePath}`;
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        output,
        evidence: makeEvidence(filePath, content),
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'search_semantic', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
