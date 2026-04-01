/**
 * Cyclomatic Complexity — McCabe complexity metric via TypeScript AST.
 *
 * Counts decision points: if, else-if, &&, ||, ?, for, while, do, switch-case, catch.
 * Returns McCabe number (starts at 1 for the function body).
 *
 * Used by QualityScore to compute simplificationGain = 1 - (after/before).
 * Source of truth: spec/tdd.md §10 D10
 */
import ts from "typescript";

/**
 * Compute McCabe cyclomatic complexity of TypeScript/JavaScript source.
 * Returns 1 for empty or unparseable source.
 */
export function computeCyclomaticComplexity(source: string): number {
  if (!source.trim()) return 1;

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile("input.ts", source, ts.ScriptTarget.Latest, true);
  } catch {
    return 1;
  }

  let complexity = 1; // baseline

  function visit(node: ts.Node): void {
    switch (node.kind) {
      // Branching
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression: // ternary ?:
      case ts.SyntaxKind.CaseClause:            // switch case
      case ts.SyntaxKind.CatchClause:
      // Loops
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
        complexity++;
        break;
      // Logical operators (short-circuit = implicit branch)
      case ts.SyntaxKind.BinaryExpression: {
        const op = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken // ??
        ) {
          complexity++;
        }
        break;
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return complexity;
}
