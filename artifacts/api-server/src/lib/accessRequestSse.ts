import type { Response } from "express";

/**
 * In-memory registry of active SSE subscribers, keyed by workspaceOwnerId.
 * Each value is a Set of Express Response objects that are holding open
 * SSE connections for that workspace.
 */
const subscribers = new Map<string, Set<Response>>();

/**
 * Register an SSE response for the given workspace and set up cleanup when
 * the connection closes.
 */
export function subscribe(workspaceOwnerId: string, res: Response): void {
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

/**
 * Send a "changed" SSE event to every subscriber currently watching the
 * given workspace's access-request feed.
 */
export function broadcast(workspaceOwnerId: string): void {
  const set = subscribers.get(workspaceOwnerId);
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
