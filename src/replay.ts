import Stripe from "stripe";
import type { Delivery, EventStore } from "./store.js";

/** Response bodies are truncated before storage; stack traces can be huge. */
const MAX_BODY = 8_000;

export interface ReplayOptions {
  eventId: string;
  targetUrl: string;
  /** The endpoint's signing secret (whsec_...), so the handler's signature check passes. */
  webhookSecret: string;
  timeoutMs?: number;
}

/**
 * Re-delivers a stored event to a local handler the way Stripe would: the
 * raw JSON body plus a valid `Stripe-Signature` header. The handler's status
 * and body are recorded so an agent can see why it failed.
 */
export async function replayEvent(
  store: EventStore,
  { eventId, targetUrl, webhookSecret, timeoutMs = 10_000 }: ReplayOptions,
): Promise<Delivery> {
  const event = store.getEvent(eventId);
  if (!event) throw new Error(`Event ${eventId} is not stored. Run sync_events first, or check the id.`);

  const payload = JSON.stringify(event.payload, null, 2);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  const started = Date.now();

  let status: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Stripe-Signature": signature,
        "User-Agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks) stripe-webhook-mcp",
      },
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    responseBody = truncate(await res.text());
  } catch (err) {
    error = describeFetchError(err, targetUrl, timeoutMs);
  }

  return store.recordDelivery({
    eventId,
    targetUrl,
    status,
    responseBody,
    error,
    durationMs: Date.now() - started,
    deliveredAt: Math.floor(started / 1000),
  });
}

function truncate(body: string): string {
  return body.length > MAX_BODY ? body.slice(0, MAX_BODY) + `\n…[truncated ${body.length - MAX_BODY} chars]` : body;
}

function describeFetchError(err: unknown, url: string, timeoutMs: number): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return `Handler did not respond within ${timeoutMs}ms`;
    const cause = err.cause as { code?: string; message?: string } | undefined;
    if (cause?.code === "ECONNREFUSED") return `Connection refused at ${url}. Is your dev server running?`;
    // fetch reports everything as "fetch failed"; the cause has the useful part.
    const detail = cause?.code ?? cause?.message;
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}
