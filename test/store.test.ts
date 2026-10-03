import { describe, expect, it } from "vitest";
import { EventStore } from "../src/store.js";

const ev = (id: string, type: string, created: number) => ({ id, type, created, livemode: false, payload: { id, type } });

describe("EventStore", () => {
  it("ignores duplicate events and reports only new inserts", () => {
    const store = new EventStore(":memory:");
    expect(store.upsertEvents([ev("evt_1", "a.b", 1), ev("evt_2", "a.b", 2)])).toBe(2);
    expect(store.upsertEvents([ev("evt_2", "a.b", 2), ev("evt_3", "a.b", 3)])).toBe(1);
    expect(store.latestCreated()).toBe(3);
  });

  it("filters by exact type, wildcard type, and since", () => {
    const store = new EventStore(":memory:");
    store.upsertEvents([
      ev("evt_1", "invoice.paid", 10),
      ev("evt_2", "invoice.created", 20),
      ev("evt_3", "invoices_x.paid", 25),
      ev("evt_4", "checkout.session.completed", 30),
    ]);
    expect(store.listEvents({ type: "invoice.paid" }).map((e) => e.id)).toEqual(["evt_1"]);
    expect(store.listEvents({ type: "invoice.*" }).map((e) => e.id)).toEqual(["evt_2", "evt_1"]);
    expect(store.listEvents({ since: 15 }).map((e) => e.id)).toEqual(["evt_4", "evt_3", "evt_2"]);
  });

  it("round-trips payloads and records deliveries", () => {
    const store = new EventStore(":memory:");
    store.upsertEvents([ev("evt_1", "a.b", 1)]);
    expect(store.getEvent("evt_1")?.payload).toEqual({ id: "evt_1", type: "a.b" });
    const d = store.recordDelivery({
      eventId: "evt_1", targetUrl: "http://x", status: 500, responseBody: "boom", error: null, durationMs: 3, deliveredAt: 1,
    });
    expect(store.listDeliveries("evt_1")).toEqual([d]);
  });
});
