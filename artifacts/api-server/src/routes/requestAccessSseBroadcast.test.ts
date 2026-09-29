import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Response } from "express";

vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(),
  clerkClient: {
    users: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/email", () => ({
  sendAccessRequestEmail: vi.fn(),
}));

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import { getAuth, clerkClient } from "@clerk/express";
import { sendAccessRequestEmail } from "../lib/email";
import { subscribe } from "../lib/accessRequestSse";
import app from "../app";

const USER_ID = "user_sse_integration_test";
const USER_EMAIL = "requester-sse@example.com";
const OWNER_ID = "owner_sse_workspace_999";

type FakeRes = Response & { writes: string[]; close: () => void };

function makeFakeRes(): FakeRes {
  const writes: string[] = [];
  const closeListeners: (() => void)[] = [];

  return {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
    }),
    writes,
    close: () => closeListeners.forEach((l) => l()),
  } as unknown as FakeRes;
}

function mockAuthedUser() {
  vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
  vi.mocked(clerkClient.users.getUser).mockResolvedValue({
    primaryEmailAddress: { emailAddress: USER_EMAIL },
    firstName: "SSE",
    lastName: "Tester",
  } as never);
}

function mockNewInsert() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
}

function mockOwnerEmailQuery(ownerIds: string[] = [OWNER_ID]) {
  mockDbQuery.mockResolvedValueOnce({
    rows: ownerIds.map((id) => ({ member_email: `${id}@example.com` })),
    rowCount: ownerIds.length,
  });
}

describe("POST /api/request-access — real SSE broadcast integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);
  });

  it("delivers event: changed to a subscribed owner immediately when a new request is inserted", async () => {
    const fakeRes = makeFakeRes();
    subscribe(OWNER_ID, fakeRes);

    mockAuthedUser();
    mockOwnerEmailQuery();
    mockNewInsert();

    const res = await request(app)
      .post("/api/request-access")
      .send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(fakeRes.writes).toHaveLength(1);
    expect(fakeRes.writes[0]).toBe("event: changed\ndata: {}\n\n");

    fakeRes.close();
  });

  it("delivers event: changed to every subscribed owner when multiple owners are registered", async () => {
    const OWNER_ID_A = "owner_multi_aaa";
    const OWNER_ID_B = "owner_multi_bbb";

    const fakeResA = makeFakeRes();
    const fakeResB = makeFakeRes();
    subscribe(OWNER_ID_A, fakeResA);
    subscribe(OWNER_ID_B, fakeResB);

    mockAuthedUser();
    mockOwnerEmailQuery([OWNER_ID_A]);
    mockNewInsert();

    const res = await request(app)
      .post("/api/request-access")
      .send({ workspaceOwnerId: OWNER_ID_A });

    expect(res.status).toBe(200);
    expect(fakeResA.writes).toHaveLength(1);
    expect(fakeResA.writes[0]).toBe("event: changed\ndata: {}\n\n");
    expect(fakeResB.writes).toHaveLength(0);

    fakeResA.close();
    fakeResB.close();
  });

  it("does not deliver any event to a subscribed owner when the insert is a duplicate (409)", async () => {
    const fakeRes = makeFakeRes();
    subscribe(OWNER_ID, fakeRes);

    mockAuthedUser();
    mockOwnerEmailQuery();
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/api/request-access")
      .send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(409);
    expect(fakeRes.writes).toHaveLength(0);

    fakeRes.close();
  });

  it("still delivers event: changed even when email delivery fails", async () => {
    const fakeRes = makeFakeRes();
    subscribe(OWNER_ID, fakeRes);

    mockAuthedUser();
    mockOwnerEmailQuery();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockRejectedValueOnce(new Error("email error"));

    const res = await request(app)
      .post("/api/request-access")
      .send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(fakeRes.writes).toHaveLength(1);
    expect(fakeRes.writes[0]).toBe("event: changed\ndata: {}\n\n");

    fakeRes.close();
  });
});
