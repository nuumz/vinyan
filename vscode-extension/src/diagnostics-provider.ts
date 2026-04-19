/**
 * Diagnostics Provider — maps OracleVerdict evidence to VS Code diagnostics.
 *
 * A4: Inline fact validity via content hash — auto-clears on hash mismatch.
 */
import * as vscode from 'vscode';
import type { SSEEvent, VinyanClient } from './api-client';

interface Evidence {
  file: string;
  line: number;
  snippet: string;
  contentHash?: string;
}

interface OracleVerdict {
  verified: boolean;
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  confidence: number;
  evidence: Evidence[];
  fileHashes: Record<string, string>;
  reason?: string;
  oracleName?: string;
}

export class VinyanDiagnosticsProvider implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileHashes = new Map<string, string>();

  constructor(client: VinyanClient) {
    this.collection = vscode.languages.createDiagnosticCollection('vinyan');

    // Listen for oracle verdicts from SSE
    this.disposables.push(
      client.onSSEEvent((evt) => {
        if (evt.event === 'oracle:verdict') {
          this.handleVerdict(evt.payload as { taskId: string; oracleName: string; verdict: OracleVerdict });
        }
      }),
    );

    // Clear diagnostics when file content changes (hash mismatch → A4)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.clearStaleForUri(e.document.uri);
      }),
    );
  }

  private handleVerdict(payload: { taskId: string; oracleName: string; verdict: OracleVerdict }): void {
    const { verdict, oracleName } = payload;

    // Track file hashes for staleness detection
    for (const [file, hash] of Object.entries(verdict.fileHashes)) {
      this.fileHashes.set(file, hash);
    }

    // Group evidence by file
    const byFile = new Map<string, Evidence[]>();
    for (const ev of verdict.evidence) {
      const existing = byFile.get(ev.file) ?? [];
      existing.push(ev);
      byFile.set(ev.file, existing);
    }

    // Create diagnostics per file
    for (const [filePath, evidenceList] of byFile) {
      const uri = vscode.Uri.file(filePath);
      const existing = this.collection.get(uri) ?? [];
      const newDiags: vscode.Diagnostic[] = [...existing];

      for (const ev of evidenceList) {
        const line = Math.max(0, ev.line - 1); // VS Code is 0-indexed
        const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
        const severity = this.mapSeverity(verdict);
        const message = this.formatMessage(verdict, oracleName, ev);

        const diag = new vscode.Diagnostic(range, message, severity);
        diag.source = `vinyan:${oracleName}`;
        newDiags.push(diag);
      }

      this.collection.set(uri, newDiags);
    }
  }

  private mapSeverity(verdict: OracleVerdict): vscode.DiagnosticSeverity {
    if (!verdict.verified) {
      return vscode.DiagnosticSeverity.Error;
    }
    if (verdict.type === 'uncertain') {
      return vscode.DiagnosticSeverity.Warning;
    }
    if (verdict.type === 'unknown') {
      return vscode.DiagnosticSeverity.Information;
    }
    return vscode.DiagnosticSeverity.Information;
  }

  private formatMessage(verdict: OracleVerdict, oracleName: string, evidence: Evidence): string {
    const prefix = `[${oracleName}]`;
    // Phase 0 W4: history-compressor adds a "… [+N chars]" suffix to long
    // snippets. Preserve it verbatim so the diagnostic message tells the
    // user the evidence was truncated rather than silently dropping bytes.
    const snippet = preserveCompressionMarker(evidence.snippet);
    if (verdict.reason) {
      return `${prefix} ${verdict.reason} — ${snippet}`;
    }
    if (!verdict.verified) {
      return `${prefix} Verification failed — ${snippet}`;
    }
    if (verdict.type === 'uncertain') {
      return `${prefix} Uncertain (confidence: ${(verdict.confidence * 100).toFixed(0)}%) — ${snippet}`;
    }
    return `${prefix} ${snippet}`;
  }

  private clearStaleForUri(uri: vscode.Uri): void {
    // When file changes, all existing diagnostics for that file are stale
    // because the content hash no longer matches
    if (this.collection.has(uri)) {
      this.collection.delete(uri);
    }
  }

  clearAll(): void {
    this.collection.clear();
    this.fileHashes.clear();
  }

  dispose(): void {
    this.collection.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Phase 0 W4: keep the `… [+N chars]` history-compression marker (added by
 * the perception-compressor when truncating long snippets) intact in the
 * rendered diagnostic. The marker ends with `]` and contains a `[+`
 * substring; if present, the original snippet is returned verbatim so the
 * user sees that bytes were dropped rather than getting a silently
 * shortened message.
 */
function preserveCompressionMarker(snippet: string): string {
  if (!snippet) return snippet;
  // Marker shape (e.g. "… [+47 chars]") — anchored to the snippet's end.
  if (snippet.endsWith(']') && snippet.lastIndexOf('[+') > -1) {
    return snippet;
  }
  return snippet;
}
