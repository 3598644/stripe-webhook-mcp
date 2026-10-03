#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Stripe from "stripe";
import { parseArgs } from "node:util";
import { loadConfig, requireStripeKey, requireTargetUrl, requireWebhookSecret } from "./config.js";
import { replayEvent } from "./replay.js";
import { createServer } from "./server.js";
import { EventStore } from "./store.js";
import { stripeEventSource, syncEvents, waitForEvent } from "./sync.js";

const USAGE = `stripe-webhook-mcp — capture, inspect, and replay Stripe webhook events

Usage:
  stripe-webhook-mcp mcp                         Run the MCP server on stdio (for Claude Code, Cursor)
  stripe-webhook-mcp sync                        Pull new events from Stripe
  stripe-webhook-mcp list [--type T] [--limit N] List stored events, newest first
  stripe-webhook-mcp show <evt_id>               Print an event's full payload
  stripe-webhook-mcp wait <type> [--timeout S]   Wait for an event of a type to arrive
  stripe-webhook-mcp replay <evt_id> [--to URL]  Re-deliver an event, signed, to a local handler
  stripe-webhook-mcp deliveries [evt_id]         Show replay history

Environment:
  STRIPE_SECRET_KEY      Test-mode key (sk_test_... or rk_test_...) used to read events
  STRIPE_WEBHOOK_SECRET  Your endpoint's whsec_..., used to sign replays
  WEBHOOK_TARGET_URL     Default replay target, e.g. http://localhost:3000/api/webhooks/stripe
  STRIPE_WEBHOOK_MCP_DB  SQLite path (default ~/.stripe-webhook-mcp/events.db)`;

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: "string" },
      limit: { type: "string" },
      timeout: { type: "string" },
      to: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  const store = new EventStore(config.dbPath);
  const source = () => stripeEventSource(new Stripe(requireStripeKey(config)));
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (command) {
    case "mcp": {
      // stdout carries the protocol; anything human-facing must go to stderr.
      await createServer({ store, config }).connect(new StdioServerTransport());
      console.error(`stripe-webhook-mcp: MCP server ready (db: ${config.dbPath})`);
      return;
    }
    case "sync":
      print(await syncEvents(store, source()));
      break;
    case "list":
      for (const e of store.listEvents({ type: values.type, limit: Number(values.limit ?? 20) })) {
        console.log(`${new Date(e.created * 1000).toISOString()}  ${e.id}  ${e.type}`);
      }
      break;
    case "show": {
      const event = store.getEvent(need(arg, "event id"));
      if (!event) throw new Error(`Event ${arg} is not stored. Run \`sync\` first.`);
      print(event.payload);
      break;
    }
    case "wait": {
      const type = need(arg, "event type");
      const timeout = Number(values.timeout ?? 60);
      console.error(`Waiting up to ${timeout}s for ${type}...`);
      const event = await waitForEvent(store, source(), {
        type,
        since: Math.floor(Date.now() / 1000) - 30,
        timeoutMs: timeout * 1000,
      });
      if (!event) throw new Error(`No ${type} event within ${timeout}s.`);
      print(event.payload);
      break;
    }
    case "replay": {
      const delivery = await replayEvent(store, {
        eventId: need(arg, "event id"),
        targetUrl: requireTargetUrl(config, values.to),
        webhookSecret: requireWebhookSecret(config),
      });
      print(delivery);
      if (delivery.error || (delivery.status ?? 500) >= 400) process.exitCode = 1;
      break;
    }
    case "deliveries":
      print(store.listDeliveries(arg));
      break;
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  store.close();
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}. Run with --help for usage.`);
  return value;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
