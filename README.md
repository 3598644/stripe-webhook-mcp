# stripe-webhook-mcp

Let your AI coding agent debug Stripe webhooks itself. Claude Code or Cursor can pull
Stripe events, read their payloads, and replay them, correctly signed, into your local
handler, then read back the status and stack trace. No dashboard tab, no copy-pasting
JSON.

```
you:    "invoice.paid is 500ing, fix it"
agent:  list_events(type: "invoice.paid") → replay_event(evt_…) → 500, TypeError at webhook.ts:59
        …edits handler… → replay_event(evt_…) → 200 ✓
```

## Setup

You need a **test-mode** Stripe key, plus the signing secret your handler verifies with.

**Claude Code**

```bash
claude mcp add stripe-webhooks \
  -e STRIPE_SECRET_KEY=sk_test_... \
  -e STRIPE_WEBHOOK_SECRET=whsec_... \
  -e WEBHOOK_TARGET_URL=http://localhost:3000/api/webhooks/stripe \
  -- npx -y stripe-webhook-mcp mcp
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "stripe-webhooks": {
      "command": "npx",
      "args": ["-y", "stripe-webhook-mcp", "mcp"],
      "env": {
        "STRIPE_SECRET_KEY": "sk_test_...",
        "STRIPE_WEBHOOK_SECRET": "whsec_...",
        "WEBHOOK_TARGET_URL": "http://localhost:3000/api/webhooks/stripe"
      }
    }
  }
}
```

A restricted key (`rk_test_...`) with read access to Events is enough. Live keys are
refused unless you set `STRIPE_WEBHOOK_MCP_ALLOW_LIVE=1`.

## Tools

| Tool | What it does |
|---|---|
| `list_events` | Recent events as one-line summaries. Filter by type (`invoice.*` works) or age |
| `get_event` | The full payload of one event, plus its replay history |
| `wait_for_event` | Block until an event type arrives. Use it after triggering a test checkout |
| `replay_event` | Re-deliver an event, signed, to your handler, and return its status and body |
| `list_deliveries` | Past replays and what the handler returned |
| `sync_events` | Pull new events from Stripe. The other tools call it as needed |

## How it works

Events come from Stripe's Events API using your key, so there's no tunnel and no
`stripe listen` to run. They're stored in a local SQLite file
(`~/.stripe-webhook-mcp/events.db`). Replays are signed with your `whsec_` the same way
Stripe signs them, so your handler's `constructEvent` check passes unmodified.

## CLI

The same operations are available without an agent:

```bash
npx stripe-webhook-mcp sync
npx stripe-webhook-mcp list --type invoice.paid
npx stripe-webhook-mcp replay evt_123 --to http://localhost:3000/api/webhooks/stripe
```

## Try it without a Stripe app

`examples/webhook-fixture.ts` is a small handler with a deliberate, realistic bug in
`invoice.paid`:

```bash
STRIPE_WEBHOOK_SECRET=whsec_test npm run fixture   # http://localhost:3000/webhook
```

## License

MIT
