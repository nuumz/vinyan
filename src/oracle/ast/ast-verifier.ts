import ts from "typescript";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { resolve, isAbsolute } from "path";
import type { HypothesisTuple, OracleVerdict, Evidence } from "../../core/types.ts";
import { buildVerdict } from "../../core/index.ts";

/**
 * AST Verifier — uses TypeScript Compiler API for deterministic AST analysis.
 * Supports patterns: symbol-exists, function-signature, import-exists.
 */

function computeHash(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function parseFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

function getLineNumber(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function getSnippet(sf: ts.SourceFile, node: ts.Node): string {
  const text = node.getText(sf);
  // Truncate long snippets
  return text.length > 120 ? text.slice(0, 117) + "..." : text;
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
          reason = `Param name mismatch: expected [${expectedParams.join(", ")}], found [${actualParams.join(", ")}]`;
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

/** Main verification entry point. */
export function verify(hypothesis: HypothesisTuple): OracleVerdict {
  const startTime = performance.now();
  // Resolve target against workspace if relative
  const filePath = isAbsolute(hypothesis.target)
    ? hypothesis.target
    : resolve(hypothesis.workspace, hypothesis.target);
  const context = hypothesis.context ?? {};

  try {
    const sf = parseFile(filePath);
    const hash = computeHash(filePath);
    const fileHashes: Record<string, string> = { [filePath]: hash };

    switch (hypothesis.pattern) {
      case "symbol-exists": {
        const symbolName = context.symbolName as string;
        if (!symbolName) {
          return buildVerdict({
            verified: false,
            evidence: [],
            fileHashes,
            reason: "context.symbolName is required for pattern 'symbol-exists'",
            errorCode: "PARSE_ERROR",
            duration_ms: Math.round(performance.now() - startTime),
          });
        }
        const result = verifySymbolExists(sf, filePath, symbolName);
        return buildVerdict({
          verified: result.found,
          evidence: result.evidence,
          fileHashes,
          reason: result.found ? undefined : `Symbol '${symbolName}' not found in ${filePath}`,
          errorCode: result.found ? undefined : "SYMBOL_NOT_FOUND",
          duration_ms: Math.round(performance.now() - startTime),
        });
      }

      case "function-signature": {
        const functionName = context.functionName as string;
        if (!functionName) {
          return buildVerdict({
            verified: false,
            evidence: [],
            fileHashes,
            reason: "context.functionName is required for pattern 'function-signature'",
            errorCode: "PARSE_ERROR",
            duration_ms: Math.round(performance.now() - startTime),
          });
        }
        const result = verifyFunctionSignature(sf, filePath, functionName, context);
        return buildVerdict({
          verified: result.found && result.matches,
          evidence: result.evidence,
          fileHashes,
          reason: result.reason,
          errorCode: !result.found ? "SYMBOL_NOT_FOUND" : undefined,
          duration_ms: Math.round(performance.now() - startTime),
        });
      }

      case "import-exists": {
        const moduleSpecifier = context.moduleSpecifier as string;
        if (!moduleSpecifier) {
          return buildVerdict({
            verified: false,
            evidence: [],
            fileHashes,
            reason: "context.moduleSpecifier is required for pattern 'import-exists'",
            errorCode: "PARSE_ERROR",
            duration_ms: Math.round(performance.now() - startTime),
          });
        }
        const result = verifyImportExists(sf, filePath, moduleSpecifier);
        return buildVerdict({
          verified: result.found,
          evidence: result.evidence,
          fileHashes,
          reason: result.found ? undefined : `Import '${moduleSpecifier}' not found in ${filePath}`,
          errorCode: result.found ? undefined : "SYMBOL_NOT_FOUND",
          duration_ms: Math.round(performance.now() - startTime),
        });
      }

      default:
        return buildVerdict({
          verified: false,
          evidence: [],
          fileHashes,
          reason: `Unknown pattern: '${hypothesis.pattern}'`,
          duration_ms: Math.round(performance.now() - startTime),
        });
    }
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `AST verification failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "ORACLE_CRASH",
      duration_ms: Math.round(performance.now() - startTime),
    });
  }
}
