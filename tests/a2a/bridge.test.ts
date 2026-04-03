/**
 * A2A Bridge Tests — PH5.6.
 *
 * Validates JSON-RPC handling, TaskInput mapping, confidence capping.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createA2AManager } from '../../src/a2a/a2a-manager.ts';
import { A2ABridge } from '../../src/a2a/bridge.ts';
import { ECP_MIME_TYPE } from '../../src/a2a/ecp-data-part.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { PEER_TRUST_CAPS } from '../../src/oracle/tier-clamp.ts';
import type { TaskInput, TaskResult } from '../../src/orchestrator/types.ts';

function makeBridge(executeTask?: (input: TaskInput) => Promise<TaskResult>): A2ABridge {
  return new A2ABridge({
    executeTask: executeTask ?? mockExecuteTask,
    baseUrl: 'http://localhost:3000',
  });
}

function mockExecuteTask(input: TaskInput): Promise<TaskResult> {
  return Promise.resolve({
    id: input.id,
    status: 'completed',
    mutations: [
      {
        file: 'src/test.ts',
        diff: '--- a/src/test.ts\n+++ b/src/test.ts\n@@ -1 +1 @@\n-old\n+new',
        oracleVerdicts: {
          'ast-oracle': {
            verified: true,
            type: 'known',
            confidence: 1.0,
            evidence: [],
            fileHashes: { 'src/test.ts': 'abc123' },
            durationMs: 50,
          },
        },
      },
    ],
    trace: {
      id: `trace-${input.id}`,
      taskId: input.id,
      timestamp: Date.now(),
      routingLevel: 1,
      approach: 'test',
      oracleVerdicts: { 'ast-oracle': true },
      modelUsed: 'mock/test',
      tokensConsumed: 100,
      durationMs: 50,
      outcome: 'success',
      affectedFiles: ['src/test.ts'],
    },
  });
}

function makeJsonRpcRequest(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 'req-1',
    method,
    params,
  };
}

describe('A2ABridge', () => {
  describe('tasks/send', () => {
    test("creates TaskInput with source 'a2a'", async () => {
      let capturedInput: TaskInput | null = null;
      const bridge = makeBridge(async (input) => {
        capturedInput = input;
        return mockExecuteTask(input);
      });

      await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [{ text: 'Fix the bug' }] },
        }),
      );

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.source).toBe('a2a');
    });

    test('maps message parts to goal', async () => {
      let capturedInput: TaskInput | null = null;
      const bridge = makeBridge(async (input) => {
        capturedInput = input;
        return mockExecuteTask(input);
      });

      await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [{ text: 'Fix the bug' }, { text: 'in auth module' }] },
        }),
      );

      expect(capturedInput!.goal).toBe('Fix the bug\nin auth module');
    });

    test('returns A2A Task with completed status', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [{ text: 'Do something' }] },
        }),
      );

      expect(response.error).toBeUndefined();
      const task = response.result as { id: string; status: { state: string } };
      expect(task.status.state).toBe('completed');
    });

    test('returns A2A Task with failed status on execution failure', async () => {
      const bridge = makeBridge(async () => {
        throw new Error('Task execution failed');
      });

      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [{ text: 'Fail' }] },
        }),
      );

      expect(response.error).toBeUndefined(); // JSON-RPC success, but task failed
      const task = response.result as { status: { state: string } };
      expect(task.status.state).toBe('failed');
    });

    test('returns error when message has no text parts', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [] },
        }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    test('uses provided task ID from params', async () => {
      let capturedInput: TaskInput | null = null;
      const bridge = makeBridge(async (input) => {
        capturedInput = input;
        return mockExecuteTask(input);
      });

      await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          id: 'custom-task-id',
          message: { parts: [{ text: 'test' }] },
        }),
      );

      expect(capturedInput!.id).toBe('custom-task-id');
    });

    test('all result verdicts have confidence <= 0.5 (I13)', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          message: { parts: [{ text: 'verify' }] },
        }),
      );

      const task = response.result as { artifacts?: Array<{ parts: Array<{ data?: Record<string, unknown> }> }> };
      expect(task.artifacts).toBeDefined();

      // Find artifacts with oracle verdicts data
      for (const artifact of task.artifacts ?? []) {
        for (const part of artifact.parts) {
          if (part.data?.oracleVerdicts) {
            const verdicts = part.data.oracleVerdicts as Record<string, { confidence: number }>;
            for (const [, verdict] of Object.entries(verdicts)) {
              expect(verdict.confidence).toBeLessThanOrEqual(PEER_TRUST_CAPS.untrusted);
            }
          }
        }
      }
    });
  });

  describe('tasks/get', () => {
    test('returns task status after send', async () => {
      const bridge = makeBridge();

      // First send a task
      await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          id: 'get-test-task',
          message: { parts: [{ text: 'do work' }] },
        }),
      );

      // Then get its status
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/get', {
          id: 'get-test-task',
        }),
      );

      expect(response.error).toBeUndefined();
      const task = response.result as { id: string; status: { state: string } };
      expect(task.id).toBe('get-test-task');
      expect(task.status.state).toBe('completed');
    });

    test('returns error for unknown task', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/get', {
          id: 'nonexistent',
        }),
      );

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });
  });

  describe('tasks/cancel', () => {
    test('returns cancelled status', async () => {
      const bridge = makeBridge();

      // Send first
      await bridge.handleRequest(
        makeJsonRpcRequest('tasks/send', {
          id: 'cancel-test-task',
          message: { parts: [{ text: 'long task' }] },
        }),
      );

      // Then cancel
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/cancel', {
          id: 'cancel-test-task',
        }),
      );

      expect(response.error).toBeUndefined();
      const task = response.result as { status: { state: string } };
      expect(task.status.state).toBe('canceled');
    });

    test('returns error for unknown task', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest(
        makeJsonRpcRequest('tasks/cancel', {
          id: 'nonexistent',
        }),
      );

      expect(response.error).toBeDefined();
    });
  });

  describe('invalid requests', () => {
    test('invalid JSON-RPC request returns error', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest({ bad: 'request' });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });

    test('missing jsonrpc version returns error', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest({
        id: '1',
        method: 'tasks/send',
        params: {},
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });

    test('invalid method returns error', async () => {
      const bridge = makeBridge();
      const response = await bridge.handleRequest({
        jsonrpc: '2.0',
        id: '1',
        method: 'tasks/unknown',
        params: {},
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });
  });

  describe('getAgentCard', () => {
    test('returns agent card object', () => {
      const bridge = makeBridge();
      const card = bridge.getAgentCard() as { name: string; url: string };
      expect(card.name).toBe('Vinyan');
      expect(card.url).toBe('http://localhost:3000');
    });
  });
});

// ── ECP Routing Tests (A2AManager integration) ──────────────────────

const ECP_TEST_WORKSPACE = join(import.meta.dir, '../../.test-workspace-bridge');

function makeECPRequest(messageType: string, payload: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 'req-ecp',
    method: 'tasks/send' as const,
    params: {
      message: {
        parts: [
          {
            type: 'data',
            mimeType: ECP_MIME_TYPE,
            data: {
              ecp_version: 1,
              message_type: messageType,
              epistemic_type: 'known',
              confidence: 1,
              confidence_reported: true,
              payload,
            },
          },
        ],
      },
    },
  };
}

describe('A2ABridge — ECP routing', () => {
  beforeEach(() => {
    if (!existsSync(ECP_TEST_WORKSPACE)) {
      mkdirSync(join(ECP_TEST_WORKSPACE, '.vinyan'), { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(ECP_TEST_WORKSPACE)) {
      rmSync(ECP_TEST_WORKSPACE, { recursive: true, force: true });
    }
  });

  test('ECP heartbeat dispatched to a2aManager, executeTask NOT called', async () => {
    let executeTaskCalled = false;
    const mgr = createA2AManager({
      workspace: ECP_TEST_WORKSPACE,
      bus: new EventBus<VinyanBusEvents>(),
      network: {
        instances: { enabled: false, peers: [], listen_port: 3928, heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000 },
      },
    });

    const bridge = new A2ABridge({
      executeTask: async (input) => {
        executeTaskCalled = true;
        return mockExecuteTask(input);
      },
      baseUrl: 'http://localhost:3000',
      a2aManager: mgr,
    });

    const response = await bridge.handleRequest(makeECPRequest('heartbeat'));
    expect(response.error).toBeUndefined();
    const task = response.result as { status: { state: string } };
    expect(task.status.state).toBe('completed');
    expect(executeTaskCalled).toBe(false);
  });

  test('ECP retract dispatched to a2aManager', async () => {
    let executeTaskCalled = false;
    const mgr = createA2AManager({
      workspace: ECP_TEST_WORKSPACE,
      bus: new EventBus<VinyanBusEvents>(),
      network: {
        instances: { enabled: false, peers: [], listen_port: 3928, heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000 },
      },
    });

    const bridge = new A2ABridge({
      executeTask: async (input) => {
        executeTaskCalled = true;
        return mockExecuteTask(input);
      },
      baseUrl: 'http://localhost:3000',
      a2aManager: mgr,
    });

    const retraction = {
      retraction_id: 'ret-bridge-001',
      target_type: 'verdict',
      target_id: 'v-bridge-001',
      severity: 'advisory',
      reason: 'manual',
      timestamp: Date.now(),
      peer_id: 'peer-A',
    };

    const response = await bridge.handleRequest(makeECPRequest('retract', retraction));
    expect(response.error).toBeUndefined();
    expect(executeTaskCalled).toBe(false);
    expect(mgr.retractionManager.isRetracted('v-bridge-001')).toBe(true);
  });

  test('plain text message falls through to executeTask (backward compat)', async () => {
    let executeTaskCalled = false;
    const mgr = createA2AManager({
      workspace: ECP_TEST_WORKSPACE,
      bus: new EventBus<VinyanBusEvents>(),
      network: {
        instances: { enabled: false, peers: [], listen_port: 3928, heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000 },
      },
    });

    const bridge = new A2ABridge({
      executeTask: async (input) => {
        executeTaskCalled = true;
        return mockExecuteTask(input);
      },
      baseUrl: 'http://localhost:3000',
      a2aManager: mgr,
    });

    const response = await bridge.handleRequest(
      makeJsonRpcRequest('tasks/send', {
        message: { parts: [{ text: 'Fix the bug' }] },
      }),
    );

    expect(executeTaskCalled).toBe(true);
    expect(response.error).toBeUndefined();
  });

  test('works without a2aManager (backward compat)', async () => {
    const bridge = makeBridge();
    const response = await bridge.handleRequest(
      makeJsonRpcRequest('tasks/send', {
        message: { parts: [{ text: 'test' }] },
      }),
    );

    expect(response.error).toBeUndefined();
    const task = response.result as { status: { state: string } };
    expect(task.status.state).toBe('completed');
  });

  test('agent card includes x-vinyan-ecp when a2aManager present', () => {
    const mgr = createA2AManager({
      workspace: ECP_TEST_WORKSPACE,
      bus: new EventBus<VinyanBusEvents>(),
      network: {
        instances: { enabled: false, peers: [], listen_port: 3928, heartbeat_interval_ms: 15000, heartbeat_timeout_ms: 45000 },
      },
    });

    const bridge = new A2ABridge({
      executeTask: mockExecuteTask,
      baseUrl: 'http://localhost:3000',
      a2aManager: mgr,
    });

    const card = bridge.getAgentCard() as { 'x-vinyan-ecp'?: { protocol: string; instance_id: string } };
    expect(card['x-vinyan-ecp']).toBeDefined();
    expect(card['x-vinyan-ecp']!.protocol).toBe('vinyan-ecp');
    expect(card['x-vinyan-ecp']!.instance_id).toBe(mgr.identity.instanceId);
  });
});
