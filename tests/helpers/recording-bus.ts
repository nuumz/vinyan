/**
 * Test helper — records bus events for assertions.
 */
import type { VinyanBus, BusEventName } from "../../src/core/bus.ts";

export interface RecordedEvent {
  event: string;
  payload: unknown;
  timestamp: number;
}

export function recordEvents(bus: VinyanBus, events: BusEventName[]) {
  const records: RecordedEvent[] = [];
  const unsubs = events.map((e) =>
    bus.on(e, ((p: unknown) => {
      records.push({ event: e, payload: p, timestamp: Date.now() });
    }) as never),
  );
  return {
    records,
    cleanup: () => unsubs.forEach((u) => u()),
  };
}
