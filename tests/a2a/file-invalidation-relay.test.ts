/**
 * File Invalidation Relay tests — Phase E1.
 */
import { describe, expect, test } from 'bun:test';
import { ECP_MIME_TYPE } from '../../src/a2a/ecp-data-part.ts';
import { FileInvalidationRelay } from '../../src/a2a/file-invalidation-relay.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

describe('FileInvalidationRelay', () => {
  test('subscribes to file:hashChanged on start', () => {
    const bus = makeBus();
    const relay = new FileInvalidationRelay({
      bus,
      peerUrls: [],
      instanceId: 'inst-001',
    });

    relay.start();
    // Emitting should not throw (handler is active)
    bus.emit('file:hashChanged', { filePath: '/src/test.ts', newHash: 'abc' });
    relay.stop();
  });

  test('sends A2A tasks/send to each peer URL on file:hashChanged', async () => {
    const bus = makeBus();
    const received: { url: string; body: any }[] = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, any>;
        received.push({ url: req.url, body });
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    });

    try {
      const relay = new FileInvalidationRelay({
        bus,
        peerUrls: [`http://localhost:${server.port}`],
        instanceId: 'inst-001',
      });

      relay.start();
      bus.emit('file:hashChanged', { filePath: '/src/app.ts', newHash: 'sha256:new' });

      // Wait for async fire-and-forget
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(received).toHaveLength(1);
      const body = received[0]!.body;
      expect(body.method).toBe('tasks/send');
      const parts = body.params.message.parts;
      expect(parts[0].mimeType).toBe(ECP_MIME_TYPE);
      expect(parts[0].data.message_type).toBe('knowledge_transfer');
      expect(parts[0].data.payload.filePath).toBe('/src/app.ts');
      expect(parts[0].data.payload.newHash).toBe('sha256:new');

      relay.stop();
    } finally {
      server.stop(true);
    }
  });

  test('does not send after stop', async () => {
    const bus = makeBus();
    let requestCount = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        const body = (await req.json()) as Record<string, any>;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    });

    try {
      const relay = new FileInvalidationRelay({
        bus,
        peerUrls: [`http://localhost:${server.port}`],
        instanceId: 'inst-001',
      });

      relay.start();
      relay.stop();

      bus.emit('file:hashChanged', { filePath: '/src/x.ts', newHash: 'abc' });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(requestCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test('failure to one peer does not prevent sending to others', async () => {
    const bus = makeBus();
    let successCount = 0;

    const goodServer = Bun.serve({
      port: 0,
      async fetch(req) {
        successCount++;
        const body = (await req.json()) as Record<string, any>;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      },
    });

    try {
      const relay = new FileInvalidationRelay({
        bus,
        peerUrls: [
          'http://localhost:19994', // unreachable
          `http://localhost:${goodServer.port}`,
        ],
        instanceId: 'inst-001',
      });

      relay.start();
      bus.emit('file:hashChanged', { filePath: '/src/y.ts', newHash: 'def' });
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(successCount).toBe(1);
      relay.stop();
    } finally {
      goodServer.stop(true);
    }
  });

  test('buildECPDataPart creates valid structure', () => {
    const bus = makeBus();
    const relay = new FileInvalidationRelay({
      bus,
      peerUrls: [],
      instanceId: 'inst-001',
    });

    const part = relay.buildECPDataPart('/src/test.ts', 'sha256:abc');
    expect(part.ecp_version).toBe(1);
    expect(part.message_type).toBe('knowledge_transfer');
    expect(part.epistemic_type).toBe('known');
    expect(part.confidence).toBe(1.0);
    expect((part.payload as any).filePath).toBe('/src/test.ts');
    expect((part.payload as any).newHash).toBe('sha256:abc');
  });
});
