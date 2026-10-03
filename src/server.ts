import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Stripe from "stripe";
import { z } from "zod";
import { type Config, requireStripeKey, requireTargetUrl, requireWebhookSecret } from "./config.js";
import { replayEvent } from "./replay.js";
import type { EventStore, StoredEvent } from "./store.js";
import { type EventSource, stripeEventSource, syncEvents, waitForEvent } from "./sync.js";

export interface ServerDeps {
  store: EventStore;
  config: Config;
  /** Overrides the real Stripe client; used by tests. */
  source?: EventSource;
}

export function createServer({ store, config, source }: ServerDeps): McpServer {
  const server = new McpServer({ name: "stripe-webhook-mcp", version: "0.1.0" });

  let lazySource = source;
  const getSource = (): EventSource =>
    (lazySource ??= stripeEventSource(new Stripe(requireStripeKey(config))));

  server.registerTool(
    "sync_events",
    {
      title: "Sync Stripe events",
      description:
        "Pull new events from the Stripe account (test mode) into the local store. Other tools read from the store, so call this after triggering activity in Stripe.",
      inputSchema: {},
    },
    async () => run(async () => syncEvents(store, getSource())),
  );

  server.registerTool(
    "list_events",
    {
      title: "List stored Stripe events",
      description:
        "List recent webhook events, newest first, as one-line summaries. Syncs from Stripe first unless sync=false.",
      inputSchema: {
        type: z.string().optional().describe('Event type, e.g. "checkout.session.completed", or a wildcard like "invoice.*"'),
        since_seconds_ago: z.number().int().positive().optional().describe("Only events created in this many past seconds"),
        limit: z.number().int().min(1).max(100).default(20),
        sync: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type, since_seconds_ago, limit, sync }) =>
      run(async () => {
        if (sync) await syncEvents(store, getSource());
        const since = since_seconds_ago ? nowSeconds() - since_seconds_ago : undefined;
        return store.listEvents({ type, since, limit }).map(summarize);
      }),
  );

  server.registerTool(
    "get_event",
    {
      title: "Get a Stripe event",
      description: "Return the full JSON payload of one event, exactly as Stripe delivers it, plus its replay history.",
      inputSchema: { id: z.string().describe("Event id, evt_...") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const event = store.getEvent(id) ?? (await syncEvents(store, getSource()), store.getEvent(id));
        if (!event) throw new Error(`Event ${id} not found in the local store or in recent Stripe events.`);
        return { event: event.payload, deliveries: store.listDeliveries(id, 5) };
      }),
  );

  server.registerTool(
    "wait_for_event",
    {
      title: "Wait for a Stripe event",
      description:
        "Block until an event of the given type arrives, then return it. Use right after triggering something (a test checkout, a CLI command) to confirm Stripe emitted the event you expect.",
      inputSchema: {
        type: z.string().describe('Event type or wildcard, e.g. "invoice.*"'),
        timeout_seconds: z.number().int().min(1).max(300).default(60),
        since_seconds_ago: z
          .number()
          .int()
          .min(0)
          .default(30)
          .describe("Also accept events created this many seconds before the call, so a just-triggered event is not missed"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type, timeout_seconds, since_seconds_ago }) =>
      run(async () => {
        const event = await waitForEvent(store, getSource(), {
          type,
          since: nowSeconds() - since_seconds_ago,
          timeoutMs: timeout_seconds * 1000,
        });
        if (!event) throw new Error(`No ${type} event arrived within ${timeout_seconds}s.`);
        return event.payload;
      }),
  );

  server.registerTool(
    "replay_event",
    {
      title: "Replay a Stripe event to a local handler",
      description:
        "Re-deliver a stored event to a webhook handler with a valid Stripe-Signature header, and return the handler's HTTP status and response body. Use it to reproduce a handler bug and to check a fix.",
      inputSchema: {
        id: z.string().describe("Event id, evt_..."),
        target_url: z.string().url().optional().describe("Handler URL. Defaults to WEBHOOK_TARGET_URL."),
      },
    },
    async ({ id, target_url }) =>
      run(async () => {
        if (!store.getEvent(id)) await syncEvents(store, getSource());
        return replayEvent(store, {
          eventId: id,
          targetUrl: requireTargetUrl(config, target_url),
          webhookSecret: requireWebhookSecret(config),
        });
      }),
  );

  server.registerTool(
    "list_deliveries",
    {
      title: "List replay deliveries",
      description: "Show past replays with each handler's status and response, newest first.",
      inputSchema: {
        event_id: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ event_id, limit }) => run(async () => store.listDeliveries(event_id, limit)),
  );

  return server;
}

/** Wraps a handler so thrown errors reach the agent as readable tool errors. */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

function summarize(e: StoredEvent) {
  const object = (e.payload.data as { object?: { id?: string; object?: string } } | undefined)?.object;
  return {
    id: e.id,
    type: e.type,
    created: new Date(e.created * 1000).toISOString(),
    object: object?.id ? `${object.object}:${object.id}` : undefined,
    livemode: e.livemode,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
