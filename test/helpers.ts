import type Stripe from "stripe";
import type { EventSource, ListPage } from "../src/sync.js";

let seq = 0;

export function fakeEvent(type: string, created: number, object: Record<string, unknown> = {}): Stripe.Event {
  seq += 1;
  return {
    id: `evt_test_${seq}`,
    object: "event",
    type,
    created,
    livemode: false,
    api_version: "2025-09-30.clover",
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: { object: { id: `obj_${seq}`, object: type.split(".")[0], ...object } },
  } as unknown as Stripe.Event;
}

/** Mimics Stripe's /v1/events: newest first, `created.gte` filter, cursor pagination. */
export class FakeSource implements EventSource {
  calls: Stripe.EventListParams[] = [];
  constructor(public events: Stripe.Event[] = []) {}

  async list(params: Stripe.EventListParams): Promise<ListPage> {
    this.calls.push(params);
    const gte = (params.created as { gte?: number } | undefined)?.gte ?? 0;
    let rows = [...this.events].filter((e) => e.created >= gte).sort((a, b) => b.created - a.created);
    if (params.starting_after) rows = rows.slice(rows.findIndex((e) => e.id === params.starting_after) + 1);
    const limit = params.limit ?? 10;
    return { data: rows.slice(0, limit), has_more: rows.length > limit };
  }
}
