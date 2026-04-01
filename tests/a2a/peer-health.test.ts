/**
 * Peer Health Monitor tests — Phase L1.
 */
import { describe, test, expect } from "bun:test";
import { PeerHealthMonitor, type PeerHealthState } from "../../src/a2a/peer-health.ts";
import { EventBus, type VinyanBusEvents } from "../../src/core/bus.ts";

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    heartbeatIntervalMs: 60_000, // large — we call runHeartbeatCycle manually
    heartbeatTimeoutMs: 1000,
    instanceId: "inst-local",
    ...overrides,
  };
}

describe("PeerHealthMonitor — addPeer / removePeer", () => {
  test("addPeer initializes as connected with zero misses", () => {
    const monitor = new PeerHealthMonitor(makeConfig());
    monitor.addPeer("peer-a", "http://peer-a:3928");

    expect(monitor.getState("peer-a")).toBe("connected");
    const states = monitor.getAllStates();
    expect(states).toHaveLength(1);
    expect(states[0]!.consecutiveMisses).toBe(0);
  });

  test("removePeer stops tracking the peer", () => {
    const monitor = new PeerHealthMonitor(makeConfig());
    monitor.addPeer("peer-a", "http://peer-a:3928");
    monitor.removePeer("peer-a");

    expect(monitor.getAllStates()).toHaveLength(0);
  });

  test("getState returns partitioned for unknown peer", () => {
    const monitor = new PeerHealthMonitor(makeConfig());
    expect(monitor.getState("nonexistent")).toBe("partitioned");
  });
});

describe("PeerHealthMonitor — heartbeat cycle", () => {
  test("successful heartbeat keeps connected state", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as any;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });

    try {
      const monitor = new PeerHealthMonitor(makeConfig());
      monitor.addPeer("peer-a", `http://localhost:${server.port}`);

      await monitor.runHeartbeatCycle();

      expect(monitor.getState("peer-a")).toBe("connected");
      const record = monitor.getAllStates()[0]!;
      expect(record.consecutiveMisses).toBe(0);
      expect(record.latency_ms).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop(true);
    }
  });

  test("failed heartbeat transitions connected → degraded", async () => {
    const monitor = new PeerHealthMonitor(makeConfig({
      heartbeatTimeoutMs: 200,
    }));
    monitor.addPeer("peer-a", "http://localhost:19993"); // unreachable

    await monitor.runHeartbeatCycle();
    expect(monitor.getState("peer-a")).toBe("degraded");
  });

  test("3 failed heartbeats transitions to partitioned", async () => {
    const monitor = new PeerHealthMonitor(makeConfig({
      heartbeatTimeoutMs: 200,
      partitionedAfterMisses: 3,
    }));
    monitor.addPeer("peer-a", "http://localhost:19993");

    await monitor.runHeartbeatCycle(); // miss 1 → degraded
    expect(monitor.getState("peer-a")).toBe("degraded");

    await monitor.runHeartbeatCycle(); // miss 2 → still degraded
    expect(monitor.getState("peer-a")).toBe("degraded");

    await monitor.runHeartbeatCycle(); // miss 3 → partitioned
    expect(monitor.getState("peer-a")).toBe("partitioned");
  });

  test("successful heartbeat recovers from degraded", async () => {
    const monitor = new PeerHealthMonitor(makeConfig({
      heartbeatTimeoutMs: 200,
    }));
    monitor.addPeer("peer-a", "http://localhost:19993"); // unreachable initially

    // Degrade
    await monitor.runHeartbeatCycle();
    expect(monitor.getState("peer-a")).toBe("degraded");

    // Now point to a reachable server
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as any;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });

    try {
      // Update peer URL (re-add)
      monitor.removePeer("peer-a");
      monitor.addPeer("peer-a", `http://localhost:${server.port}`);
      // Manually set state to degraded to simulate recovery
      const record = monitor.getAllStates()[0]!;
      (record as any).state = "degraded";
      (record as any).consecutiveMisses = 1;

      await monitor.runHeartbeatCycle();
      expect(monitor.getState("peer-a")).toBe("connected");
    } finally {
      server.stop(true);
    }
  });

  test("successful heartbeat recovers from partitioned", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as any;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });

    try {
      const monitor = new PeerHealthMonitor(makeConfig());
      monitor.addPeer("peer-a", `http://localhost:${server.port}`);

      // Manually set to partitioned
      const record = monitor.getAllStates()[0]!;
      (record as any).state = "partitioned";
      (record as any).consecutiveMisses = 5;

      await monitor.runHeartbeatCycle();
      expect(monitor.getState("peer-a")).toBe("connected");
      expect(monitor.getAllStates()[0]!.consecutiveMisses).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});

describe("PeerHealthMonitor — bus events", () => {
  test("emits peer:disconnected on partition", async () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on("peer:disconnected", (e) => events.push(e));

    const monitor = new PeerHealthMonitor(
      makeConfig({ heartbeatTimeoutMs: 200, partitionedAfterMisses: 1 }),
      bus,
    );
    monitor.addPeer("peer-a", "http://localhost:19993");

    await monitor.runHeartbeatCycle();
    // With partitionedAfterMisses: 1, first miss goes to partitioned
    // but degradedAfterMisses defaults to 1 which also triggers.
    // Let's check: miss 1 >= partitionedAfterMisses(1) → partitioned
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].peerId).toBe("peer-a");
    expect(events[0].reason).toContain("heartbeat");
  });

  test("emits peer:connected on recovery", async () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on("peer:connected", (e) => events.push(e));

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as any;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });

    try {
      const monitor = new PeerHealthMonitor(makeConfig(), bus);
      monitor.addPeer("peer-a", `http://localhost:${server.port}`);

      // Manually set to partitioned
      const record = monitor.getAllStates()[0]!;
      (record as any).state = "partitioned";
      (record as any).consecutiveMisses = 3;

      await monitor.runHeartbeatCycle();
      expect(events).toHaveLength(1);
      expect(events[0].peerId).toBe("peer-a");
    } finally {
      server.stop(true);
    }
  });
});

describe("PeerHealthMonitor — start/stop", () => {
  test("start and stop manage interval timer", () => {
    const monitor = new PeerHealthMonitor(makeConfig());
    monitor.start();
    monitor.stop();
    // Double stop should not throw
    monitor.stop();
  });
});
