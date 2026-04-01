/**
 * Oracle Accuracy Listener — resolves pending oracle verdicts based on task outcomes.
 *
 * Subscribes to task:complete events and updates the OracleAccuracyStore
 * with post-hoc outcome signals:
 *   - status=completed → confirmed_correct (task succeeded, oracle verdicts were right)
 *   - status=failed → confirmed_wrong (task failed, oracle verdicts may have been wrong)
 *
 * A7 compliance: Prediction Error as Learning — measures oracle predictive power
 * against real-world outcomes rather than circular gate agreement.
 */
import type { VinyanBus } from '../core/bus.ts';
import type { OracleAccuracyStore } from '../db/oracle-accuracy-store.ts';

export function attachOracleAccuracyListener(
  bus: VinyanBus,
  store: OracleAccuracyStore,
): () => void {
  const detach = bus.on('task:complete', ({ result }) => {
    try {
      const affectedFiles = result.trace.affectedFiles;
      if (!affectedFiles || affectedFiles.length === 0) return;

      if (result.status === 'completed') {
        store.resolveByFiles(affectedFiles, 'confirmed_correct');
      } else if (result.status === 'failed') {
        store.resolveByFiles(affectedFiles, 'confirmed_wrong');
      }
      // status === "escalated" → leave as pending (outcome not yet determined)
    } catch {
      // Accuracy tracking is best-effort — never break the core loop
    }
  });

  return detach;
}
