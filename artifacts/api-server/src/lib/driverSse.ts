import type { Response } from "express";

/**
 * In-memory registry of active SSE subscribers, keyed by driver DB id.
 * When a new fleet order assignment is created or reassigned to a driver,
 * all open SSE connections for that driver receive a push so the app can
 * refresh orders and notifications immediately.
 */
const subscribers = new Map<number, Set<Response>>();

export function subscribe(driverId: number, res: Response): void {
  let set = subscribers.get(driverId);
  if (!set) {
    set = new Set();
    subscribers.set(driverId, set);
  }
  set.add(res);

  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) {
      subscribers.delete(driverId);
    }
  });
}

export function broadcast(driverId: number): void {
  const set = subscribers.get(driverId);
  if (!set || set.size === 0) return;

  const payload = `event: assignment\ndata: {}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

/**
 * Notify all open SSE connections for a driver that their order status has
 * been changed by an admin so the app can refresh immediately.
 */
export function broadcastStatusChange(driverId: number): void {
  const set = subscribers.get(driverId);
  if (!set || set.size === 0) return;

  const payload = `event: status\ndata: {}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}
