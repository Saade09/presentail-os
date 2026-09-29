import type { Response } from "express";

/**
 * In-memory registry of active SSE subscribers for attendance correction-request events,
 * keyed by workspace owner ID. When an employee submits a new correction request the
 * server calls broadcastAttendanceRequest() so every subscribed manager/owner tab
 * receives a real-time "changed" push without polling.
 */
const subscribers = new Map<string, Set<Response>>();

export function subscribeAttendance(workspaceOwnerId: string, res: Response): void {
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

export function broadcastAttendanceRequest(workspaceOwnerId: string): void {
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
