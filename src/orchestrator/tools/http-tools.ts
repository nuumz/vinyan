/**
 * HTTP tools — http_get.
 */

import type { Tool, ToolDescriptor } from './tool-interface.ts';
import { makeResult } from './built-in-tools.ts';

const HTTP_GET_TIMEOUT_MS = 10_000;
const HTTP_GET_MAX_BYTES = 50 * 1024; // 50KB

export const httpGet: Tool = {
  name: 'http_get',
  description: 'HTTP GET with 10s timeout and 50KB response limit (no auth headers)',
  minIsolationLevel: 1,
  category: 'shell',
  sideEffect: false,
  descriptor(): ToolDescriptor {
    return {
      name: 'http_get',
      description: this.description,
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
      category: 'shell',
      sideEffect: false,
      minRoutingLevel: 2,
      toolKind: 'executable',
    };
  },
  async execute(params, _context) {
    const url = params.url as string;
    if (!url) {
      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: 'error',
        error: 'url is required',
      });
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_GET_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'vinyan-agent/1.0' },
      });
      clearTimeout(timer);

      const buffer = await response.arrayBuffer();
      let body = new TextDecoder().decode(buffer.slice(0, HTTP_GET_MAX_BYTES));
      const truncated = buffer.byteLength > HTTP_GET_MAX_BYTES;
      if (truncated) {
        body += `\n... [truncated at ${HTTP_GET_MAX_BYTES} bytes, total: ${buffer.byteLength}]`;
      }

      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: response.ok ? 'success' : 'error',
        output: body,
        error: response.ok ? undefined : `HTTP ${response.status} ${response.statusText}`,
      });
    } catch (e) {
      return makeResult((params.callId as string) ?? '', 'http_get', {
        status: 'error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
};
