#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Profile idle resource usage for default supervised `vinyan serve`.
 *
 * Usage:
 *   bun scripts/profile-serve-idle.ts [--duration-ms 60000] [--interval-ms 2000]
 *
 * The script creates a temporary workspace with an isolated API port, starts
 * the normal CLI entrypoint, samples parent+child RSS/CPU via `ps`, then
 * shuts the server down cleanly.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Sample {
  atMs: number;
  processes: Array<{ pid: number; ppid: number; cpuPct: number; rssKb: number; command: string }>;
}

const args = process.argv.slice(2);
const durationMs = readNumberFlag('--duration-ms', 60_000);
const intervalMs = readNumberFlag('--interval-ms', 2_000);
const port = 39_000 + Math.floor(Math.random() * 500);
const workspace = mkdtempSync(join(tmpdir(), 'vinyan-serve-profile-'));
const cliPath = resolve('src/cli/index.ts');
const samples: Sample[] = [];

writeFileSync(
  join(workspace, 'vinyan.json'),
  JSON.stringify(
    {
      network: {
        api: { port, bind: '127.0.0.1', auth_required: false, rate_limit_enabled: false },
      },
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, [cliPath, 'serve', workspace], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VINYAN_PROFILE: process.env.VINYAN_PROFILE ?? 'default' },
});

child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

const startedAt = Date.now();
let sampler: ReturnType<typeof setInterval> | undefined;
let durationTimer: ReturnType<typeof setTimeout> | undefined;
let shutdownStarted = false;

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

sampler = setInterval(() => {
  void sampleTree(child.pid, Date.now() - startedAt).then((sample) => {
    samples.push(sample);
  });
}, intervalMs);

durationTimer = setTimeout(() => {
  void shutdown('duration elapsed');
}, durationMs);

child.once('exit', () => {
  void shutdown('child exited');
});

async function shutdown(reason: string) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (sampler) clearInterval(sampler);
  if (durationTimer) clearTimeout(durationTimer);
  child.kill('SIGTERM');
  await waitForExit(5_000);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sampleTree(child.pid, Date.now() - startedAt).then((sample) => samples.push(sample)).catch(() => undefined);
  printSummary(reason);
  rmSync(workspace, { recursive: true, force: true });
}

function readNumberFlag(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  const raw = args[idx + 1];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function sampleTree(rootPid: number | undefined, atMs: number): Promise<Sample> {
  if (!rootPid) return { atMs, processes: [] };
  const rows = await psRows();
  const descendants = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return { atMs, processes: rows.filter((row) => descendants.has(row.pid)) };
}

async function psRows(): Promise<Sample['processes']> {
  const proc = spawn('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  proc.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpuPct: Number(match[3]),
        rssKb: Number(match[4]),
        command: match[5] ?? '',
      };
    })
    .filter((row): row is Sample['processes'][number] => row !== null);
}

async function waitForExit(timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function printSummary(reason: string) {
  const nonEmpty = samples.filter((sample) => sample.processes.length > 0);
  const totals = nonEmpty.map((sample) => ({
    atMs: sample.atMs,
    cpuPct: sum(sample.processes.map((p) => p.cpuPct)),
    rssMb: sum(sample.processes.map((p) => p.rssKb)) / 1024,
    processCount: sample.processes.length,
  }));
  // Hygiene fix (NOT part of audit redesign): tsc strict-null check —
  // reducing into `null` initial breaks `best.rssMb` access. Use a guarded
  // initial that drops the reduction when there are no samples.
  const peak = totals.length > 0 ? totals.reduce((best, next) => (next.rssMb > best.rssMb ? next : best)) : null;
  const avgCpu = totals.length > 0 ? sum(totals.map((t) => t.cpuPct)) / totals.length : 0;
  const last = totals[totals.length - 1] ?? null;

  console.log('\n[vinyan-profile] idle serve profile complete');
  console.log(`[vinyan-profile] reason=${reason}`);
  console.log(`[vinyan-profile] workspace=${workspace}`);
  console.log(`[vinyan-profile] port=${port}`);
  console.log(`[vinyan-profile] samples=${totals.length}`);
  console.log(`[vinyan-profile] avgCpuPct=${avgCpu.toFixed(2)}`);
  if (peak) console.log(`[vinyan-profile] peakRssMb=${peak.rssMb.toFixed(1)} atMs=${peak.atMs}`);
  if (last) console.log(`[vinyan-profile] finalRssMb=${last.rssMb.toFixed(1)} processes=${last.processCount}`);
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
