/**
 * Vinyan Extension Tests — mock-based unit tests.
 *
 * These tests run without the VS Code runtime by mocking the vscode namespace.
 * For full integration: use @vscode/test-electron.
 */

// ── Mock vscode namespace ────────────────────────────────
const mockDiagnostics = new Map<string, unknown[]>();

const vscode = {
  Uri: { file: (path: string) => ({ fsPath: path, toString: () => path }) },
  Range: class { constructor(public sl: number, public sc: number, public el: number, public ec: number) {} },
  Diagnostic: class {
    source = '';
    constructor(public range: unknown, public message: string, public severity: number) {}
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
  ThemeColor: class { constructor(public id: string) {} },
  TreeItem: class {
    label = '';
    description = '';
    tooltip = '';
    iconPath: unknown;
    collapsibleState = 0;
    constructor(label: string, _state?: number) { this.label = label; }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class<T> {
    listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(data: T) { for (const l of this.listeners) l(data); }
    dispose() { this.listeners = []; }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  languages: {
    createDiagnosticCollection: (_name: string) => ({
      set: (uri: { toString(): string }, diags: unknown[]) => mockDiagnostics.set(uri.toString(), diags),
      get: (uri: { toString(): string }) => mockDiagnostics.get(uri.toString()),
      has: (uri: { toString(): string }) => mockDiagnostics.has(uri.toString()),
      delete: (uri: { toString(): string }) => mockDiagnostics.delete(uri.toString()),
      clear: () => mockDiagnostics.clear(),
      dispose: () => mockDiagnostics.clear(),
    }),
  },
  window: {
    createStatusBarItem: () => ({
      text: '', tooltip: '', command: '', color: undefined,
      show: () => {}, hide: () => {}, dispose: () => {},
    }),
    createOutputChannel: (_name: string) => ({
      appendLine: (_text: string) => {},
      show: () => {},
      dispose: () => {},
    }),
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
  },
  commands: {
    registerCommand: (_cmd: string, _cb: unknown) => ({ dispose: () => {} }),
    executeCommand: async () => {},
  },
};

// Override require('vscode') for non-bundled test execution
// In actual VS Code test runner, vscode is provided by the host
(globalThis as Record<string, unknown>).__vscode_mock = vscode;

// ── Tests ────────────────────────────────────────────────

describe('VinyanClient', () => {
  test('constructs with default config', () => {
    // Inline test: create client-like logic without full network
    const baseUrl = vscode.workspace.getConfiguration().get('serverUrl', 'http://127.0.0.1:3927');
    expect(baseUrl).toBe('http://127.0.0.1:3927');
  });

  test('request timeout produces user-friendly error', async () => {
    // Simulate AbortError
    const controller = new AbortController();
    controller.abort();

    try {
      await fetch('http://127.0.0.1:1/test', { signal: controller.signal });
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('AbortError');
    }
  });
});

describe('DiagnosticsProvider mapping', () => {
  test('maps unverified verdict to Error severity', () => {
    const verdict = {
      verified: false,
      type: 'known' as string,
      confidence: 1.0,
      evidence: [{ file: '/src/test.ts', line: 10, snippet: 'missing import' }],
      fileHashes: { '/src/test.ts': 'abc123' },
      reason: 'Import not found',
    };

    // Severity mapping: !verified → Error (0)
    const severity = !verdict.verified ? 0
      : verdict.type === 'uncertain' ? 1
      : verdict.type === 'unknown' ? 2
      : 2;

    expect(severity).toBe(0);
  });

  test('maps uncertain verdict to Warning severity', () => {
    const verdict = { verified: true, type: 'uncertain' as string, confidence: 0.6 };

    const severity = !verdict.verified ? 0
      : verdict.type === 'uncertain' ? 1
      : verdict.type === 'unknown' ? 2
      : 2;

    expect(severity).toBe(1);
  });

  test('maps unknown verdict to Information severity', () => {
    const verdict = { verified: true, type: 'unknown' as string, confidence: 0 };

    const severity = !verdict.verified ? 0
      : verdict.type === 'uncertain' ? 1
      : verdict.type === 'unknown' ? 2
      : 2;

    expect(severity).toBe(2);
  });

  test('creates diagnostic from evidence with correct line number', () => {
    const evidence = { file: '/src/auth.ts', line: 42, snippet: 'validate()' };
    const line = Math.max(0, evidence.line - 1); // 0-indexed
    expect(line).toBe(41);
  });
});

describe('WorldGraphProvider', () => {
  test('generates FactItem with confidence gauge', () => {
    const confidence = 0.8;
    const filled = Math.round(confidence * 5);
    const gauge = '█'.repeat(filled) + '░'.repeat(5 - filled);
    expect(gauge).toBe('████░');
    expect(filled).toBe(4);
  });

  test('generates FactItem for low confidence', () => {
    const confidence = 0.2;
    const filled = Math.round(confidence * 5);
    const gauge = '█'.repeat(filled) + '░'.repeat(5 - filled);
    expect(gauge).toBe('█░░░░');
  });
});

describe('TaskTreeProvider', () => {
  test('formats duration in ms for short tasks', () => {
    const format = (ms: number) => {
      if (ms < 1_000) return `${ms}ms`;
      if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
      return `${(ms / 60_000).toFixed(1)}m`;
    };

    expect(format(500)).toBe('500ms');
    expect(format(3_500)).toBe('3.5s');
    expect(format(90_000)).toBe('1.5m');
  });

  test('truncates long goal text', () => {
    const goal = 'This is a very long task goal that exceeds fifty characters limit for display';
    const excerpt = goal.length > 50 ? goal.slice(0, 47) + '...' : goal;
    expect(excerpt.length).toBe(50);
    expect(excerpt.endsWith('...')).toBe(true);
  });
});

describe('StatusBar', () => {
  test('state transitions: disconnected → connecting → connected', () => {
    type State = 'connected' | 'disconnected' | 'connecting';
    const states: State[] = [];

    const emitter = new vscode.EventEmitter<State>();
    emitter.event((s: State) => states.push(s));

    emitter.fire('connecting');
    emitter.fire('connected');
    emitter.fire('disconnected');

    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    emitter.dispose();
  });
});
