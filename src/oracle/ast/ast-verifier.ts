import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import ts from 'typescript';
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type { Evidence, HypothesisTuple, OracleAbstention, OracleResponse } from '../../core/types.ts';

const BASE_RATE = 0.5;
const TTL_MS = 300_000;

/**
 * AST Verifier — uses TypeScript Compiler API for deterministic AST analysis.
 * Supports patterns: symbol-exists, function-signature, import-exists.
 */

function computeHash(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function parseFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, 'utf-8');
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

function getLineNumber(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function getSnippet(sf: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sf);
  // Truncate long snippets
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

/** Pattern: symbol-exists — verify a named symbol (function, class, variable, type) exists in the file. */
function verifySymbolExists(
  sf: ts.SourceFile,
  filePath: string,
  symbolName: string,
): { found: boolean; evidence: Evidence[] } {
  const evidence: Evidence[] = [];

  function visit(node: ts.Node) {
    let name: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
    else if (ts.isClassDeclaration(node) && node.name) name = node.name.text;
    else if (ts.isInterfaceDeclaration(node) && node.name) name = node.name.text;
    else if (ts.isTypeAliasDeclaration(node)) name = node.name.text;
    else if (ts.isEnumDeclaration(node)) name = node.name.text;
    else if (ts.isVariableStatement(node)) {
      node.declarationList.declarations.forEach((decl) => {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbolName) {
          evidence.push({
            file: filePath,
            line: getLineNumber(sf, decl.getStart(sf)),
            snippet: getSnippet(sf, decl),
          });
        }
      });
      return; // handled inline
    }
    // Also check for method declarations inside classes
    else if (ts.isMethodDeclaration(node) && node.name) {
      name = node.name.getText(sf);
    }

    if (name === symbolName) {
      evidence.push({
        file: filePath,
        line: getLineNumber(sf, node.getStart(sf)),
        snippet: getSnippet(sf, node),
      });
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);
  return { found: evidence.length > 0, evidence };
}

/** Pattern: function-signature — verify a function has specific param count and optionally param names. */
function verifyFunctionSignature(
  sf: ts.SourceFile,
  filePath: string,
  functionName: string,
  context: Record<string, unknown>,
): { found: boolean; matches: boolean; evidence: Evidence[]; reason?: string } {
  const expectedParamCount = context.paramCount as number | undefined;
  const expectedParams = context.params as string[] | undefined;
  const evidence: Evidence[] = [];
  let functionFound = false;
  let signatureMatches = true;
  let reason: string | undefined;

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      functionFound = true;
      const params = node.parameters;

      evidence.push({
        file: filePath,
        line: getLineNumber(sf, node.getStart(sf)),
        snippet: getSnippet(sf, node),
      });

      if (expectedParamCount !== undefined && params.length !== expectedParamCount) {
        signatureMatches = false;
        reason = `Expected ${expectedParamCount} params, found ${params.length}`;
      }

      if (expectedParams) {
        const actualParams = params.map((p) => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf)));
        const mismatches = expectedParams.filter((ep, i) => actualParams[i] !== ep);
        if (mismatches.length > 0) {
          signatureMatches = false;
          reason = `Param name mismatch: expected [${expectedParams.join(', ')}], found [${actualParams.join(', ')}]`;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  if (!functionFound) {
    return { found: false, matches: false, evidence: [], reason: `Function '${functionName}' not found` };
  }
  return { found: true, matches: signatureMatches, evidence, reason };
}

/** Pattern: import-exists — verify an import statement exists for a given module specifier. */
function verifyImportExists(
  sf: ts.SourceFile,
  filePath: string,
  moduleSpecifier: string,
): { found: boolean; evidence: Evidence[] } {
  const evidence: Evidence[] = [];

  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (ts.isStringLiteral(spec) && spec.text === moduleSpecifier) {
        evidence.push({
          file: filePath,
          line: getLineNumber(sf, node.getStart(sf)),
          snippet: getSnippet(sf, node),
        });
      }
    }
  });

  return { found: evidence.length > 0, evidence };
}

/** Missing required context is a caller misconfiguration — the oracle cannot
 *  form a verdict either way, so it abstains (A2) instead of emitting a
 *  false "failure" that would distort fusion. */
function missingContextAbstention(field: string, pattern: string, startTime: number): OracleAbstention {
  return {
    type: 'abstained',
    reason: 'insufficient_data',
    oracleName: 'ast',
    durationMs: Math.round(performance.now() - startTime),
    prerequisites: [`Provide context.${field} for pattern '${pattern}'`],
  };
}

/** Main verification entry point. */
export function verify(hypothesis: HypothesisTuple): OracleResponse {
  const startTime = performance.now();
  // Resolve target against workspace if relative
  const filePath = isAbsolute(hypothesis.target) ? hypothesis.target : resolve(hypothesis.workspace, hypothesis.target);
  const context = hypothesis.context ?? {};

  try {
    const sf = parseFile(filePath);
    const hash = computeHash(filePath);
    const fileHashes: Record<string, string> = { [filePath]: hash };

    // A2: Check for parse diagnostics — degrade to uncertain if file has syntax errors
    if ((sf as any).parseDiagnostics?.length > 0) {
      return buildVerdict({
        verified: false,
        type: 'uncertain',
        confidence: 0.3,
        evidence: [],
        fileHashes,
        reason: `File has ${(sf as any).parseDiagnostics.length} parse error(s) — AST analysis unreliable`,
        durationMs: Math.round(performance.now() - startTime),
        opinion: fromScalar(0.3, BASE_RATE),
        temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'none' as const },
      });
    }

    switch (hypothesis.pattern) {
      case 'symbol-exists': {
        const symbolName = context.symbolName as string;
        if (!symbolName) {
          return missingContextAbstention('symbolName', 'symbol-exists', startTime);
        }
        const result = verifySymbolExists(sf, filePath, symbolName);
        return buildVerdict({
          verified: result.found,
          type: 'known',
          confidence: 1.0,
          evidence: result.evidence,
          fileHashes,
          reason: result.found ? undefined : `Symbol '${symbolName}' not found in ${filePath}`,
          errorCode: result.found ? undefined : 'SYMBOL_NOT_FOUND',
          durationMs: Math.round(performance.now() - startTime),
          // Opinion oriented toward "the hypothesis holds" — failure carries disbelief.
          opinion: fromScalar(result.found ? 1.0 : 0.0, BASE_RATE),
          temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'none' as const },
        });
      }

      case 'function-signature': {
        const functionName = context.functionName as string;
        if (!functionName) {
          return missingContextAbstention('functionName', 'function-signature', startTime);
        }
        const result = verifyFunctionSignature(sf, filePath, functionName, context);
        return buildVerdict({
          verified: result.found && result.matches,
          type: 'known',
          confidence: 1.0,
          evidence: result.evidence,
          fileHashes,
          reason: result.reason,
          errorCode: !result.found ? 'SYMBOL_NOT_FOUND' : undefined,
          durationMs: Math.round(performance.now() - startTime),
          opinion: fromScalar(result.found && result.matches ? 1.0 : 0.0, BASE_RATE),
          temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'none' as const },
        });
      }

      case 'import-exists': {
        const moduleSpecifier = context.moduleSpecifier as string;
        if (!moduleSpecifier) {
          return missingContextAbstention('moduleSpecifier', 'import-exists', startTime);
        }
        const result = verifyImportExists(sf, filePath, moduleSpecifier);
        return buildVerdict({
          verified: result.found,
          type: 'known',
          confidence: 1.0,
          evidence: result.evidence,
          fileHashes,
          reason: result.found ? undefined : `Import '${moduleSpecifier}' not found in ${filePath}`,
          errorCode: result.found ? undefined : 'SYMBOL_NOT_FOUND',
          durationMs: Math.round(performance.now() - startTime),
          opinion: fromScalar(result.found ? 1.0 : 0.0, BASE_RATE),
          temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'none' as const },
        });
      }

      default:
        // Pattern outside this oracle's domain — abstain rather than fabricate a verdict.
        return {
          type: 'abstained',
          reason: 'out_of_domain',
          oracleName: 'ast',
          durationMs: Math.round(performance.now() - startTime),
          prerequisites: [`Unknown pattern: '${hypothesis.pattern}'`],
        } satisfies OracleAbstention;
    }
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `AST verification failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: 'ORACLE_CRASH',
      durationMs: Math.round(performance.now() - startTime),
      opinion: fromScalar(0, BASE_RATE),
      temporalContext: { validFrom: Date.now(), validUntil: Date.now() + TTL_MS, decayModel: 'none' as const },
    });
  }
}
