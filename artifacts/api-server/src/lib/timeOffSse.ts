import type { Response } from "express";

/**
 * In-memory registry of active SSE subscribers, keyed by recipient member DB id.
 * When a time-off request is submitted, the manager (recipient) receives a real-time push.
 */
const subscribers = new Map<number, Set<Response>>();

export function subscribe(recipientMemberId: number, res: Response): void {
  let set = subscribers.get(recipientMemberId);
  if (!set) {
    set = new Set();
    subscribers.set(recipientMemberId, set);
  }
  set.add(res);

  res.on("close", () => {
    set!.delete(res);
    if (set!.size === 0) {
      subscribers.delete(recipientMemberId);
    }
  });
}

export function broadcast(recipientMemberId: number): void {
  const set = subscribers.get(recipientMemberId);
  if (!set || set.size === 0) return;

  const payload = `event: changed\ndata: {}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}
