/**
 * Remote Bus Adapter tests — Phase L3.
 */
import { describe, test, expect } from "bun:test";
import { RemoteBusAdapter, DEFAULT_FORWARDED_EVENTS } from "../../src/a2a/remote-bus.ts";
import { EventBus, type VinyanBusEvents } from "../../src/core/bus.ts";
import { ECP_MIME_TYPE } from "../../src/a2a/ecp-data-part.ts";

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

describe("RemoteBusAdapter", () => {
  test("subscribes to default forwarded events on start", () => {
    const bus = makeBus();
    const adapter = new RemoteBusAdapter({
      bus,
      peerUrls: [],
      instanceId: "inst-001",
    });

    adapter.start();
    const forwarded = adapter.getForwardedEvents();
    expect(forwarded).toEqual(DEFAULT_FORWARDED_EVENTS);
    adapter.stop();
  });

  test("forwards event to peer URL on emit", async () => {
    const bus = makeBus();
    const received: any[] = [];

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        received.push(body);
        return Response.json({ jsonrpc: "2.0", id: (body as any).id, result: {} });
      },
    });

    try {
      const adapter = new RemoteBusAdapter({
        bus,
        peerUrls: [`http://localhost:${server.port}`],
        instanceId: "inst-001",
      });

      adapter.start();
      bus.emit("file:hashChanged", { filePath: "/src/app.ts", newHash: "abc" });

      await new Promise(resolve => setTimeout(resolve, 300));

      expect(received).toHaveLength(1);
      const body = received[0];
      expect(body.method).toBe("tasks/send");
      const data = body.params.message.parts[0].data;
      expect(data.message_type).toBe("knowledge_transfer");
      expect(data.payload.bus_event).toBe("file:hashChanged");
      expect(data.payload.data.filePath).toBe("/src/app.ts");

      adapter.stop();
    } finally {
      server.stop(true);
    }
  });

  test("does not forward non-configured events", async () => {
    const bus = makeBus();
    let requestCount = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        const body = await req.json();
        return Response.json({ jsonrpc: "2.0", id: (body as any).id, result: {} });
      },
    });

    try {
      const adapter = new RemoteBusAdapter({
        bus,
        peerUrls: [`http://localhost:${server.port}`],
        instanceId: "inst-001",
      });

      adapter.start();
      // task:start is NOT in default forwarded events
      bus.emit("task:start", { input: {} as any, routing: {} as any });

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(requestCount).toBe(0);
      adapter.stop();
    } finally {
      server.stop(true);
    }
  });

  test("stop unsubscribes — subsequent events not forwarded", async () => {
    const bus = makeBus();
    let requestCount = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requestCount++;
        const body = await req.json();
        return Response.json({ jsonrpc: "2.0", id: (body as any).id, result: {} });
      },
    });

    try {
      const adapter = new RemoteBusAdapter({
        bus,
        peerUrls: [`http://localhost:${server.port}`],
        instanceId: "inst-001",
      });

      adapter.start();
      adapter.stop();

      bus.emit("file:hashChanged", { filePath: "/src/test.ts", newHash: "xyz" });
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(requestCount).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("custom forwardedEvents override defaults", () => {
    const bus = makeBus();
    const adapter = new RemoteBusAdapter({
      bus,
      peerUrls: [],
      instanceId: "inst-001",
      forwardedEvents: ["oracle:verdict", "circuit:open"],
    });

    adapter.start();
    const forwarded = adapter.getForwardedEvents();
    expect(forwarded).toEqual(["oracle:verdict", "circuit:open"]);
    adapter.stop();
  });

  test("failure to one peer does not block others", async () => {
    const bus = makeBus();
    let successCount = 0;

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        successCount++;
        const body = await req.json();
        return Response.json({ jsonrpc: "2.0", id: (body as any).id, result: {} });
      },
    });

    try {
      const adapter = new RemoteBusAdapter({
        bus,
        peerUrls: [
          "http://localhost:19992", // unreachable
          `http://localhost:${server.port}`,
        ],
        instanceId: "inst-001",
      });

      adapter.start();
      bus.emit("file:hashChanged", { filePath: "/src/x.ts", newHash: "abc" });

      await new Promise(resolve => setTimeout(resolve, 500));

      expect(successCount).toBe(1);
      adapter.stop();
    } finally {
      server.stop(true);
    }
  });
});
