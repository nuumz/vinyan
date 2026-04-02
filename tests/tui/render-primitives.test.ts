import { describe, expect, test } from 'bun:test';
import {
  bold,
  color,
  compactPipeline,
  confidenceGauge,
  contextHintsBar,
  dim,
  formatDuration,
  formatTimeShort,
  formatTimestamp,
  gateDot,
  gauge,
  headerBar,
  modeIndicator,
  notificationBar,
  padEnd,
  panel,
  sparkline,
  statusBadge,
  stripAnsi,
  tabBar,
  tabBarWithBadges,
  terminalSizeGuard,
  truncate,
  visibleLength,
} from '../../src/tui/renderer.ts';
import { createInitialState, pushNotification, pushToast } from '../../src/tui/state.ts';

describe('ANSI helpers', () => {
  test('color wraps text with escape codes', () => {
    const result = color('hello', '\x1b[31m');
    expect(result).toContain('\x1b[31m');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[0m');
  });

  test('bold wraps text', () => {
    const result = bold('test');
    expect(result).toContain('\x1b[1m');
  });

  test('dim wraps text', () => {
    const result = dim('test');
    expect(result).toContain('\x1b[2m');
  });
});

describe('stripAnsi', () => {
  test('strips ANSI codes', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('visibleLength', () => {
  test('counts only visible characters', () => {
    expect(visibleLength('hello')).toBe(5);
    expect(visibleLength('\x1b[31mhello\x1b[0m')).toBe(5);
    expect(visibleLength(bold('hi'))).toBe(2);
  });
});

describe('truncate', () => {
  test('truncates long strings', () => {
    const result = truncate('hello world', 5);
    expect(stripAnsi(result)).toBe('hello');
  });

  test('does not truncate short strings', () => {
    const result = truncate('hi', 5);
    expect(stripAnsi(result)).toBe('hi');
  });

  test('handles ANSI codes in string', () => {
    const result = truncate(color('hello world', '\x1b[31m'), 5);
    const visible = stripAnsi(result);
    expect(visible).toBe('hello');
  });
});

describe('padEnd', () => {
  test('pads short strings', () => {
    const result = padEnd('hi', 5);
    expect(visibleLength(result)).toBe(5);
  });

  test('truncates long strings', () => {
    const result = padEnd('hello world', 5);
    expect(visibleLength(result)).toBeLessThanOrEqual(5);
  });
});

describe('formatDuration', () => {
  test('formats milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  test('formats seconds', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });

  test('formats minutes', () => {
    expect(formatDuration(125_000)).toBe('2m5s');
  });

  test('formats hours', () => {
    expect(formatDuration(7_500_000)).toBe('2h05m');
  });
});

describe('formatTimeShort', () => {
  test('formats as HH:MM:SS', () => {
    // Create a date at a known time
    const d = new Date(2024, 0, 1, 14, 32, 5);
    const result = formatTimeShort(d.getTime());
    expect(result).toBe('14:32:05');
  });
});

describe('sparkline', () => {
  test('renders sparkline for values', () => {
    const result = sparkline([1, 2, 3, 4, 5], 5);
    expect(result).toHaveLength(5);
    // First char should be lowest block, last should be highest
    expect(result[0]).toBe('▁');
    expect(result[4]).toBe('█');
  });

  test('handles empty values', () => {
    const result = sparkline([], 5);
    expect(stripAnsi(result)).toBe('─────');
  });

  test('handles single value', () => {
    const result = sparkline([5], 5);
    expect(result).toHaveLength(1);
  });
});

describe('gauge', () => {
  test('renders gauge bar with percentage', () => {
    const result = gauge(0.75, 10);
    const visible = stripAnsi(result);
    expect(visible).toContain('75%');
  });

  test('clamps values to 0-1 range', () => {
    const result = gauge(-0.5, 10);
    expect(stripAnsi(result)).toContain('0%');

    const result2 = gauge(1.5, 10);
    expect(stripAnsi(result2)).toContain('100%');
  });
});

describe('gateDot', () => {
  test('shows green dot for ready', () => {
    const result = gateDot(true, 'Sleep Cycle');
    expect(result).toContain('●');
    expect(result).toContain('Sleep Cycle');
  });

  test('shows grey dot for not ready', () => {
    const result = gateDot(false, 'Evolution');
    expect(result).toContain('○');
  });
});

describe('statusBadge', () => {
  test('renders green for active/completed', () => {
    const result = statusBadge('active');
    expect(result).toContain('ACTIVE');
    expect(result).toContain('\x1b[42m'); // bgGreen
  });

  test('renders red for failed', () => {
    const result = statusBadge('failed');
    expect(result).toContain('FAILED');
    expect(result).toContain('\x1b[41m'); // bgRed
  });

  test('renders yellow for probation', () => {
    const result = statusBadge('probation');
    expect(result).toContain('PROBATION');
    expect(result).toContain('\x1b[43m'); // bgYellow
  });
});

describe('panel', () => {
  test('renders box with title', () => {
    const result = panel('Test', 'content\nline 2', 30, 5);
    expect(result).toContain('Test');
    expect(result).toContain('content');
    expect(result).toContain('┌');
    expect(result).toContain('└');
  });
});

describe('tabBar', () => {
  test('highlights active tab', () => {
    const tabs = [
      { key: '1', label: 'Dashboard' },
      { key: '2', label: 'Tasks' },
    ];
    const result = tabBar(tabs, 0, 50);
    // Active tab should have bold/cyan
    expect(result).toContain('Dashboard');
    expect(result).toContain('Tasks');
  });
});

// ── Phase 2: New Renderer Primitives ────────────────────────────────

describe('compactPipeline', () => {
  test('renders all-done pipeline', () => {
    const pipe = { perceive: 'done' as const, predict: 'done' as const, plan: 'done' as const, generate: 'done' as const, verify: 'done' as const, learn: 'done' as const };
    const result = stripAnsi(compactPipeline(pipe));
    expect(result).toBe('[✓✓✓✓✓✓]');
  });

  test('renders mixed states with correct icons', () => {
    const pipe = { perceive: 'done' as const, predict: 'done' as const, plan: 'done' as const, generate: 'running' as const, verify: 'pending' as const, learn: 'pending' as const };
    const result = stripAnsi(compactPipeline(pipe));
    expect(result).toBe('[✓✓✓▸○○]');
  });

  test('renders skipped step', () => {
    const pipe = { perceive: 'done' as const, predict: 'skipped' as const, plan: 'done' as const, generate: 'done' as const, verify: 'done' as const, learn: 'done' as const };
    const result = stripAnsi(compactPipeline(pipe));
    expect(result).toBe('[✓⊘✓✓✓✓]');
  });
});

describe('confidenceGauge', () => {
  test('renders PASS gauge', () => {
    const result = stripAnsi(confidenceGauge('ast', true, 0.95));
    expect(result).toContain('ast');
    expect(result).toContain('PASS');
    expect(result).toContain('0.95');
  });

  test('renders FAIL gauge', () => {
    const result = stripAnsi(confidenceGauge('dep', false, 0.42));
    expect(result).toContain('FAIL');
    expect(result).toContain('0.42');
  });
});

describe('modeIndicator', () => {
  test('normal mode is dim', () => {
    const result = modeIndicator('normal');
    expect(result).toContain('NORMAL');
    expect(result).toContain('\x1b[2m'); // dim
  });

  test('command mode has blue background', () => {
    const result = modeIndicator('command');
    expect(result).toContain('COMMAND');
    expect(result).toContain('\x1b[44m'); // bgBlue
  });

  test('filter mode has green background', () => {
    const result = modeIndicator('filter');
    expect(result).toContain('FILTER');
    expect(result).toContain('\x1b[42m'); // bgGreen
  });
});

describe('headerBar', () => {
  test('renders with health and counts', () => {
    const state = createInitialState();
    state.health = { status: 'healthy', checks: { database: { ok: true }, shadowQueue: { ok: true, depth: 0 }, circuitBreakers: { ok: true, openCount: 0 } } };
    const result = stripAnsi(headerBar(state, 80));
    expect(result).toContain('VINYAN');
    expect(result).toContain('healthy');
    expect(result).toContain('Tasks: 0/0');
    expect(result).toContain('Peers: 0');
  });

  test('shows notification count when present', () => {
    const state = createInitialState();
    state.health = { status: 'healthy', checks: { database: { ok: true }, shadowQueue: { ok: true, depth: 0 }, circuitBreakers: { ok: true, openCount: 0 } } };
    pushNotification(state, { type: 'approval', message: 'test', priority: 1, timestamp: Date.now(), dismissed: false });
    const result = stripAnsi(headerBar(state, 100));
    expect(result).toContain('⚠1');
  });
});

describe('notificationBar', () => {
  test('returns blank line when no notifications or toasts', () => {
    const state = createInitialState();
    const result = notificationBar(state, 80);
    expect(result.trim()).toBe('');
    expect(result.length).toBe(80);
  });

  test('renders toast when active', () => {
    const state = createInitialState();
    pushToast(state, 'Approved task-abc12', 'success');
    const result = stripAnsi(notificationBar(state, 80));
    expect(result).toContain('Approved task-abc12');
  });

  test('renders notification with approve/reject actions', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', taskId: 'task-abc', message: '"Deploy" risk=0.87', priority: 1, timestamp: Date.now(), dismissed: false });
    const result = stripAnsi(notificationBar(state, 100));
    expect(result).toContain('task-abc');
    expect(result).toContain('[a]pprove');
    expect(result).toContain('[r]eject');
  });

  test('shows counter for multiple notifications', () => {
    const state = createInitialState();
    pushNotification(state, { type: 'approval', message: 'a', priority: 1, timestamp: Date.now(), dismissed: false });
    pushNotification(state, { type: 'circuit', message: 'b', priority: 3, timestamp: Date.now(), dismissed: false });
    const result = stripAnsi(notificationBar(state, 100));
    expect(result).toContain('(1/2)');
  });
});

describe('contextHintsBar', () => {
  test('renders mode and hints', () => {
    const hints = [{ key: 'j/k', label: 'nav' }, { key: 'Enter', label: 'select' }];
    const result = stripAnsi(contextHintsBar('normal', hints, 80));
    expect(result).toContain('NORMAL');
    expect(result).toContain('j/k:nav');
    expect(result).toContain('Enter:select');
  });
});

describe('tabBarWithBadges', () => {
  test('renders badges on tabs', () => {
    const tabs = [
      { key: '1', label: 'Tasks', tab: 'tasks' as const },
      { key: '2', label: 'System', tab: 'system' as const },
    ];
    const badges = { tasks: { count: 3 }, system: { count: 0 } };
    const result = stripAnsi(tabBarWithBadges(tabs, 'tasks', badges, 80));
    expect(result).toContain('Tasks(3)');
  });
});

describe('terminalSizeGuard', () => {
  test('returns null when size is adequate', () => {
    expect(terminalSizeGuard(80, 24)).toBeNull();
    expect(terminalSizeGuard(120, 40)).toBeNull();
  });

  test('returns message when too small', () => {
    const result = terminalSizeGuard(60, 18);
    expect(result).not.toBeNull();
    expect(result).toContain('Terminal too small');
    expect(result).toContain('60');
    expect(result).toContain('18');
  });
});
