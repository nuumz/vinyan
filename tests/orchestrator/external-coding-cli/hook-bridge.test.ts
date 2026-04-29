import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HookBridge, HookSink, synthWrapperEvent } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-hook-bridge.ts';

function tmpFile(): string {
  return path.join(os.tmpdir(), `vinyan-hook-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

describe('HookSink', () => {
  test('append + drain round-trips', () => {
    const file = tmpFile();
    const sink = new HookSink({ path: file });
    sink.appendSync(
      synthWrapperEvent({
        providerId: 'claude-code',
        codingCliSessionId: 's1',
        taskId: 't1',
        cwd: '/tmp',
        hookName: 'PreToolUse',
        eventType: 'tool_started',
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/x.ts' },
      }),
    );
    sink.appendSync(
      synthWrapperEvent({
        providerId: 'claude-code',
        codingCliSessionId: 's1',
        taskId: 't1',
        cwd: '/tmp',
        hookName: 'PostToolUse',
        eventType: 'tool_completed',
        toolName: 'Edit',
        toolResult: { ok: true },
      }),
    );
    const drained = sink.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]!.toolName).toBe('Edit');
    fs.rmSync(file, { force: true });
  });

  test('drain skips malformed lines silently', () => {
    const file = tmpFile();
    const sink = new HookSink({ path: file });
    fs.appendFileSync(file, 'not-json\n');
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        providerId: 'github-copilot',
        codingCliSessionId: 's',
        taskId: 't',
        hookName: 'h',
        eventType: 'e',
        timestamp: Date.now(),
      })}\n`,
    );
    const drained = sink.drain();
    expect(drained).toHaveLength(1);
    fs.rmSync(file, { force: true });
  });
});

describe('HookBridge wrapper events', () => {
  test('emitWrapper persists and counts', () => {
    const file = tmpFile();
    const bridge = new HookBridge({ sinkPath: file, mode: 'wrapper' });
    bridge.emitWrapper({
      providerId: 'github-copilot',
      taskId: 't1',
      codingCliSessionId: 's1',
      cwd: '/tmp',
      hookName: 'wrapper',
      eventType: 'tool_started',
      toolName: 'Bash',
    });
    const report = bridge.report();
    expect(report.wrapperCount).toBe(1);
    expect(report.mode).toBe('wrapper');
    bridge.close();
    fs.rmSync(file, { force: true });
  });

  test('off mode does not block wrapper emission for replay', () => {
    const file = tmpFile();
    const bridge = new HookBridge({ sinkPath: file, mode: 'off' });
    bridge.emitWrapper({
      providerId: 'claude-code',
      taskId: 't',
      codingCliSessionId: 's',
      cwd: '/tmp',
      hookName: 'h',
      eventType: 'e',
    });
    expect(bridge.report().wrapperCount).toBe(1);
    bridge.close();
    fs.rmSync(file, { force: true });
  });
});
