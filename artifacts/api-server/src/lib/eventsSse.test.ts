import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response } from "express";
import { EventEmitter } from "node:events";

const queryMock = vi.fn().mockResolvedValue({ rows: [] });

class FakeListenerClient extends EventEmitter {
  query = vi.fn().mockResolvedValue({ rows: [] });
  release = vi.fn();
}

let listenerClient: FakeListenerClient;

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => queryMock(...args),
    connect: vi.fn(async () => listenerClient),
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  broadcastEvent,
  subscribeEvents,
  __resetEventsBridgeForTests,
} from "./eventsSse";

function fakeRes(): Response & { chunks: string[] } {
  const emitter = new EventEmitter() as unknown as Response & { chunks: string[] };
  emitter.chunks = [];
  (emitter as unknown as { write: (c: string) => boolean }).write = (c: string) => {
    emitter.chunks.push(c);
    return true;
  };
  return emitter;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("eventsSse", () => {
  beforeEach(() => {
    listenerClient = new FakeListenerClient();
    queryMock.mockClear();
    queryMock.mockResolvedValue({ rows: [] });
    __resetEventsBridgeForTests();
  });

  afterEach(() => {
    __resetEventsBridgeForTests();
  });

  it("delivers events to local subscribers of the same workspace only", async () => {
    const resA = fakeRes();
    const resB = fakeRes();
    subscribeEvents("ws-a", resA);
    subscribeEvents("ws-b", resB);
    await flush();

    broadcastEvent("ws-a", {
      event: "order.created",
      workspaceId: "ws-a",
      data: { id: "o1" },
    });

    expect(resA.chunks).toHaveLength(1);
    expect(resA.chunks[0]).toContain("event: order.created");
    expect(resA.chunks[0]).toContain('"id":"o1"');
    expect(resB.chunks).toHaveLength(0);
  });

  it("publishes every broadcast to the cross-instance NOTIFY channel", async () => {
    broadcastEvent("ws-a", {
      event: "order.created",
      workspaceId: "ws-a",
      data: { id: "o1" },
    });
    await flush();

    expect(queryMock).toHaveBeenCalledWith(
      "SELECT pg_notify($1, $2)",
      ["app_sse_events", expect.stringContaining('"workspaceOwnerId":"ws-a"')],
    );
    const message = JSON.parse(queryMock.mock.calls[0]![1][1] as string);
    expect(message.payload.event).toBe("order.created");
    expect(typeof message.instanceId).toBe("string");
  });

  it("starts LISTEN on first subscribe and fans out foreign notifications", async () => {
    const res = fakeRes();
    subscribeEvents("ws-a", res);
    await flush();

    expect(listenerClient.query).toHaveBeenCalledWith("LISTEN app_sse_events");

    listenerClient.emit("notification", {
      channel: "app_sse_events",
      payload: JSON.stringify({
        instanceId: "some-other-instance",
        workspaceOwnerId: "ws-a",
        payload: { event: "order.created", workspaceId: "ws-a", data: { id: "o9" } },
      }),
    });

    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toContain('"id":"o9"');
  });

  it("ignores notifications originating from this instance (no double delivery)", async () => {
    const res = fakeRes();
    subscribeEvents("ws-a", res);
    await flush();

    broadcastEvent("ws-a", {
      event: "order.created",
      workspaceId: "ws-a",
      data: { id: "o1" },
    });
    await flush();

    // Simulate Postgres echoing our own NOTIFY back to this instance.
    const message = queryMock.mock.calls[0]![1][1] as string;
    listenerClient.emit("notification", {
      channel: "app_sse_events",
      payload: message,
    });

    expect(res.chunks).toHaveLength(1); // only the direct local delivery
  });

  it("survives pg_notify failure — local delivery still happens", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    const res = fakeRes();
    subscribeEvents("ws-a", res);
    await flush();

    broadcastEvent("ws-a", {
      event: "order.created",
      workspaceId: "ws-a",
      data: { id: "o1" },
    });
    await flush();

    expect(res.chunks).toHaveLength(1);
  });

  it("ignores malformed NOTIFY payloads", async () => {
    const res = fakeRes();
    subscribeEvents("ws-a", res);
    await flush();

    listenerClient.emit("notification", {
      channel: "app_sse_events",
      payload: "not json",
    });

    expect(res.chunks).toHaveLength(0);
  });

  it("removes a subscriber when its response closes", async () => {
    const res = fakeRes();
    subscribeEvents("ws-a", res);
    await flush();
    (res as unknown as EventEmitter).emit("close");

    broadcastEvent("ws-a", {
      event: "order.created",
      workspaceId: "ws-a",
      data: { id: "o1" },
    });

    expect(res.chunks).toHaveLength(0);
  });
});
