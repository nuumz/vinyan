/**
 * Vinyan API Client — thin HTTP client for the Vinyan API server.
 *
 * A3: Read-only projection, no governance bypass.
 * A6: Extension proposes; Orchestrator disposes.
 */
import * as vscode from 'vscode';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface SSEEvent {
  event: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface TaskSubmission {
  goal: string;
  targetFiles?: string[];
}

export interface TaskInfo {
  id: string;
  goal: string;
  status: string;
  routingLevel?: number;
  durationMs?: number;
  createdAt?: number;
}

export interface HealthInfo {
  status: string;
  uptime_ms: number;
}

export interface FactInfo {
  target: string;
  pattern: string;
  confidence: number;
  contentHash?: string;
  lastVerified?: number;
}

export type ConnectionState = 'connected' | 'disconnected' | 'connecting';

export class VinyanClient {
  private baseUrl: string;
  private token: string | undefined;
  private sseController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connectionState: ConnectionState = 'disconnected';

  private readonly _onConnectionChange = new vscode.EventEmitter<ConnectionState>();
  readonly onConnectionChange = this._onConnectionChange.event;

  private readonly _onSSEEvent = new vscode.EventEmitter<SSEEvent>();
  readonly onSSEEvent = this._onSSEEvent.event;

  constructor() {
    this.baseUrl = vscode.workspace.getConfiguration('vinyan').get('serverUrl', 'http://127.0.0.1:3927');
    this.token = this.loadToken();
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this._onConnectionChange.fire(state);
    }
  }

  private loadToken(): string | undefined {
    const tokenPath = join(homedir(), '.vinyan', 'api-token');
    if (existsSync(tokenPath)) {
      try {
        return readFileSync(tokenPath, 'utf-8').trim();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const url = `${this.baseUrl}${path}`;
      const opts: RequestInit = {
        method,
        headers: this.headers(),
        signal: controller.signal,
      };
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }

      const res = await fetch(url, opts);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      this.setConnectionState('connected');
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        this.setConnectionState('disconnected');
        throw new Error('Request timed out');
      }
      if (err instanceof TypeError && err.message.includes('fetch')) {
        this.setConnectionState('disconnected');
        throw new Error('Connection refused — is the Vinyan server running?');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getHealth(): Promise<HealthInfo> {
    return this.request<HealthInfo>('GET', '/api/v1/health');
  }

  async getMetrics(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/metrics`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      this.setConnectionState('connected');
      return await res.text();
    } catch {
      this.setConnectionState('disconnected');
      throw new Error('Failed to fetch metrics');
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitTask(goal: string, targetFiles?: string[]): Promise<TaskInfo> {
    const body: TaskSubmission = { goal };
    if (targetFiles?.length) {
      body.targetFiles = targetFiles;
    }
    return this.request<TaskInfo>('POST', '/api/v1/tasks/async', body);
  }

  async getWorkers(): Promise<{ workers: unknown[] }> {
    return this.request('GET', '/api/v1/workers');
  }

  async getFacts(filePath?: string): Promise<{ facts: FactInfo[] }> {
    const query = filePath ? `?file=${encodeURIComponent(filePath)}` : '';
    return this.request('GET', `/api/v1/facts${query}`);
  }

  async getTaskStatus(taskId: string): Promise<TaskInfo> {
    return this.request('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async listTasks(): Promise<{ tasks: TaskInfo[] }> {
    return this.request('GET', '/api/v1/tasks');
  }

  // ── SSE Connection ─────────────────────────────────────

  subscribeEvents(): void {
    if (this.sseController) {
      this.sseController.abort();
    }

    this.sseController = new AbortController();
    this.setConnectionState('connecting');
    this.connectSSE(this.sseController.signal);
  }

  private async connectSSE(signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/events`, {
        headers: this.headers(),
        signal,
      });

      if (!res.ok || !res.body) {
        this.setConnectionState('disconnected');
        this.scheduleReconnect();
        return;
      }

      this.setConnectionState('connected');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const evt = JSON.parse(line.slice(6)) as SSEEvent;
              this._onSSEEvent.fire(evt);
            } catch {
              // Malformed SSE data — skip
            }
          }
        }
      }

      // Stream ended normally
      this.setConnectionState('disconnected');
      this.scheduleReconnect();
    } catch (err) {
      if (signal.aborted) return;
      this.setConnectionState('disconnected');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._connectionState === 'disconnected' && this.sseController && !this.sseController.signal.aborted) {
        this.connectSSE(this.sseController.signal);
      }
    }, 5_000);
  }

  dispose(): void {
    this.sseController?.abort();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this._onConnectionChange.dispose();
    this._onSSEEvent.dispose();
  }
}
