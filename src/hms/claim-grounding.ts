/**
 * Claim Grounding — extract verifiable claims from LLM output, verify against ground truth.
 *
 * A3 compliant: deterministic regex extraction + filesystem/AST verification.
 * A4 compliant: file existence checks are ground truth.
 * A5 compliant: tier = 'deterministic' (filesystem checks).
 *
 * Source of truth: HMS plan §H1 (HMS-2)
 */
import { existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';

export interface ExtractedClaim {
  type: 'file_reference' | 'symbol_reference' | 'import_claim' | 'fake_tool_call';
  value: string;
  source_line: number;
}

export interface GroundingResult {
  claims: ExtractedClaim[];
  verified: number;
  refuted: number;
  unverifiable: number;
  grounding_ratio: number;
  refuted_claims: Array<ExtractedClaim & { reason: string }>;
}

// ── Claim Extraction Patterns ───────────────────────────────────────

/** Match file paths: word chars, slashes, dots, hyphens — ending with extension. */
const FILE_PATH_RE = /(?:^|\s|['"`(])([a-zA-Z_][\w/.-]*\.\w{1,10})(?:['"`)\s:,]|$)/gm;

/** Match import/require paths. */
const IMPORT_RE = /(?:import|require)\s*(?:\(?\s*['"]|.*from\s+['"])([^'"]+)['"]/gm;

/** Fake tool call patterns — hallucinated structured output. */
const FAKE_TOOL_PATTERNS = [
  '<function_calls>',
  '<invoke name=',
  '<tool_use>',
  '<tool_call>',
  '```tool_code',
  '<function_calls>',
];

/**
 * Extract verifiable claims from LLM output text.
 * Pure function — no side effects (A3).
 */
export function extractClaims(text: string, maxClaims: number): ExtractedClaim[] {
  const claims: ExtractedClaim[] = [];
  const lines = text.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length && claims.length < maxClaims; i++) {
    const line = lines[i]!;

    // Fake tool calls (highest priority — clear hallucination)
    for (const pattern of FAKE_TOOL_PATTERNS) {
      if (line.toLowerCase().includes(pattern.toLowerCase()) && !seen.has(`fake:${pattern}`)) {
        claims.push({ type: 'fake_tool_call', value: pattern, source_line: i + 1 });
        seen.add(`fake:${pattern}`);
      }
    }

    // File path references
    for (const match of line.matchAll(FILE_PATH_RE)) {
      const path = match[1]!;
      if (seen.has(`file:${path}`) || path.length < 4) continue;
      // Filter common false positives
      if (/^\d/.test(path) || /^(http|https|ftp)/.test(path)) continue;
      if (/\.(com|org|net|io|dev)$/.test(path)) continue;
      claims.push({ type: 'file_reference', value: path, source_line: i + 1 });
      seen.add(`file:${path}`);
    }

    // Import claims
    for (const match of line.matchAll(IMPORT_RE)) {
      const importPath = match[1]!;
      if (seen.has(`import:${importPath}`)) continue;
      if (importPath.startsWith('.') || importPath.startsWith('@')) {
        claims.push({ type: 'import_claim', value: importPath, source_line: i + 1 });
        seen.add(`import:${importPath}`);
      }
    }
  }

  return claims.slice(0, maxClaims);
}

/**
 * Verify extracted claims against filesystem ground truth.
 * A3 deterministic, A4 content-addressed.
 */
export function verifyClaims(claims: ExtractedClaim[], workspace: string): GroundingResult {
  let verified = 0;
  let refuted = 0;
  let unverifiable = 0;
  const refutedClaims: Array<ExtractedClaim & { reason: string }> = [];

  for (const claim of claims) {
    switch (claim.type) {
      case 'fake_tool_call': {
        // Fake tool calls are always refuted — clear hallucination
        refuted++;
        refutedClaims.push({ ...claim, reason: 'Hallucinated tool call syntax detected' });
        break;
      }

      case 'file_reference': {
        const fullPath = isAbsolute(claim.value) ? claim.value : resolve(workspace, claim.value);
        if (existsSync(fullPath)) {
          verified++;
        } else {
          refuted++;
          refutedClaims.push({ ...claim, reason: `File not found: ${claim.value}` });
        }
        break;
      }

      case 'import_claim': {
        // Relative imports: resolve against workspace
        if (claim.value.startsWith('.')) {
          // Can't resolve without knowing the source file — mark unverifiable
          unverifiable++;
        } else if (claim.value.startsWith('@')) {
          // Path alias — check if src/ equivalent exists
          const resolved = claim.value.replace(/^@vinyan\//, 'src/');
          const fullPath = resolve(workspace, resolved);
          // Try with common extensions
          const exists = ['.ts', '.tsx', '/index.ts', ''].some((ext) => existsSync(fullPath + ext));
          if (exists) verified++;
          else {
            refuted++;
            refutedClaims.push({ ...claim, reason: `Import not found: ${claim.value}` });
          }
        } else {
          unverifiable++; // External package — can't verify without node_modules scan
        }
        break;
      }

      case 'symbol_reference': {
        unverifiable++; // Requires AST parsing — delegated to AST oracle
        break;
      }
    }
  }

  const totalVerifiable = verified + refuted;
  const groundingRatio = totalVerifiable > 0 ? verified / totalVerifiable : 0.5;

  return { claims, verified, refuted, unverifiable, grounding_ratio: groundingRatio, refuted_claims: refutedClaims };
}
