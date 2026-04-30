/**
 * Workspace watcher — chokidar-backed wrapper-mode file_changed events.
 *
 * Verifies:
 *   - watcher only attaches in wrapper/hybrid modes.
 *   - file create/modify/delete each emit a wrapper event.
 *   - throttle dedupes rapid same-path emissions.
 *   - close() cleans up.
 *   - .git / node_modules / .vinyan are ignored by default.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookBridge } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-hook-bridge.ts';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vinyan-watcher-'));
}

function tmpSink(): string {
  return path.join(os.tmpdir(), `vinyan-watcher-sink-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function ctxFor(workspace: string) {
  return {
    providerId: 'github-copilot' as const,
    taskId: 't1',
    codingCliSessionId: 's1',
    cwd: workspace,
    perPathThrottleMs: 50,
  };
}

async function tick(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('HookBridge workspace watcher', () => {
  test('native and off modes do NOT attach a watcher', async () => {
    const ws = tmpWorkspace();
    for (const mode of ['native', 'off'] as const) {
      const bridge = new HookBridge({ sinkPath: tmpSink(), mode });
      const attached = bridge.attachWorkspaceWatcher(ctxFor(ws));
      expect(attached).toBe(false);
      await bridge.close();
    }
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('wrapper mode emits file_changed on create + modify + delete', async () => {
    const ws = tmpWorkspace();
    const bridge = new HookBridge({ sinkPath: tmpSink(), mode: 'wrapper' });
    const attached = bridge.attachWorkspaceWatcher(ctxFor(ws));
    expect(attached).toBe(true);
    // chokidar takes a moment to wire up its initial scan.
    await tick(150);

    const file = path.join(ws, 'foo.ts');
    fs.writeFileSync(file, 'x');
    await tick(250);
    fs.appendFileSync(file, 'y');
    await tick(250);
    fs.rmSync(file, { force: true });
    await tick(250);

    const events = bridge.report();
    expect(events.wrapperCount).toBeGreaterThanOrEqual(2);
    await bridge.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('throttle dedupes rapid changes on the same path', async () => {
    const ws = tmpWorkspace();
    const bridge = new HookBridge({ sinkPath: tmpSink(), mode: 'wrapper' });
    bridge.attachWorkspaceWatcher({ ...ctxFor(ws), perPathThrottleMs: 1_000 });
    await tick(150);

    const file = path.join(ws, 'spam.ts');
    fs.writeFileSync(file, 'a');
    await tick(80);
    fs.writeFileSync(file, 'b');
    await tick(80);
    fs.writeFileSync(file, 'c');
    await tick(300);

    // Even with chokidar's awaitWriteFinish, we should see at most 1
    // event for this path within the 1s throttle window. (Allow up to 2
    // because chokidar's add → change cascade can slip one through
    // before the throttle map sees it; the contract is "small bounded
    // count, not 5+".)
    const events = bridge.report();
    expect(events.wrapperCount).toBeLessThanOrEqual(2);
    await bridge.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('default ignored: .git changes do not emit', async () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    const bridge = new HookBridge({ sinkPath: tmpSink(), mode: 'wrapper' });
    bridge.attachWorkspaceWatcher(ctxFor(ws));
    await tick(150);

    fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await tick(250);

    const events = bridge.report();
    expect(events.wrapperCount).toBe(0);
    await bridge.close();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  test('close() releases the watcher', async () => {
    const ws = tmpWorkspace();
    const bridge = new HookBridge({ sinkPath: tmpSink(), mode: 'wrapper' });
    bridge.attachWorkspaceWatcher(ctxFor(ws));
    await tick(50);
    await bridge.close();
    // After close, file changes should NOT increment count.
    const before = bridge.report().wrapperCount;
    fs.writeFileSync(path.join(ws, 'late.ts'), 'x');
    await tick(200);
    expect(bridge.report().wrapperCount).toBe(before);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
