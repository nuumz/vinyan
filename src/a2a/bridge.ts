/**
 * A2A Protocol Bridge — PH5.6.
 *
 * Maps A2A JSON-RPC requests to Vinyan TaskInput → executeTask → A2A artifacts.
 *
 * Design constraints:
 * - I12: No remote governance bypass — A2A tasks go through normal routing
 * - I13: Remote verdict confidence ceiling at 0.5
 * - A5: Tiered trust — remote = "uncertain" (lowest tier)
 */
import type { TaskInput, TaskResult } from "../orchestrator/types.ts";
import { A2AJsonRpcRequestSchema } from "./types.ts";
import type { A2ATask, A2AJsonRpcResponse } from "./types.ts";
import { injectA2AConfidence } from "./confidence-injector.ts";
import { generateAgentCard } from "./agent-card.ts";

export interface A2ABridgeDeps {
  executeTask: (input: TaskInput) => Promise<TaskResult>;
  baseUrl: string;
}

export class A2ABridge {
  /** In-memory task tracking (tasks/get support) */
  private tasks = new Map<string, A2ATask>();

  constructor(private deps: A2ABridgeDeps) {}

  /** Handle incoming A2A JSON-RPC request */
  async handleRequest(request: unknown): Promise<A2AJsonRpcResponse> {
    const parsed = A2AJsonRpcRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        jsonrpc: "2.0",
        id: (request as Record<string, unknown>)?.id as string | number ?? 0,
        error: {
          code: -32600,
          message: "Invalid Request",
          data: parsed.error.issues,
        },
      };
    }

    const { id, method, params } = parsed.data;

    switch (method) {
      case "tasks/send":
        return this.handleTaskSend(id, params);
      case "tasks/get":
        return this.handleTaskGet(id, params);
      case "tasks/cancel":
        return this.handleTaskCancel(id, params);
    }
  }

  /** Map A2A tasks/send to Vinyan TaskInput, execute, return A2A Task artifact */
  private async handleTaskSend(
    id: string | number,
    params: Record<string, unknown>,
  ): Promise<A2AJsonRpcResponse> {
    // Extract goal from A2A message parts
    const message = params.message as { parts?: Array<{ text?: string }> } | undefined;
    const goal = message?.parts
      ?.map((p) => p.text)
      .filter(Boolean)
      .join("\n") ?? "";

    if (!goal) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid params: message must contain at least one text part",
        },
      };
    }

    const taskId = params.id as string ?? crypto.randomUUID();

    // Build TaskInput with source: "a2a" — I12: goes through normal routing
    const taskInput: TaskInput = {
      id: taskId,
      source: "a2a",
      goal,
      budget: {
        maxTokens: 50_000,
        maxDurationMs: 60_000,
        maxRetries: 3,
      },
    };

    // Mark as working
    this.tasks.set(taskId, {
      id: taskId,
      status: { state: "working" },
    });

    try {
      const result = await this.deps.executeTask(taskInput);
      const a2aTask = this.mapResultToA2ATask(taskId, result);
      this.tasks.set(taskId, a2aTask);

      return {
        jsonrpc: "2.0",
        id,
        result: a2aTask,
      };
    } catch (err) {
      const failedTask: A2ATask = {
        id: taskId,
        status: {
          state: "failed",
          message: {
            role: "agent",
            parts: [{ type: "text", text: String(err) }],
          },
        },
      };
      this.tasks.set(taskId, failedTask);

      return {
        jsonrpc: "2.0",
        id,
        result: failedTask,
      };
    }
  }

  /** Return stored task status */
  private handleTaskGet(
    id: string | number,
    params: Record<string, unknown>,
  ): A2AJsonRpcResponse {
    const taskId = params.id as string;
    const task = this.tasks.get(taskId);

    if (!task) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Task not found: ${taskId}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      result: task,
    };
  }

  /** Cancel a running task */
  private handleTaskCancel(
    id: string | number,
    params: Record<string, unknown>,
  ): A2AJsonRpcResponse {
    const taskId = params.id as string;
    const task = this.tasks.get(taskId);

    if (!task) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Task not found: ${taskId}`,
        },
      };
    }

    const cancelledTask: A2ATask = {
      id: taskId,
      status: { state: "canceled" },
    };
    this.tasks.set(taskId, cancelledTask);

    return {
      jsonrpc: "2.0",
      id,
      result: cancelledTask,
    };
  }

  /** Serve /.well-known/agent.json */
  getAgentCard(): unknown {
    return generateAgentCard(this.deps.baseUrl);
  }

  /** Map Vinyan TaskResult to A2A Task with artifacts, applying confidence cap */
  private mapResultToA2ATask(taskId: string, result: TaskResult): A2ATask {
    const state = result.status === "completed" ? "completed" : "failed";

    // Build artifacts from mutations — apply I13 confidence cap on verdicts
    const artifacts = result.mutations.map((m) => {
      // Cap confidence on all oracle verdicts (I13)
      const cappedVerdicts: Record<string, unknown> = {};
      for (const [name, verdict] of Object.entries(m.oracleVerdicts)) {
        cappedVerdicts[name] = injectA2AConfidence(verdict);
      }

      return {
        name: m.file,
        description: `Mutation for ${m.file}`,
        parts: [
          { type: "text" as const, text: m.diff },
          { type: "data" as const, data: { oracleVerdicts: cappedVerdicts } },
        ],
      };
    });

    // Add summary artifact
    const summaryParts: Array<{ type: "text"; text: string }> = [
      {
        type: "text",
        text: `Task ${result.status}. ${result.mutations.length} mutation(s).`,
      },
    ];

    if (result.escalationReason) {
      summaryParts.push({ type: "text", text: `Escalation: ${result.escalationReason}` });
    }

    return {
      id: taskId,
      status: {
        state,
        message: {
          role: "agent",
          parts: summaryParts,
        },
      },
      artifacts: [
        {
          name: "summary",
          description: "Task execution summary",
          parts: summaryParts,
        },
        ...artifacts,
      ],
    };
  }
}
