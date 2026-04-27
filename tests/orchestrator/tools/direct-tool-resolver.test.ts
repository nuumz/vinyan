/**
 * Tests for direct-tool-resolver — deterministic platform-aware command resolution.
 */
import { describe, expect, test } from 'bun:test';
import { classifyDirectTool, clearDiscoveryCache, discoverApp, resolveCommand } from '../../../src/orchestrator/tools/direct-tool-resolver.ts';

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
  // ── Bare app name (no verb) ──
  test('Thai: "แอพ notes" → app_launch (implied open)', () => {
    const result = classifyDirectTool('แอพ notes');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('app_launch');
    expect(result!.target).toBe('notes');
  });

  test('Thai: "แอป chrome" → app_launch', () => {
    const result = classifyDirectTool('แอป chrome');
    expect(result).not.toBeNull();
    expect(result!.target).toBe('chrome');
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

  // ── Filesystem inspection (shell_exec) ──
  describe('filesystem inspection', () => {
    test('Thai "ตรวจสอบไฟล์ ~/Desktop/" → ls', () => {
      const out = classifyDirectTool('ตรวจสอบไฟล์ ~/Desktop/');
      expect(out?.type).toBe('shell_exec');
      expect(out?.confidence).toBeGreaterThanOrEqual(0.85);
      // `~/Desktop/` is shell-quoted by quoteArg because `~` falls outside
      // the safe-char allowlist; both `ls -la ~/Desktop/` and the quoted
      // form expand the same way under any POSIX shell.
      expect(out?.command).toMatch(/^ls -la "?~\/Desktop\/"?$/);
    });

    test('English "list files in /tmp" → ls', () => {
      const out = classifyDirectTool('list files in /tmp');
      expect(out?.type).toBe('shell_exec');
      expect(out?.command).toBe('ls -la /tmp');
    });

    test('English "ls /var/log" → ls', () => {
      const out = classifyDirectTool('ls /var/log');
      expect(out?.type).toBe('shell_exec');
      expect(out?.command).toBe('ls -la /var/log');
    });

    test('Thai "ดู src/index.ts" → cat (single file by extension)', () => {
      const out = classifyDirectTool('ดู src/index.ts');
      expect(out?.type).toBe('shell_exec');
      expect(out?.command).toBe('cat src/index.ts');
    });

    test('English "show contents of ./README.md" → cat', () => {
      const out = classifyDirectTool('show contents of ./README.md');
      expect(out?.type).toBe('shell_exec');
      expect(out?.command).toBe('cat ./README.md');
    });

    test('"ตรวจสอบ" without a path returns null (no execution target)', () => {
      expect(classifyDirectTool('ตรวจสอบ')).toBeNull();
    });

    test('"ตรวจสอบนิทาน" with no path-like tail returns null', () => {
      expect(classifyDirectTool('ตรวจสอบนิทาน')).toBeNull();
    });

    test('"list improvements for the bedtime story" returns null (no path prefix)', () => {
      expect(classifyDirectTool('list improvements for the bedtime story')).toBeNull();
    });

    test('quoted path is unwrapped and ls executed', () => {
      const out = classifyDirectTool('ตรวจสอบ ~/Desktop/');
      expect(out?.type).toBe('shell_exec');
      expect(out?.command).toMatch(/^ls -la "?~\/Desktop\/"?$/);
    });

    test('resolveCommand returns the pre-resolved shell_exec command verbatim', () => {
      const cls = classifyDirectTool('list files in /tmp')!;
      expect(resolveCommand(cls, 'darwin')).toBe('ls -la /tmp');
    });
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

  // ── Office apps ──
  test('macOS: outlook → open -a "Microsoft Outlook"', () => {
    const classification = classifyDirectTool('เปิดแอพ outlook');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a "Microsoft Outlook"');
  });

  test('macOS: word → open -a "Microsoft Word"', () => {
    const classification = classifyDirectTool('open word');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a "Microsoft Word"');
  });

  test('macOS: excel → open -a "Microsoft Excel"', () => {
    const classification = classifyDirectTool('open excel');
    const cmd = resolveCommand(classification!, 'darwin');
    expect(cmd).toBe('open -a "Microsoft Excel"');
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

describe('discoverApp', () => {
  test('returns null on non-darwin platform', async () => {
    const result = await discoverApp('outlook', 'linux');
    expect(result).toBeNull();
  });

  // This test runs on macOS only — discovers real installed apps
  test('discovers apps from /Applications/ on macOS', async () => {
    clearDiscoveryCache();
    if (process.platform !== 'darwin') return; // skip on non-macOS

    // Safari should always exist on macOS
    const result = await discoverApp('safari');
    expect(result).toBe('Safari');
  });
});
