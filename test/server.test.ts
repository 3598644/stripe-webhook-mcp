import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { EventStore } from "../src/store.js";
import { FakeSource, fakeEvent } from "./helpers.js";

async function connect(source: FakeSource, env: NodeJS.ProcessEnv = {}) {
  const server = createServer({ store: new EventStore(":memory:"), config: loadConfig(env), source });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;

describe("MCP server", () => {
  it("exposes the debugging tools", async () => {
    const client = await connect(new FakeSource());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_event", "list_deliveries", "list_events", "replay_event", "sync_events", "wait_for_event"],
    );
  });

  it("list_events syncs and returns summaries", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = await connect(new FakeSource([fakeEvent("checkout.session.completed", now), fakeEvent("invoice.paid", now)]));
    const result = await client.callTool({ name: "list_events", arguments: { type: "invoice.*" } });
    const rows = JSON.parse(text(result));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "invoice.paid", object: expect.stringMatching(/^invoice:obj_/) });
  });

  it("get_event returns the full payload", async () => {
    const e = fakeEvent("customer.created", 1, { email: "a@b.co" });
    const client = await connect(new FakeSource([e]));
    const result = await client.callTool({ name: "get_event", arguments: { id: e.id } });
    expect(JSON.parse(text(result)).event.data.object.email).toBe("a@b.co");
  });

  it("returns readable errors instead of crashing", async () => {
    const client = await connect(new FakeSource([fakeEvent("x.y", 1)]));
    await client.callTool({ name: "sync_events", arguments: {} });
    const result = await client.callTool({ name: "replay_event", arguments: { id: "evt_test_missing" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/not stored|No target URL/);
  });
});
