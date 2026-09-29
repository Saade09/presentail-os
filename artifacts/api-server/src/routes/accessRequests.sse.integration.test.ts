/**
 * Integration test: verifies that a live SSE subscriber receives the
 * "changed" event when a pending access request is approved or rejected.
 *
 * Unlike accessRequests.test.ts (which mocks accessRequestSse), this file
 * uses the REAL subscribe/broadcast implementation so the full pipeline is
 * exercised: route calls broadcast() → broadcast() writes to the registered
 * Response → the SSE client receives the event.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — everything EXCEPT accessRequestSse
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted to the top of the file, so top-level const
// variables are not yet initialised when the factory runs.  vi.hoisted()
// creates values that are hoisted alongside vi.mock, making them safe to
// reference inside factory callbacks.
const { mockDbQuery, mockClientQuery, mockClientRelease } = vi.hoisted(() => {
  const mockDbQuery = vi.fn();
  const mockClientQuery = vi.fn((...args: unknown[]) => mockDbQuery(...args));
  const mockClientRelease = vi.fn();
  return { mockDbQuery, mockClientQuery, mockClientRelease };
});

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    }),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/email", () => ({
  sendInviteEmail: vi.fn().mockResolvedValue(undefined),
  sendAccessRejectionEmail: vi.fn().mockResolvedValue(undefined),
}));

let stubWorkspaceOwnerId = "owner_sse_test";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubUserId = "user_sse_owner";
let stubUserEmail: string | null = "sse-owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import accessRequestsRouter from "./accessRequests";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROLE_ROW = { id: 7, name: "Designer" };
const PENDING_REQUEST = {
  id: 42,
  requester_clerk_id: "user_req_999",
  requester_email: "requester@example.com",
  requester_name: "Alice Smith",
  status: "pending",
  requested_at: "2024-06-01T10:00:00Z",
  resolved_at: null,
};
const MEMBER_ROW = {
  id: 99,
  email: "requester@example.com",
  role: "member",
  custom_role_id: 7,
  joined: false,
  joined_at: null,
  invited_at: "2024-06-01T12:00:00Z",
  invited_by_email: "sse-owner@example.com",
  manager_member_id: null,
  manager_email: null,
};
const REJECT_ROW = { id: 42, requester_email: "requester@example.com" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer() {
  const app = express();
  app.use(express.json());
  app.use(accessRequestsRouter);
  return http.createServer(app);
}

/**
 * Open a persistent SSE connection to the server.
 * Returns the accumulated response text and a handle to close the socket.
 */
function connectSse(
  server: http.Server,
  path: string,
): Promise<{ getText: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { host: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        resolve({
          getText: () => text,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * POST to the server and return the response status + body.
 */
function post(
  server: http.Server,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c.toString()));
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Wait until condition() returns true or timeout elapses. */
function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("SSE integration – real accessRequestSse module", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockImplementation((...args: unknown[]) => mockDbQuery(...args));
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_sse_test";
    stubUserId = "user_sse_owner";
    stubUserEmail = "sse-owner@example.com";

    server = makeServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("SSE subscriber receives 'changed' event after a pending request is approved", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [ROLE_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...PENDING_REQUEST }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [MEMBER_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const sse = await connectSse(server, "/access-requests/events");

    await waitFor(() => sse.getText().includes(": connected"));

    await post(server, "/access-requests/42/approve", { roleId: 7 });

    await waitFor(() => sse.getText().includes("event: changed"));

    expect(sse.getText()).toContain("event: changed");
    expect(sse.getText()).toContain("data: {}");

    sse.close();
  });

  it("SSE subscriber receives 'changed' event after a pending request is rejected", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [REJECT_ROW], rowCount: 1 });

    const sse = await connectSse(server, "/access-requests/events");

    await waitFor(() => sse.getText().includes(": connected"));

    await post(server, "/access-requests/42/reject", {});

    await waitFor(() => sse.getText().includes("event: changed"));

    expect(sse.getText()).toContain("event: changed");
    expect(sse.getText()).toContain("data: {}");

    sse.close();
  });

  it("SSE subscriber does not receive an event when the request is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const sse = await connectSse(server, "/access-requests/events");

    await waitFor(() => sse.getText().includes(": connected"));

    const initialText = sse.getText();
    await post(server, "/access-requests/999/reject", {});

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sse.getText()).toBe(initialText);

    sse.close();
  });
});
