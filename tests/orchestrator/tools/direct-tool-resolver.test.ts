/**
 * Tests for direct-tool-resolver — deterministic platform-aware command resolution.
 */
import { describe, expect, test } from 'bun:test';
import { classifyDirectTool, resolveCommand } from '../../../src/orchestrator/tools/direct-tool-resolver.ts';

describe('classifyDirectTool', () => {
  // ── Thai app launch ──
  test('Thai: "เปิดแอพ google chrome" → app_launch', () => {
    const result = classifyDirectTool('อยากให้เปิดแอพ google chrome ให้เลย');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.target).toBe('google chrome');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('Thai: "เปิด chrome" → app_launch', () => {
    const result = classifyDirectTool('เปิด chrome');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.target).toBe('chrome');
  });

  test('Thai: "เปิดแอป firefox" → app_launch', () => {
    const result = classifyDirectTool('เปิดแอป firefox');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.target).toBe('firefox');
  });

  test('Thai: "เปิดโปรแกรม vscode" → app_launch', () => {
    const result = classifyDirectTool('เปิดโปรแกรม vscode');
    expect(result).not.toBeNull();
    expect(result!.target).toBe('vscode');
  });

  test('Thai: "เปิด slack ให้หน่อย" → app_launch', () => {
    const result = classifyDirectTool('เปิด slack ให้หน่อย');
    expect(result).not.toBeNull();
    expect(result!.target).toBe('slack');
  });

  // ── English app launch ──
  test('English: "open google chrome" → app_launch', () => {
    const result = classifyDirectTool('open google chrome');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.target).toBe('google chrome');
  });

  test('English: "launch firefox" → app_launch', () => {
    const result = classifyDirectTool('launch firefox');
    expect(result).not.toBeNull();
    expect(result!.target).toBe('firefox');
  });

  test('English: "start vscode" → app_launch', () => {
    const result = classifyDirectTool('start vscode');
    expect(result).not.toBeNull();
    expect(result!.target).toBe('vscode');
  });

  // ── URL open ──
  test('URL: "เปิด https://google.com" → url_open', () => {
    const result = classifyDirectTool('เปิด https://google.com');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('url_open');
    expect(result!.target).toBe('https://google.com');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('URL: "open https://github.com" → url_open', () => {
    const result = classifyDirectTool('open https://github.com');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('url_open');
  });

  // ── File open ──
  test('File: "เปิดไฟล์ readme.md" → file_open', () => {
    const result = classifyDirectTool('เปิดไฟล์ readme.md');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('file_open');
    expect(result!.target).toBe('readme.md');
  });

  // ── Unknown app (lower confidence) ──
  test('unknown app has lower confidence', () => {
    const result = classifyDirectTool('เปิดแอพ some-unknown-app');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.confidence).toBeLessThan(0.9);
  });

  // ── Non-matching goals ──
  test('code task returns null', () => {
    expect(classifyDirectTool('refactor the auth module')).toBeNull();
  });

  test('question returns null', () => {
    expect(classifyDirectTool('อธิบายโค้ดส่วนนี้ให้หน่อย')).toBeNull();
  });
});

describe('resolveCommand', () => {
  // ── macOS (darwin) ──
  test('macOS: google chrome → open -a "Google Chrome"', () => {
    const classification = classifyDirectTool('เปิดแอพ google chrome');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a "Google Chrome"');
  });

  test('macOS: firefox → open -a Firefox', () => {
    const classification = classifyDirectTool('open firefox');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a Firefox');
  });

  test('macOS: vscode → open -a "Visual Studio Code"', () => {
    const classification = classifyDirectTool('เปิด vscode');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a "Visual Studio Code"');
  });

  test('macOS: URL → open https://...', () => {
    const classification = classifyDirectTool('เปิด https://google.com');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open https://google.com');
  });

  test('macOS: file → open readme.md', () => {
    const classification = classifyDirectTool('เปิดไฟล์ readme.md');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open readme.md');
  });

  // ── Linux ──
  test('Linux: google chrome → google-chrome', () => {
    const classification = classifyDirectTool('open google chrome');
    const cmd = resolveCommand(classification!, 'linux');
    expect(cmd).toBe('google-chrome');
  });

  test('Linux: URL → xdg-open', () => {
    const classification = classifyDirectTool('open https://google.com');
    const cmd = resolveCommand(classification!, 'linux');
    expect(cmd).toBe('xdg-open https://google.com');
  });

  // ── Windows ──
  test('Windows: google chrome → start "" chrome', () => {
    const classification = classifyDirectTool('open google chrome');
    const cmd = resolveCommand(classification!, 'win32');
    expect(cmd).toBe('start "" chrome');
  });
});
