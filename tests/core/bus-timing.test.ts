import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { createBus } from "../../src/core/bus.ts";

describe("EventBus — slow handler warning (WU10)", () => {
  afterEach(() => {
    // Restore any spies after each test
  });

  test("slow handler (>100ms) triggers console.warn", () => {
    const bus = createBus({ maxListeners: 5 });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    bus.on("circuit:open", () => {
      // Busy-spin to force >100ms elapsed without await
      const deadline = Date.now() + 110;
      while (Date.now() < deadline) { /* spin */ }
    });

    bus.emit("circuit:open", { oracleName: "ast", failureCount: 3 });

    const slowWarnings = warnSpy.mock.calls.filter(args =>
      String(args[0]).includes("Slow handler"),
    );
    expect(slowWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  test("fast handler does NOT trigger slow-handler console.warn", () => {
    const bus = createBus({ maxListeners: 5 });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    bus.on("circuit:close", () => { /* instant */ });

    bus.emit("circuit:close", { oracleName: "ast" });

    const slowWarnings = warnSpy.mock.calls.filter(args =>
      String(args[0]).includes("Slow handler"),
    );
    expect(slowWarnings.length).toBe(0);
    warnSpy.mockRestore();
  });
});
