import { describe, expect, test } from 'bun:test';
import {
  bold,
  color,
  dim,
  formatDuration,
  formatTimeShort,
  formatTimestamp,
  gateDot,
  gauge,
  padEnd,
  panel,
  sparkline,
  statusBadge,
  stripAnsi,
  tabBar,
  truncate,
  visibleLength,
} from '../../src/tui/renderer.ts';

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
