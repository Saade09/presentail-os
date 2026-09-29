import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type pg from "pg";
import { db } from "./db";
import { logger } from "./logger";

/**
 * SSE fan-out for the broad /api/events stream.
 *
 * Local subscribers (browser tabs connected to THIS process) are kept in an
 * in-memory registry keyed by workspace owner ID. Because the production
 * deployment is autoscale (multiple instances), an event produced on one
 * instance must also reach subscribers connected to other instances — that is
 * bridged via Postgres LISTEN/NOTIFY on the `app_sse_events` channel:
 *
 *   broadcastEvent() → local fan-out + pg_notify('app_sse_events', …)
 *   dedicated LISTEN connection → fan-out of notifications from OTHER
 *   instances (each message carries the origin instance id so a process
 *   never double-delivers its own broadcasts).
 *
 * The bridge is best-effort and self-healing: pg_notify failures are logged
 * (local delivery still happens), and the LISTEN connection reconnects with
 * backoff if it drops. The listener starts lazily on the first subscriber so
 * unit tests that never subscribe don't open extra connections.
 */

const subscribers = new Map<string, Set<Response>>();

const NOTIFY_CHANNEL = "app_sse_events";
/** Identifies this process so its own NOTIFY messages are ignored on receipt. */
const INSTANCE_ID = randomUUID();
/** pg NOTIFY payloads are capped at ~8000 bytes; skip the bridge for oversized ones. */
const MAX_NOTIFY_PAYLOAD_BYTES = 7500;

export type SseEventPayload = {
  event: string;
  workspaceId: string;
  data: Record<string, unknown>;
};

// ── Cross-instance bridge (Postgres LISTEN/NOTIFY) ───────────────────────────

let listenerStarted = false;
let listenerClient: pg.PoolClient | null = null;
let reconnectDelayMs = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

function scheduleListenerReconnect(): void {
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  const timer = setTimeout(() => {
    void startListener();
  }, delay);
  // Never keep the process alive just for the reconnect timer.
  timer.unref?.();
}

async function startListener(): Promise<void> {
  try {
    const client = await db.connect();
    listenerClient = client;

    client.on("notification", (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
      try {
        const parsed = JSON.parse(msg.payload) as {
          instanceId?: string;
          workspaceOwnerId?: string;
          payload?: SseEventPayload;
        };
        // Own broadcasts were already delivered locally in broadcastEvent().
        if (parsed.instanceId === INSTANCE_ID) return;
        if (!parsed.workspaceOwnerId || !parsed.payload) return;
        deliverLocal(parsed.workspaceOwnerId, parsed.payload);
      } catch (err) {
        logger.warn({ err }, "eventsSse: failed to parse NOTIFY payload");
      }
    });

    client.on("error", (err) => {
      logger.warn({ err }, "eventsSse: LISTEN connection errored; reconnecting");
      try {
        client.release(true);
      } catch {
        /* already released */
      }
      if (listenerClient === client) listenerClient = null;
      scheduleListenerReconnect();
    });

    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    reconnectDelayMs = 1_000;
    logger.info({ channel: NOTIFY_CHANNEL }, "eventsSse: cross-instance LISTEN active");
  } catch (err) {
    listenerClient = null;
    logger.warn({ err }, "eventsSse: failed to start LISTEN connection; will retry");
    scheduleListenerReconnect();
  }
}

/** Idempotently start the cross-instance listener. */
export function ensureEventsBridge(): void {
  if (listenerStarted) return;
  listenerStarted = true;
  void startListener();
}

/** Test-only: reset bridge state so unit tests can exercise startup paths. */
export function __resetEventsBridgeForTests(): void {
  listenerStarted = false;
  try {
    listenerClient?.release(true);
  } catch {
    /* ignore */
  }
  listenerClient = null;
  reconnectDelayMs = 1_000;
  subscribers.clear();
}

// ── Local subscriber registry ────────────────────────────────────────────────

export function subscribeEvents(workspaceOwnerId: string, res: Response): void {
  ensureEventsBridge();

  let set = subscribers.get(workspaceOwnerId);
  if (!set) {
    set = new Set();
    subscribers.set(workspaceOwnerId, set);
  }
  set.add(res);

  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) {
      subscribers.delete(workspaceOwnerId);
    }
  });
}

function deliverLocal(workspaceOwnerId: string, payload: SseEventPayload): void {
  const set = subscribers.get(workspaceOwnerId);
  if (!set || set.size === 0) return;

  const data = JSON.stringify({
    event: payload.event,
    workspaceId: payload.workspaceId,
    data: payload.data,
  });
  const chunk = `event: ${payload.event}\ndata: ${data}\n\n`;
  for (const res of set) {
    try {
      res.write(chunk);
    } catch {
      set.delete(res);
    }
  }
}

export function broadcastEvent(workspaceOwnerId: string, payload: SseEventPayload): void {
  // Local fan-out first — never blocked by the cross-instance bridge.
  deliverLocal(workspaceOwnerId, payload);

  // Cross-instance bridge: best-effort, fire-and-forget.
  try {
    const message = JSON.stringify({
      instanceId: INSTANCE_ID,
      workspaceOwnerId,
      payload,
    });
    if (Buffer.byteLength(message, "utf8") > MAX_NOTIFY_PAYLOAD_BYTES) {
      logger.warn(
        { event: payload.event, workspaceOwnerId },
        "eventsSse: NOTIFY payload too large; skipping cross-instance broadcast",
      );
      return;
    }
    void db
      .query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, message])
      .catch((err) => {
        logger.warn(
          { err, event: payload.event },
          "eventsSse: pg_notify failed; local delivery unaffected",
        );
      });
  } catch (err) {
    logger.warn({ err }, "eventsSse: failed to serialize NOTIFY payload");
  }
}
