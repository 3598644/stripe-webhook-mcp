import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { replayEvent } from "../src/replay.js";
import { EventStore } from "../src/store.js";
import { fakeEvent } from "./helpers.js";

const SECRET = "whsec_test_secret";
let server: Server | undefined;

/** A handler that verifies signatures like a real app, then responds per event type. */
async function startHandler(): Promise<string> {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    try {
      const event = Stripe.webhooks.constructEvent(body, req.headers["stripe-signature"] as string, SECRET);
      if (event.type === "invoice.paid") res.writeHead(500).end("TypeError: cannot read 'id' of undefined");
      else res.writeHead(200).end('{"received":true}');
    } catch (err) {
      res.writeHead(400).end((err as Error).message);
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/webhook`;
}

afterEach(() => server?.close());

function storeWith(type: string) {
  const store = new EventStore(":memory:");
  const e = fakeEvent(type, 1);
  store.upsertEvents([{ id: e.id, type, created: 1, livemode: false, payload: e as never }]);
  return { store, id: e.id };
}

describe("replayEvent", () => {
  it("signs payloads so a real handler's verification passes", async () => {
    const url = await startHandler();
    const { store, id } = storeWith("checkout.session.completed");
    const d = await replayEvent(store, { eventId: id, targetUrl: url, webhookSecret: SECRET });
    expect(d).toMatchObject({ status: 200, responseBody: '{"received":true}', error: null });
  });

  it("captures handler failures for the agent to read", async () => {
    const url = await startHandler();
    const { store, id } = storeWith("invoice.paid");
    const d = await replayEvent(store, { eventId: id, targetUrl: url, webhookSecret: SECRET });
    expect(d.status).toBe(500);
    expect(d.responseBody).toContain("TypeError");
    expect(store.listDeliveries(id)).toHaveLength(1);
  });

  it("surfaces a wrong signing secret as the handler's 400", async () => {
    const url = await startHandler();
    const { store, id } = storeWith("checkout.session.completed");
    const d = await replayEvent(store, { eventId: id, targetUrl: url, webhookSecret: "whsec_wrong" });
    expect(d.status).toBe(400);
    expect(d.responseBody).toMatch(/signature/i);
  });

  it("explains a refused connection instead of throwing", async () => {
    // Grab a free port, then close it so nothing is listening there.
    const url = await startHandler();
    await new Promise((r) => server!.close(r));
    server = undefined;
    const { store, id } = storeWith("checkout.session.completed");
    const d = await replayEvent(store, { eventId: id, targetUrl: url, webhookSecret: SECRET });
    expect(d.status).toBeNull();
    expect(d.error).toMatch(/dev server running/);
  });

  it("throws for an unknown event id", async () => {
    const store = new EventStore(":memory:");
    await expect(replayEvent(store, { eventId: "evt_nope", targetUrl: "http://x", webhookSecret: SECRET })).rejects.toThrow(/not stored/);
  });
});
