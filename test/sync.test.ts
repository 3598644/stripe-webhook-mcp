import { describe, expect, it } from "vitest";
import { EventStore } from "../src/store.js";
import { syncEvents, waitForEvent } from "../src/sync.js";
import { FakeSource, fakeEvent } from "./helpers.js";

describe("syncEvents", () => {
  it("pages through results and stores them", async () => {
    const source = new FakeSource(Array.from({ length: 150 }, (_, i) => fakeEvent("charge.succeeded", 1000 + i)));
    const store = new EventStore(":memory:");
    expect(await syncEvents(store, source, { initialEvents: 150 })).toEqual({ fetched: 150, added: 150 });
    expect(source.calls).toHaveLength(2);
  });

  it("resumes from the newest stored timestamp, inclusive, without duplicating", async () => {
    const a = fakeEvent("charge.succeeded", 100);
    const source = new FakeSource([a]);
    const store = new EventStore(":memory:");
    await syncEvents(store, source);

    // A second event in the same second as the cursor must not be missed.
    source.events.push(fakeEvent("charge.refunded", 100), fakeEvent("charge.captured", 101));
    expect(await syncEvents(store, source)).toEqual({ fetched: 3, added: 2 });
    expect(source.calls.at(-1)?.created).toEqual({ gte: 100 });
  });
});

describe("waitForEvent", () => {
  it("returns once a matching event appears", async () => {
    const source = new FakeSource([fakeEvent("invoice.created", 500)]);
    const store = new EventStore(":memory:");
    setTimeout(() => source.events.push(fakeEvent("invoice.paid", 501)), 30);
    const event = await waitForEvent(store, source, { type: "invoice.paid", since: 499, timeoutMs: 1000, intervalMs: 10 });
    expect(event?.type).toBe("invoice.paid");
  });

  it("ignores matches older than since, and times out", async () => {
    const source = new FakeSource([fakeEvent("invoice.paid", 100)]);
    const store = new EventStore(":memory:");
    expect(await waitForEvent(store, source, { type: "invoice.paid", since: 200, timeoutMs: 50, intervalMs: 10 })).toBeUndefined();
  });
});
