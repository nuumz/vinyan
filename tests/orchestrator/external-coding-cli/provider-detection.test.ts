/**
 * Provider detection — exercise probeBinary + adapters against fake binaries
 * and the real local environment.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/orchestrator/external-coding-cli/providers/claude-code-adapter.ts';
import { GitHubCopilotAdapter } from '../../../src/orchestrator/external-coding-cli/providers/github-copilot-adapter.ts';
import { ProviderDetectionRegistry } from '../../../src/orchestrator/external-coding-cli/providers/provider-detection.ts';

function writeFakeBinary(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyan-fake-bin-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const FAKE_CLAUDE_HELP_TEXT = `#!/bin/sh
case "$1" in
  --version) echo "fake-claude 2.0.0";;
  --help)
    cat <<'EOF'
Usage: claude [options]
  -p, --print                Print mode
  -r, --resume               Resume
  --include-hook-events      Include hook events
  --output-format            Output format
  --permission-mode          Permission mode
EOF
    ;;
  *)
    echo "fake-claude" ;;
esac
`;

const FAKE_COPILOT_HELP_TEXT = `#!/bin/sh
case "$1" in
  --version) echo "fake-copilot 1.0.0";;
  --help)
    cat <<'EOF'
Usage: copilot [options]
  -p, --prompt   Run a prompt headlessly
  --allow-tool   Allow a tool
EOF
    ;;
  *)
    echo "fake-copilot" ;;
esac
`;

const FAKE_GH_NOT_INSTALLED = `#!/bin/sh
case "$1 $2" in
  "copilot --help") echo "Cannot find GitHub Copilot CLI"; echo "Install GitHub Copilot CLI?";;
  *) echo "fake-gh";;
esac
`;

describe('ClaudeCodeAdapter.detect', () => {
  test('reports unavailable when binary missing', async () => {
    const adapter = new ClaudeCodeAdapter({ binaryPath: '/nonexistent/claude' });
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
  });

  test('parses capabilities from fake help text', async () => {
    const bin = writeFakeBinary('claude', FAKE_CLAUDE_HELP_TEXT);
    const adapter = new ClaudeCodeAdapter({ binaryPath: bin });
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);
    expect(detection.capabilities.headless).toBe(true);
    expect(detection.capabilities.resume).toBe(true);
    expect(detection.capabilities.nativeHooks).toBe(true);
    expect(detection.capabilities.jsonOutput).toBe(true);
    expect(detection.capabilities.approvalPrompts).toBe(true);
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });
});

describe('GitHubCopilotAdapter.detect', () => {
  test('reports unavailable when no binary found', async () => {
    const adapter = new GitHubCopilotAdapter({ binaryPath: '/nonexistent/copilot', legacyGhCopilotFallback: false });
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
    expect(detection.notes.length).toBeGreaterThan(0);
  });

  test('detects standalone copilot variant from fake help', async () => {
    const bin = writeFakeBinary('copilot', FAKE_COPILOT_HELP_TEXT);
    const adapter = new GitHubCopilotAdapter({ binaryPath: bin, legacyGhCopilotFallback: false });
    const detection = await adapter.detect();
    expect(detection.available).toBe(true);
    expect(detection.variant).toBe('full');
    expect(detection.capabilities.headless).toBe(true);
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });

  test('marks as not-installed when gh wrapper says Cannot find', async () => {
    const bin = writeFakeBinary('copilot', FAKE_GH_NOT_INSTALLED);
    const adapter = new GitHubCopilotAdapter({ binaryPath: bin, legacyGhCopilotFallback: false });
    const detection = await adapter.detect();
    expect(detection.available).toBe(false);
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
  });
});

describe('ProviderDetectionRegistry', () => {
  test('caches detection results and refresh forces re-detect', async () => {
    let detectCount = 0;
    const adapter = {
      id: 'claude-code' as const,
      displayName: 'fake',
      async detect() {
        detectCount += 1;
        return {
          providerId: 'claude-code' as const,
          available: true,
          binaryPath: '/fake',
          version: '1.0',
          variant: 'full' as const,
          notes: [],
          capabilities: {
            headless: true, interactive: true, streamProtocol: true, resume: false, nativeHooks: false,
            jsonOutput: false, approvalPrompts: false, toolEvents: false, fileEditEvents: false,
            transcriptAccess: false, statusCommand: false, cancelSupport: true,
          },
        };
      },
      getCapabilities() { return this.detect().then((d) => d.capabilities) as never; },
      buildHeadlessCommand() { return null; },
      buildInteractiveCommand() { throw new Error('not used'); },
      formatInitialPrompt() { return ''; },
      formatFollowupMessage() { return ''; },
      parseOutputDelta() { return []; },
      parseFinalResult() { return null; },
      detectApprovalRequest() { return null; },
      respondToApproval() { return { kind: 'noop', reason: 'fake' } as never; },
    };
    const registry = new ProviderDetectionRegistry(60_000);
    await registry.detectAll([adapter as never]);
    await registry.detectAll([adapter as never]);
    expect(detectCount).toBe(1);
    await registry.detectAll([adapter as never], { forceRefresh: true });
    expect(detectCount).toBe(2);
  });
});
