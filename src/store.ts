import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  /** Full Stripe event object, exactly as returned by the API. */
  payload: Record<string, unknown>;
}

export interface Delivery {
  id: number;
  eventId: string;
  targetUrl: string;
  status: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number;
  deliveredAt: number;
}

export interface ListEventsOptions {
  type?: string;
  /** Unix seconds, exclusive. */
  since?: number;
  limit?: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created INTEGER NOT NULL,
  livemode INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_created ON events (created DESC);
CREATE INDEX IF NOT EXISTS events_type ON events (type, created DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status INTEGER,
  response_body TEXT,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries (event_id, id DESC);
`;

interface EventRow {
  id: string;
  type: string;
  created: number;
  livemode: number;
  payload: string;
}

interface DeliveryRow {
  id: number;
  event_id: string;
  target_url: string;
  status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number;
  delivered_at: number;
}

export class EventStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Inserts events, ignoring ones already stored. Returns how many were new. */
  upsertEvents(events: StoredEvent[]): number {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO events (id, type, created, livemode, payload) VALUES (?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((rows: StoredEvent[]) => {
      let added = 0;
      for (const e of rows) {
        added += insert.run(e.id, e.type, e.created, e.livemode ? 1 : 0, JSON.stringify(e.payload)).changes;
      }
      return added;
    });
    return tx(events);
  }

  getEvent(id: string): StoredEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;
    return row && toEvent(row);
  }

  listEvents({ type, since, limit = 20 }: ListEventsOptions = {}): StoredEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (type) {
      // Allow Stripe-style wildcards such as "invoice.*".
      if (type.endsWith(".*")) {
        where.push("type LIKE ?");
        args.push(type.slice(0, -1) + "%");
      } else {
        where.push("type = ?");
        args.push(type);
      }
    }
    if (since !== undefined) {
      where.push("created > ?");
      args.push(since);
    }
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, limit) as EventRow[];
    return rows.map(toEvent);
  }

  /** Newest `created` timestamp stored, used as the sync cursor. */
  latestCreated(): number | undefined {
    const row = this.db.prepare("SELECT MAX(created) AS m FROM events").get() as { m: number | null };
    return row.m ?? undefined;
  }

  recordDelivery(d: Omit<Delivery, "id">): Delivery {
    const result = this.db
      .prepare(
        `INSERT INTO deliveries (event_id, target_url, status, response_body, error, duration_ms, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.eventId, d.targetUrl, d.status, d.responseBody, d.error, d.durationMs, d.deliveredAt);
    return { ...d, id: Number(result.lastInsertRowid) };
  }

  listDeliveries(eventId?: string, limit = 20): Delivery[] {
    const rows = (
      eventId
        ? this.db.prepare("SELECT * FROM deliveries WHERE event_id = ? ORDER BY id DESC LIMIT ?").all(eventId, limit)
        : this.db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT ?").all(limit)
    ) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    type: row.type,
    created: row.created,
    livemode: row.livemode === 1,
    payload: JSON.parse(row.payload),
  };
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    eventId: row.event_id,
    targetUrl: row.target_url,
    status: row.status,
    responseBody: row.response_body,
    error: row.error,
    durationMs: row.duration_ms,
    deliveredAt: row.delivered_at,
  };
}
