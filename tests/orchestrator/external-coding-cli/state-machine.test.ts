import { describe, expect, test } from 'bun:test';
import {
  CodingCliStateMachine,
  StateMachineError,
} from '../../../src/orchestrator/external-coding-cli/external-coding-cli-state-machine.ts';

describe('CodingCliStateMachine', () => {
  test('starts in created and supports created -> starting -> ready -> running', () => {
    const sm = new CodingCliStateMachine();
    expect(sm.state()).toBe('created');
    sm.transition('starting');
    sm.transition('ready');
    sm.transition('running');
    expect(sm.state()).toBe('running');
    expect(sm.getHistory()).toHaveLength(3);
  });

  test('rejects illegal transition from terminal state', () => {
    const sm = new CodingCliStateMachine();
    sm.transition('starting');
    sm.transition('ready');
    sm.transition('completed');
    expect(sm.isTerminal()).toBe(true);
    expect(() => sm.transition('running')).toThrow(StateMachineError);
  });

  test('rejects unknown transition from running', () => {
    const sm = new CodingCliStateMachine();
    sm.transition('starting');
    sm.transition('ready');
    sm.transition('running');
    // running -> created is not allowed
    expect(() => sm.transition('created')).toThrow(StateMachineError);
  });

  test('idempotent self-transition does not push duplicate history', () => {
    const sm = new CodingCliStateMachine();
    sm.transition('starting');
    sm.transition('ready');
    const lengthBefore = sm.getHistory().length;
    sm.transition('ready');
    expect(sm.getHistory().length).toBe(lengthBefore);
  });

  test('canTransition reflects rule set without mutating', () => {
    const sm = new CodingCliStateMachine();
    expect(sm.canTransition('starting')).toBe(true);
    expect(sm.canTransition('completed')).toBe(false); // created → completed not allowed
    expect(sm.state()).toBe('created');
  });

  test('stalled can recover to running', () => {
    const sm = new CodingCliStateMachine();
    sm.transition('starting');
    sm.transition('ready');
    sm.transition('running');
    sm.transition('stalled', 'idle');
    expect(sm.canTransition('running')).toBe(true);
    sm.transition('running', 'recovered');
    expect(sm.state()).toBe('running');
  });

  test('replay from history reproduces state deterministically', () => {
    const sm = new CodingCliStateMachine();
    sm.transition('starting');
    sm.transition('ready');
    sm.transition('running');
    sm.transition('verifying');
    const replayed = CodingCliStateMachine.fromHistory(sm.getHistory());
    expect(replayed.state()).toBe('verifying');
  });
});
