import type { Response } from "express";

/**
 * In-memory registry of active SSE subscribers for low-stock events,
 * keyed by workspaceOwnerId. When a stock adjustment or transfer causes a
 * location to cross into low-stock territory, broadcastLowStock() notifies
 * every open dashboard tab in that workspace so managers see an immediate
 * toast without needing to refresh or wait for email.
 */
const subscribers = new Map<string, Set<Response>>();

export interface LowStockPayload {
  itemName: string;
  locationName: string;
  currentStock: number;
  baseItemId: number;
}

export function subscribeToLowStock(workspaceOwnerId: string, res: Response): void {
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

export function broadcastLowStock(workspaceOwnerId: string, payload: LowStockPayload): void {
  const set = subscribers.get(workspaceOwnerId);
  if (!set || set.size === 0) return;

  const data = JSON.stringify(payload);
  const msg = `event: low_stock\ndata: ${data}\n\n`;
  for (const res of set) {
    try {
      res.write(msg);
    } catch {
      set.delete(res);
    }
  }
}
