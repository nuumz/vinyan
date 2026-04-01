/**
 * Gate Hooks — lifecycle callbacks for host integration.
 *
 * TDD §8: after_tool_call stores verified oracle verdicts as World Graph facts
 * and refreshes file hashes for affected files.
 */
import type { OracleVerdict } from '../core/types.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';

export interface ToolCallResult {
  toolName: string;
  error?: string;
  affectedFiles: string[];
}

/**
 * Called after a mutation tool succeeds. Converts verified oracle verdicts
 * to World Graph facts and refreshes file hashes.
 *
 * No-op if the tool call had an error.
 */
export async function afterToolCall(
  result: ToolCallResult,
  oracleVerdicts: Record<string, OracleVerdict>,
  worldGraph: WorldGraph,
  sessionId?: string,
): Promise<void> {
  if (result.error) return;
  if (result.affectedFiles.length === 0) return;

  const primaryFile = result.affectedFiles[0]!;

  // Store verified oracle verdicts as facts
  for (const [oracleName, verdict] of Object.entries(oracleVerdicts)) {
    if (!verdict.verified) continue;

    const fileHash = verdict.fileHashes[primaryFile] ?? Object.values(verdict.fileHashes)[0] ?? '';

    worldGraph.storeFact({
      target: primaryFile,
      pattern: `${oracleName}:${verdict.type}`,
      evidence: verdict.evidence,
      oracleName: oracleName,
      fileHash: fileHash,
      sourceFile: primaryFile,
      verifiedAt: Date.now(),
      sessionId: sessionId,
      confidence: verdict.confidence,
    });
  }

  // Refresh file hashes for affected files — triggers cascade invalidation of stale facts
  for (const file of result.affectedFiles) {
    try {
      worldGraph.invalidateByFile(file);
    } catch {
      // File may not exist (e.g., deleted by the tool call)
    }
  }
}
