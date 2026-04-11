/**
 * vinyan oracle test — CLI command to test oracle implementations.
 *
 * Usage: vinyan oracle test <oracle-name> [--workspace <path>]
 *
 * Sends a basic HypothesisTuple to the named oracle and displays the verdict.
 */

import { getOracleEntry, listOraclesForLanguage } from '../oracle/registry.ts';
import { runOracle } from '../oracle/runner.ts';

export async function runOracleTest(args: string[]): Promise<void> {
  const oracleName = args[0];
  const workspaceIdx = args.indexOf('--workspace');
  const workspace = workspaceIdx >= 0 ? args[workspaceIdx + 1]! : process.cwd();
  const target = args.find((a) => !a.startsWith('--') && a !== oracleName) ?? '.';
  const pattern = args.includes('--pattern') ? args[args.indexOf('--pattern') + 1]! : 'type-check';

  if (!oracleName) {
    // List available oracles
    console.log('Available oracles:');
    const entry = getOracleEntry;
    for (const lang of ['typescript', 'python', 'go', 'rust', 'javascript']) {
      const oracles = listOraclesForLanguage(lang);
      if (oracles.length > 0) {
        console.log(`  ${lang}: ${oracles.join(', ')}`);
      }
    }
    console.log('\nUsage: vinyan oracle test <oracle-name> [--workspace <path>] [--pattern <pattern>]');
    return;
  }

  const entry = getOracleEntry(oracleName);
  if (!entry) {
    console.error(`Oracle "${oracleName}" not found in registry.`);
    console.error('Use `vinyan oracle test` without arguments to list available oracles.');
    process.exit(1);
  }

  console.log(`Testing oracle: ${oracleName}`);
  console.log(`  Workspace: ${workspace}`);
  console.log(`  Target: ${target}`);
  console.log(`  Pattern: ${pattern}`);
  console.log(`  Tier: ${entry.tier ?? 'unknown'}`);
  console.log('');

  try {
    const startTime = performance.now();
    const verdict = await runOracle(oracleName, {
      target,
      pattern,
      workspace,
    });
    const durationMs = Math.round(performance.now() - startTime);

    console.log('Result:');
    console.log(`  verified: ${verdict.verified}`);
    console.log(`  type: ${verdict.type}`);
    console.log(`  confidence: ${verdict.confidence}`);
    console.log(`  durationMs: ${verdict.durationMs ?? durationMs}`);
    if (verdict.reason) console.log(`  reason: ${verdict.reason}`);
    if (verdict.errorCode) console.log(`  errorCode: ${verdict.errorCode}`);
    if (verdict.evidence.length > 0) {
      console.log(`  evidence (${verdict.evidence.length}):`);
      for (const e of verdict.evidence.slice(0, 10)) {
        console.log(`    ${e.file}:${e.line} — ${e.snippet}`);
      }
      if (verdict.evidence.length > 10) {
        console.log(`    ... and ${verdict.evidence.length - 10} more`);
      }
    }

    process.exit(verdict.verified ? 0 : 1);
  } catch (err) {
    console.error(`Oracle test failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
