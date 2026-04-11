/**
 * Causal Edge Extractor — extracts semantic causal edges from TypeScript files
 * using regex-based pattern matching. Fast and lightweight, no AST parser.
 *
 * Edge types: extends-class, implements-interface, calls-method, uses-type,
 * test-covers, re-exports.
 */
import { dirname, join, relative, resolve } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import type { CausalEdge, CausalEdgeType } from '../../orchestrator/forward-predictor-types.ts';

export interface CausalEdgeExtractor {
  extractEdges(targetFiles: string[], workspace: string): Promise<CausalEdge[]>;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const EXTENDS_RE = /class\s+(\w+)\s+extends\s+(\w+)/g;
const IMPLEMENTS_RE = /class\s+(\w+)\s+implements\s+([\w,\s]+?)(?:\s*\{|\s+extends)/g;
const VALUE_IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const TYPE_IMPORT_RE = /import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
const REEXPORT_STAR_RE = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
const REEXPORT_NAMED_RE = /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

// ---------------------------------------------------------------------------
// Path alias loader (lightweight — reads tsconfig once)
// ---------------------------------------------------------------------------

function loadPathAliases(workspace: string): Map<string, string> {
  const aliases = new Map<string, string>();
  try {
    const raw = readFileSync(join(workspace, 'tsconfig.json'), 'utf-8');
    const tsconfig = JSON.parse(raw);
    const paths = tsconfig?.compilerOptions?.paths as Record<string, string[]> | undefined;
    const baseUrl = tsconfig?.compilerOptions?.baseUrl as string | undefined;
    const base = baseUrl ? resolve(workspace, baseUrl) : workspace;
    if (paths) {
      for (const [pattern, targets] of Object.entries(paths)) {
        if (targets.length === 0) continue;
        const aliasPrefix = pattern.replace(/\/?\*$/, '');
        const targetDir = targets[0]!.replace(/\/?\*$/, '');
        aliases.set(aliasPrefix, resolve(base, targetDir));
      }
    }
  } catch {
    // no tsconfig or malformed — fine
  }
  return aliases;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function resolveSpecifier(
  specifier: string,
  fromFile: string,
  workspace: string,
  aliases: Map<string, string>,
): string | null {
  let base: string | undefined;

  if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [prefix, targetDir] of aliases) {
      if (specifier === prefix || specifier.startsWith(prefix + '/')) {
        const rest = specifier === prefix ? '' : specifier.slice(prefix.length + 1);
        base = rest ? join(targetDir, rest) : targetDir;
        break;
      }
    }
    if (!base) return null; // bare module — skip
  }

  // Strip .ts extension from specifier if already present, then try candidates
  const cleaned = base.replace(/\.ts$/, '');
  const candidates = [`${cleaned}.ts`, `${cleaned}/index.ts`, base];
  for (const c of candidates) {
    try {
      statSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test-covers heuristic
// ---------------------------------------------------------------------------

function inferTestCoversEdge(filePath: string, workspace: string): CausalEdge | null {
  const testMatch = filePath.match(/^(.+)\.(test|spec)\.ts$/);
  if (!testMatch) return null;

  const sourcePath = `${testMatch[1]}.ts`;
  try {
    statSync(sourcePath);
  } catch {
    return null;
  }

  return {
    fromFile: relative(workspace, filePath),
    toFile: relative(workspace, sourcePath),
    edgeType: 'test-covers',
    confidence: 0.8,
    source: 'inferred',
  };
}

// ---------------------------------------------------------------------------
// Edge extraction from file content
// ---------------------------------------------------------------------------

interface ImportInfo {
  symbols: string[];
  specifier: string;
  isType: boolean;
}

function parseImports(content: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  // Type imports
  for (const m of content.matchAll(TYPE_IMPORT_RE)) {
    const symbols = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    results.push({ symbols, specifier: m[2]!, isType: true });
  }

  // Value imports
  for (const m of content.matchAll(VALUE_IMPORT_RE)) {
    const symbols = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    results.push({ symbols, specifier: m[2]!, isType: false });
  }

  return results;
}

function extractEdgesFromContent(
  filePath: string,
  content: string,
  workspace: string,
  aliases: Map<string, string>,
): CausalEdge[] {
  const edges: CausalEdge[] = [];
  const rel = (abs: string) => relative(workspace, abs);
  const fromRel = rel(filePath);

  // Build import → resolved file map and symbol → (file, isType) lookup
  const imports = parseImports(content);
  const symbolToFile = new Map<string, { resolved: string; isType: boolean }>();

  for (const imp of imports) {
    const resolved = resolveSpecifier(imp.specifier, filePath, workspace, aliases);
    if (!resolved) continue;

    for (const sym of imp.symbols) {
      // Handle `X as Y` aliases — use the local name for usage detection
      const localName = sym.includes(' as ') ? sym.split(' as ')[1]!.trim() : sym.trim();
      symbolToFile.set(localName, { resolved, isType: imp.isType });
    }
  }

  // --- uses-type edges (from type imports) ---
  for (const imp of imports) {
    if (!imp.isType) continue;
    const resolved = resolveSpecifier(imp.specifier, filePath, workspace, aliases);
    if (!resolved) continue;
    for (const sym of imp.symbols) {
      const localName = sym.includes(' as ') ? sym.split(' as ')[1]!.trim() : sym.trim();
      edges.push({
        fromFile: fromRel,
        fromSymbol: undefined,
        toFile: rel(resolved),
        toSymbol: localName,
        edgeType: 'uses-type',
        confidence: 1.0,
        source: 'static',
      });
    }
  }

  // --- extends-class edges ---
  for (const m of content.matchAll(EXTENDS_RE)) {
    const childClass = m[1]!;
    const parentClass = m[2]!;
    const info = symbolToFile.get(parentClass);
    if (info) {
      edges.push({
        fromFile: fromRel,
        fromSymbol: childClass,
        toFile: rel(info.resolved),
        toSymbol: parentClass,
        edgeType: 'extends-class',
        confidence: 1.0,
        source: 'static',
      });
    }
  }

  // --- implements-interface edges ---
  for (const m of content.matchAll(IMPLEMENTS_RE)) {
    const className = m[1]!;
    const interfaces = m[2]!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const iface of interfaces) {
      const info = symbolToFile.get(iface);
      if (info) {
        edges.push({
          fromFile: fromRel,
          fromSymbol: className,
          toFile: rel(info.resolved),
          toSymbol: iface,
          edgeType: 'implements-interface',
          confidence: 1.0,
          source: 'static',
        });
      }
    }
  }

  // --- calls-method edges (value imports used as function calls) ---
  for (const imp of imports) {
    if (imp.isType) continue;
    const resolved = resolveSpecifier(imp.specifier, filePath, workspace, aliases);
    if (!resolved) continue;
    for (const sym of imp.symbols) {
      const localName = sym.includes(' as ') ? sym.split(' as ')[1]!.trim() : sym.trim();
      // Check if symbol is called: `symbolName(` anywhere in the file
      const callPattern = new RegExp(`\\b${escapeRegex(localName)}\\s*\\(`, 'm');
      if (callPattern.test(content)) {
        edges.push({
          fromFile: fromRel,
          fromSymbol: undefined,
          toFile: rel(resolved),
          toSymbol: localName,
          edgeType: 'calls-method',
          confidence: 1.0,
          source: 'static',
        });
      }
    }
  }

  // --- re-export edges ---
  for (const m of content.matchAll(REEXPORT_STAR_RE)) {
    const resolved = resolveSpecifier(m[1]!, filePath, workspace, aliases);
    if (!resolved) continue;
    edges.push({
      fromFile: fromRel,
      toFile: rel(resolved),
      edgeType: 're-exports',
      confidence: 1.0,
      source: 'static',
    });
  }

  for (const m of content.matchAll(REEXPORT_NAMED_RE)) {
    const resolved = resolveSpecifier(m[2]!, filePath, workspace, aliases);
    if (!resolved) continue;
    const symbols = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    for (const sym of symbols) {
      const localName = sym.includes(' as ') ? sym.split(' as ')[0]!.trim() : sym.trim();
      edges.push({
        fromFile: fromRel,
        fromSymbol: localName,
        toFile: rel(resolved),
        toSymbol: localName,
        edgeType: 're-exports',
        confidence: 1.0,
        source: 'static',
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CausalEdgeExtractorImpl implements CausalEdgeExtractor {
  constructor(private config: { workspace: string }) {}

  async extractEdges(targetFiles: string[], workspace: string): Promise<CausalEdge[]> {
    const aliases = loadPathAliases(workspace);
    const edges: CausalEdge[] = [];

    for (const filePath of targetFiles) {
      try {
        // Security: reject paths outside workspace
        const abs = resolve(filePath);
        if (!abs.startsWith(resolve(workspace))) continue;

        const content = readFileSync(abs, 'utf-8');

        // Extract semantic edges from content
        edges.push(...extractEdgesFromContent(abs, content, workspace, aliases));

        // Infer test-covers edge
        const testEdge = inferTestCoversEdge(abs, workspace);
        if (testEdge) edges.push(testEdge);
      } catch {
        // Graceful degradation — skip unreadable files
        continue;
      }
    }

    return edges;
  }
}
