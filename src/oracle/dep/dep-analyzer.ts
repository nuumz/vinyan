import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import * as ts from 'typescript';
import { buildVerdict } from '../../core/index.ts';
import type { Evidence, HypothesisTuple, OracleVerdict } from '../../core/types.ts';

/**
 * Dependency Analyzer — scans workspace TS files, builds import graph,
 * computes blast radius (reverse dependents) for a target file.
 */

/** Recursively collect all .ts files in a directory (excluding node_modules). */
function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Extract import specifiers from a TS source file. */
function extractImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];

  ts.forEachChild(sourceFile, (node) => {
    // import ... from "specifier"
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    // export ... from "specifier"
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
  });

  return imports;
}

/** Load tsconfig.json paths mapping from workspace. Returns alias → directory mappings. */
function loadPathAliases(workspace: string): Map<string, string> {
  const aliases = new Map<string, string>();
  try {
    const tsconfigPath = join(workspace, 'tsconfig.json');
    const raw = readFileSync(tsconfigPath, 'utf-8');
    const tsconfig = JSON.parse(raw);
    const paths = tsconfig?.compilerOptions?.paths as Record<string, string[]> | undefined;
    const baseUrl = tsconfig?.compilerOptions?.baseUrl as string | undefined;
    const base = baseUrl ? resolve(workspace, baseUrl) : workspace;

    if (paths) {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (targets.length === 0) continue;
        // Handle "alias/*" → ["src/*"] pattern
        const aliasPrefix = pattern.replace(/\/?\*$/, '');
        const targetDir = targets[0]!.replace(/\/?\*$/, '');
        aliases.set(aliasPrefix, resolve(base, targetDir));
      }
    }
  } catch {
    // No tsconfig or no paths — fine, only resolve relative imports
  }
  return aliases;
}

/** Resolve an import specifier to an absolute file path. */
function resolveImport(
  specifier: string,
  fromFile: string,
  workspace: string,
  pathAliases: Map<string, string>,
): string | null {
  let base: string;

  if (specifier.startsWith('.')) {
    // Relative import
    const dir = dirname(fromFile);
    base = resolve(dir, specifier);
  } else {
    // Try path aliases
    let matched = false;
    for (const [prefix, targetDir] of pathAliases) {
      if (specifier === prefix || specifier.startsWith(prefix + '/')) {
        const rest = specifier === prefix ? '' : specifier.slice(prefix.length + 1);
        base = rest ? join(targetDir, rest) : targetDir;
        matched = true;
        break;
      }
    }
    if (!matched) return null; // bare module (npm package) — skip
    base = base!;
  }

  // Try exact match, then common TS extensions
  const candidates = [base, `${base}.ts`, `${base}/index.ts`];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/** Build a forward dependency map: file → set of files it imports. */
export function buildDependencyGraph(workspace: string): Map<string, Set<string>> {
  const files = collectTsFiles(workspace);
  const pathAliases = loadPathAliases(workspace);
  const graph = new Map<string, Set<string>>();

  for (const file of files) {
    const deps = new Set<string>();
    const specifiers = extractImports(file);

    for (const spec of specifiers) {
      const resolved = resolveImport(spec, file, workspace, pathAliases);
      if (resolved) {
        deps.add(resolved);
      }
    }

    graph.set(file, deps);
  }

  return graph;
}

/** Compute reverse dependents (blast radius) for a target file. */
export function computeBlastRadius(targetAbsolute: string, graph: Map<string, Set<string>>): string[] {
  // Build reverse graph: file → set of files that depend on it
  const reverseGraph = new Map<string, Set<string>>();
  for (const [file, deps] of graph) {
    for (const dep of deps) {
      if (!reverseGraph.has(dep)) reverseGraph.set(dep, new Set());
      reverseGraph.get(dep)!.add(file);
    }
  }

  // BFS from target to find all transitive dependents
  const visited = new Set<string>();
  const queue = [targetAbsolute];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const dependents = reverseGraph.get(current);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }

  return Array.from(visited);
}

export async function verify(hypothesis: HypothesisTuple): Promise<OracleVerdict> {
  const startTime = performance.now();
  const workspace = hypothesis.workspace;
  const target = hypothesis.target;

  try {
    // Resolve target to absolute path
    const targetAbsolute = resolve(workspace, target);

    // Verify target exists
    try {
      statSync(targetAbsolute);
    } catch {
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `Target file not found: ${target}`,
        errorCode: 'SYMBOL_NOT_FOUND',
        durationMs: performance.now() - startTime,
      });
    }

    const graph = buildDependencyGraph(workspace);
    const dependents = computeBlastRadius(targetAbsolute, graph);

    // Compute file hash
    const content = readFileSync(targetAbsolute);
    const fileHash = createHash('sha256').update(content).digest('hex');

    // A2: Check for unresolvable imports — emit "uncertain" if evidence is inconclusive
    const targetImports = extractImports(targetAbsolute);
    const pathAliases = loadPathAliases(workspace);
    const unresolved = targetImports.filter((spec) =>
      !spec.startsWith('.') ? false : resolveImport(spec, targetAbsolute, workspace, pathAliases) === null,
    );

    const evidence: Evidence[] = dependents.map((dep) => ({
      file: relative(workspace, dep),
      line: 1,
      snippet: `depends on ${target}`,
    }));

    const blastRadius = dependents.length;

    // A2: "uncertain" when some relative imports can't be resolved (missing file, dynamic path)
    if (unresolved.length > 0) {
      return buildVerdict({
        verified: true,
        type: 'uncertain',
        confidence: 0.5,
        evidence,
        fileHashes: { [target]: fileHash },
        reason: `Blast radius: ${blastRadius} file(s), but ${unresolved.length} import(s) unresolvable: ${unresolved.join(', ')}`,
        durationMs: performance.now() - startTime,
      });
    }

    return buildVerdict({
      verified: true,
      evidence,
      fileHashes: { [target]: fileHash },
      reason: `Blast radius: ${blastRadius} file(s) depend on ${target}`,
      durationMs: performance.now() - startTime,
    });
  } catch (error) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `dep-oracle error: ${error instanceof Error ? error.message : String(error)}`,
      errorCode: 'ORACLE_CRASH',
      durationMs: performance.now() - startTime,
    });
  }
}
