import type { Response } from "express";

export interface OmnichannelSseEvent {
  type: "conversation_updated";
  conversation_id: number;
  workspace_owner_id: string;
}

class OmnichannelSseBus {
  private clients = new Map<string, Set<Response>>();

  subscribe(workspaceOwnerId: string, res: Response): void {
    let set = this.clients.get(workspaceOwnerId);
    if (!set) {
      set = new Set();
      this.clients.set(workspaceOwnerId, set);
    }
    set.add(res);
  }

  unsubscribe(workspaceOwnerId: string, res: Response): void {
    const set = this.clients.get(workspaceOwnerId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(workspaceOwnerId);
  }

  push(event: OmnichannelSseEvent): void {
    const set = this.clients.get(event.workspace_owner_id);
    if (!set || set.size === 0) return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of [...set]) {
      try {
        res.write(payload);
      } catch {
        set.delete(res);
      }
    }
  }

  connectionCount(workspaceOwnerId: string): number {
    return this.clients.get(workspaceOwnerId)?.size ?? 0;
  }
}

export const sseBus = new OmnichannelSseBus();
