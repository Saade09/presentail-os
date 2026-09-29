import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Response } from "express";

function makeRes(overrides: Partial<Response> = {}): Response {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    write: vi.fn().mockReturnValue(true),
    on: vi.fn((event: string, handler: () => void) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    }),
    _emit: (event: string) => {
      for (const fn of handlers[event] ?? []) fn();
    },
    ...overrides,
  } as unknown as Response;
}

describe("accessRequestSse – subscribe", () => {
  let subscribe: (workspaceOwnerId: string, res: Response) => void;
  let broadcast: (workspaceOwnerId: string) => void;

  beforeAll(async () => {
    vi.resetModules();
    const mod = await import("./accessRequestSse");
    subscribe = mod.subscribe;
    broadcast = mod.broadcast;
  });

  it("registers the response so that broadcast reaches it", () => {
    const res = makeRes();
    subscribe("owner_1", res);
    broadcast("owner_1");
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(String((res.write as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatch(/event: changed/);
  });

  it("supports multiple subscribers for the same workspace", () => {
    const res1 = makeRes();
    const res2 = makeRes();
    subscribe("owner_2", res1);
    subscribe("owner_2", res2);
    broadcast("owner_2");
    expect(res1.write).toHaveBeenCalledTimes(1);
    expect(res2.write).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast to a different workspace's subscribers", () => {
    const resA = makeRes();
    const resB = makeRes();
    subscribe("owner_A", resA);
    subscribe("owner_B", resB);
    broadcast("owner_A");
    expect(resA.write).toHaveBeenCalledTimes(1);
    expect(resB.write).not.toHaveBeenCalled();
  });

  it("removes the subscriber when the connection closes", () => {
    const res = makeRes() as Response & { _emit: (event: string) => void };
    subscribe("owner_3", res);
    (res as unknown as { _emit: (e: string) => void })._emit("close");
    broadcast("owner_3");
    expect(res.write).not.toHaveBeenCalled();
  });

  it("cleans up the workspace entry entirely after the last subscriber closes", () => {
    const res = makeRes() as Response & { _emit: (event: string) => void };
    subscribe("owner_4", res);
    (res as unknown as { _emit: (e: string) => void })._emit("close");
    const res2 = makeRes();
    subscribe("owner_4", res2);
    broadcast("owner_4");
    expect(res2.write).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe("accessRequestSse – broadcast", () => {
  let subscribe: (workspaceOwnerId: string, res: Response) => void;
  let broadcast: (workspaceOwnerId: string) => void;

  beforeAll(async () => {
    vi.resetModules();
    const mod = await import("./accessRequestSse");
    subscribe = mod.subscribe;
    broadcast = mod.broadcast;
  });

  it("is a no-op when no subscribers exist for the workspace", () => {
    expect(() => broadcast("unknown_owner")).not.toThrow();
  });

  it("sends the correct SSE payload format", () => {
    const res = makeRes();
    subscribe("owner_5", res);
    broadcast("owner_5");
    const payload = String((res.write as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(payload).toBe("event: changed\ndata: {}\n\n");
  });

  it("removes a subscriber that throws on write", () => {
    const badRes = makeRes({ write: vi.fn().mockImplementation(() => { throw new Error("socket hang up"); }) } as Partial<Response>);
    const goodRes = makeRes();
    subscribe("owner_6", badRes);
    subscribe("owner_6", goodRes);
    expect(() => broadcast("owner_6")).not.toThrow();
    expect(goodRes.write).toHaveBeenCalledTimes(1);
    broadcast("owner_6");
    expect(badRes.write).toHaveBeenCalledTimes(1);
  });
});
