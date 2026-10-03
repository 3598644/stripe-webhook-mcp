import type Stripe from "stripe";
import type { EventStore, StoredEvent } from "./store.js";

export interface ListPage {
  data: Stripe.Event[];
  has_more: boolean;
}

/** The slice of the Stripe client we use, so tests can supply a fake. */
export interface EventSource {
  list(params: Stripe.EventListParams): Promise<ListPage>;
}

export function stripeEventSource(stripe: Stripe): EventSource {
  return { list: (params) => stripe.events.list(params) };
}

export interface SyncOptions {
  /** Cap on events pulled in one sync. Default 500. */
  maxEvents?: number;
  /** Events to pull on the very first sync, when nothing is stored yet. Default 100. */
  initialEvents?: number;
}

export interface SyncResult {
  fetched: number;
  added: number;
}

/**
 * Pulls events newer than the newest stored one. Uses `created >= cursor`
 * rather than `>` because several events can share a second; duplicates are
 * dropped by the store.
 */
export async function syncEvents(
  store: EventStore,
  source: EventSource,
  { maxEvents = 500, initialEvents = 100 }: SyncOptions = {},
): Promise<SyncResult> {
  const cursor = store.latestCreated();
  const cap = cursor === undefined ? initialEvents : maxEvents;
  const fetched: StoredEvent[] = [];
  let startingAfter: string | undefined;

  while (fetched.length < cap) {
    const page = await source.list({
      limit: Math.min(100, cap - fetched.length),
      ...(cursor !== undefined && { created: { gte: cursor } }),
      ...(startingAfter && { starting_after: startingAfter }),
    });
    for (const e of page.data) fetched.push(toStored(e));
    const last = page.data.at(-1);
    if (!page.has_more || !last) break;
    startingAfter = last.id;
  }

  return { fetched: fetched.length, added: store.upsertEvents(fetched) };
}

export interface WaitOptions {
  /** Exact type, or a prefix wildcard such as "invoice.*". */
  type?: string;
  /** Only match events created after this Unix time (seconds). */
  since: number;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Polls Stripe until an event matching `type` created after `since` exists.
 * Resolves with the newest match, or undefined on timeout.
 */
export async function waitForEvent(
  store: EventStore,
  source: EventSource,
  { type, since, timeoutMs = 60_000, intervalMs = 2_000 }: WaitOptions,
): Promise<StoredEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await syncEvents(store, source);
    const [match] = store.listEvents({ type, since, limit: 1 });
    if (match) return match;
    if (Date.now() + intervalMs > deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function toStored(e: Stripe.Event): StoredEvent {
  return {
    id: e.id,
    type: e.type,
    created: e.created,
    livemode: e.livemode,
    payload: e as unknown as Record<string, unknown>,
  };
}
