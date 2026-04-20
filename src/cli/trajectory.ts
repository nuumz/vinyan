/**
 * `vinyan trajectory` subcommand — export execution traces to ShareGPT.
 *
 * Usage:
 *   vinyan trajectory export [--profile <name>]
 *                            [--since <ISO>]
 *                            [--outcome <list>]
 *                            [--min-quality <0..1>]
 *                            [--out-dir <path>]
 *                            [--dry-run]
 *
 * On success prints dataset id, row count, artifact + manifest paths, SHA.
 * On empty result exits 0 with a friendly message; no files are written
 * (beyond the manifest stub the exporter always produces in non-dry-run).
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exportTrajectories, type Outcome } from '../trajectory/exporter.ts';

type Flags = {
  profile: string;
  sinceMs?: number;
  outcome?: Outcome[];
  minQuality?: number;
  outDir?: string;
  dryRun: boolean;
  workspace: string;
};

const KNOWN_OUTCOMES: ReadonlySet<Outcome> = new Set(['success', 'failure', 'timeout', 'escalated']);

export async function runTrajectoryCommand(args: string[], workspacePath: string): Promise<void> {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }

  if (sub !== 'export') {
    console.error(`Unknown trajectory subcommand: ${sub}`);
    printUsage(process.stderr);
    process.exit(1);
  }

  // The top-level CLI passes args[1] as `workspacePath`. When the user invokes
  // `vinyan trajectory export`, that positional is the subcommand ("export"),
  // not a workspace. Fall back to cwd so we resolve `.vinyan/` relative to
  // where the user is actually working.
  const resolvedWorkspace =
    workspacePath === 'export' || workspacePath === sub ? process.cwd() : workspacePath;

  const flags = parseFlags(args.slice(1), resolvedWorkspace);
  await runExport(flags);
}

function printUsage(stream: NodeJS.WritableStream = process.stdout): void {
  stream.write(`vinyan trajectory — export execution traces

Subcommands:
  export    Export traces to ShareGPT-baseline JSONL.gz

Flags (export):
  --profile <name>        Profile to export (default: 'default')
  --since <ISO>           Lower time bound (default: now - 7d)
  --outcome <list>        Comma-separated outcomes: success,failure,timeout,escalated
  --min-quality <0..1>    Minimum quality_composite
  --out-dir <path>        Output directory (default: <vinyan-home>/trajectories/<id>)
  --dry-run               Compute manifest; do not write artifact
`);
}

function parseFlags(args: string[], workspacePath: string): Flags {
  const flags: Flags = {
    profile: 'default',
    dryRun: false,
    workspace: workspacePath,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--profile':
        flags.profile = requireValue(args, ++i, '--profile');
        break;
      case '--since': {
        const raw = requireValue(args, ++i, '--since');
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) {
          console.error(`Invalid --since: ${raw} (expected ISO 8601)`);
          process.exit(2);
        }
        flags.sinceMs = ms;
        break;
      }
      case '--outcome': {
        const raw = requireValue(args, ++i, '--outcome');
        const parts = raw.split(',').map((s) => s.trim()) as Outcome[];
        for (const p of parts) {
          if (!KNOWN_OUTCOMES.has(p)) {
            console.error(`Invalid outcome: ${p}`);
            process.exit(2);
          }
        }
        flags.outcome = parts;
        break;
      }
      case '--min-quality': {
        const raw = requireValue(args, ++i, '--min-quality');
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          console.error(`Invalid --min-quality: ${raw} (expected 0..1)`);
          process.exit(2);
        }
        flags.minQuality = n;
        break;
      }
      case '--out-dir':
        flags.outDir = requireValue(args, ++i, '--out-dir');
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
      default:
        if (arg?.startsWith('--')) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(2);
        }
    }
  }

  return flags;
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (!v || v.startsWith('--')) {
    console.error(`Missing value for ${flag}`);
    process.exit(2);
  }
  return v;
}

async function runExport(flags: Flags): Promise<void> {
  const vinyanHome = join(flags.workspace, '.vinyan');
  const dbPath = join(vinyanHome, 'vinyan.db');

  if (!existsSync(dbPath)) {
    console.error(`No database found at ${dbPath}`);
    console.error(`Run \`vinyan init\` and produce at least one trace first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: flags.dryRun });
  try {
    const result = await exportTrajectories(db, {
      profile: flags.profile,
      sinceMs: flags.sinceMs,
      outcome: flags.outcome,
      minQualityComposite: flags.minQuality,
      outDir: flags.outDir,
      dryRun: flags.dryRun,
      vinyanHome,
    });

    if (result.rowCount === 0) {
      console.log('No matching traces; nothing written.');
      return;
    }

    console.log(`dataset_id:    ${result.datasetId}`);
    console.log(`rows:          ${result.rowCount}`);
    console.log(`artifact:      ${result.artifactPath}`);
    console.log(`manifest:      ${result.manifestPath}`);
    console.log(`sha256:        ${result.sha256}`);
    console.log(`bytes:         ${result.bytes}`);
    console.log(`duration_ms:   ${result.durationMs}`);
    if (result.dryRun) {
      console.log('(dry-run — no files written)');
    }
  } finally {
    db.close();
  }
}
