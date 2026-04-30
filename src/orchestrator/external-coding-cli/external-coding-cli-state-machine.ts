/**
 * Session state machine — deterministic transitions (A3).
 *
 * The set of legal transitions is defined as data, not code, so transitions
 * can be enumerated for tests and for replay verification. Forbidden
 * transitions throw — never silently "fix" the state.
 */
import { type CodingCliSessionState, isTerminalState } from './types.ts';

export interface TransitionRecord {
  from: CodingCliSessionState;
  to: CodingCliSessionState;
  ts: number;
  reason?: string;
}

const TRANSITIONS: Record<CodingCliSessionState, ReadonlySet<CodingCliSessionState>> = {
  created: new Set(['starting', 'failed', 'cancelled', 'unsupported-capability']),
  starting: new Set(['ready', 'failed', 'crashed', 'cancelled', 'timed-out']),
  ready: new Set([
    'running',
    'planning',
    'editing',
    'running-command',
    'verifying',
    'waiting-input',
    'waiting-approval',
    'completed',
    'failed',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  running: new Set([
    'planning',
    'editing',
    'running-command',
    'waiting-input',
    'waiting-approval',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
    'ready',
  ]),
  planning: new Set([
    'running',
    'editing',
    'running-command',
    'waiting-input',
    'waiting-approval',
    'verifying',
    'failed',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  editing: new Set([
    'running',
    'planning',
    'running-command',
    'waiting-approval',
    'waiting-input',
    'verifying',
    'failed',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  'running-command': new Set([
    'running',
    'planning',
    'editing',
    'waiting-approval',
    'waiting-input',
    'verifying',
    'failed',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  'waiting-input': new Set([
    'running',
    'planning',
    'editing',
    'running-command',
    'waiting-approval',
    'verifying',
    'cancelled',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  'waiting-approval': new Set([
    'running',
    'planning',
    'editing',
    'running-command',
    'waiting-input',
    'verifying',
    'cancelled',
    'failed',
    'timed-out',
    'crashed',
    'stalled',
  ]),
  verifying: new Set(['completed', 'failed', 'cancelled', 'crashed', 'timed-out']),
  // Terminal states — no outbound edges.
  completed: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
  'timed-out': new Set([]),
  crashed: new Set([]),
  stalled: new Set(['running', 'failed', 'cancelled', 'timed-out', 'crashed']),
  'unsupported-capability': new Set([]),
};

export class StateMachineError extends Error {
  constructor(
    public readonly from: CodingCliSessionState,
    public readonly to: CodingCliSessionState,
    reason?: string,
  ) {
    super(
      `illegal coding-cli state transition: ${from} → ${to}${reason ? ` (${reason})` : ''}`,
    );
    this.name = 'StateMachineError';
  }
}

export class CodingCliStateMachine {
  private current: CodingCliSessionState = 'created';
  private readonly history: TransitionRecord[] = [];

  state(): CodingCliSessionState {
    return this.current;
  }

  /** Returns true if `to` is a legal next state. Does not mutate. */
  canTransition(to: CodingCliSessionState): boolean {
    if (isTerminalState(this.current)) return false;
    return TRANSITIONS[this.current].has(to);
  }

  /** Apply a transition. Throws on illegal moves. */
  transition(to: CodingCliSessionState, reason?: string, now: number = Date.now()): TransitionRecord {
    if (this.current === to) {
      // Idempotent self-transition is allowed for re-entry of stalled→stalled
      // pattern; we do NOT push a duplicate history entry.
      return { from: this.current, to, ts: now, reason };
    }
    if (isTerminalState(this.current)) {
      throw new StateMachineError(this.current, to, 'already terminal');
    }
    if (!TRANSITIONS[this.current].has(to)) {
      throw new StateMachineError(this.current, to, reason);
    }
    const record: TransitionRecord = { from: this.current, to, ts: now, reason };
    this.history.push(record);
    this.current = to;
    return record;
  }

  isTerminal(): boolean {
    return isTerminalState(this.current);
  }

  getHistory(): readonly TransitionRecord[] {
    return this.history;
  }

  /** Build a fresh machine from a list of transitions — used in replay. */
  static fromHistory(events: readonly TransitionRecord[]): CodingCliStateMachine {
    const sm = new CodingCliStateMachine();
    for (const evt of events) {
      sm.transition(evt.to, evt.reason, evt.ts);
    }
    return sm;
  }
}
