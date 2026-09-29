import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../../../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockLoadAdapterRegistry = vi.fn();

vi.mock("../../../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../../../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../../lib/credentialEncryption", () => ({
  encrypt: (v: string) => `enc:${v}`,
  isEncrypted: (v: string) => v.startsWith("enc:"),
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

let stubWorkspaceOwnerId = "owner_test";

vi.mock("../omnichannelAuth", () => ({
  requireOmnichannelRole: (_role: string) => [
    (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const wreq = req as unknown as WorkspaceRequest;
      wreq.workspaceOwnerId = stubWorkspaceOwnerId;
      wreq.workspaceRole = "owner";
      wreq.workspaceActualRole = "owner";
      next();
    },
  ],
}));

vi.mock("../adapters/adapterRegistry", () => ({
  loadAdapterRegistry: (...args: unknown[]) => mockLoadAdapterRegistry(...args),
  getMockAdapter: vi.fn().mockReturnValue({
    getCapabilities: () => ({ supportsText: true, supportsImage: true }),
  }),
}));

import channelsRouter from "./channelsRouter";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, typeof mockReqLog> }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
    };
    next();
  });
  app.use(channelsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_test",
    provider: "whatsapp",
    name: "Test Channel",
    external_account_id: null,
    access_token: null,
    refresh_token: null,
    webhook_verify_token: "verify_abc",
    status: "disconnected",
    last_webhook_received_at: null,
    last_outbound_send_at: null,
    last_error: null,
    is_active: true,
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PATCH /omnichannel/channels/:id — adapter registry reload behaviour
// ---------------------------------------------------------------------------

describe("PATCH /omnichannel/channels/:id — adapter registry reload", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_test";
    // loadAdapterRegistry must return a Promise so .catch() doesn't throw
    mockLoadAdapterRegistry.mockResolvedValue(undefined);
    // Default DB fallback (should not be reached in happy-path tests)
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("calls loadAdapterRegistry when access_token is patched", async () => {
    const channelRow = makeChannelRow();
    // First DB call: getChannelRow SELECT
    mockDbQuery.mockResolvedValueOnce({ rows: [channelRow] });
    // Second DB call: UPDATE RETURNING
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...channelRow, access_token: "enc:new_token" }] });

    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ access_token: "new_token" });

    expect(res.status).toBe(200);
    expect(mockLoadAdapterRegistry).toHaveBeenCalledTimes(1);
  });

  it("calls loadAdapterRegistry when status is set to 'connected'", async () => {
    const channelRow = makeChannelRow();
    mockDbQuery.mockResolvedValueOnce({ rows: [channelRow] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...channelRow, status: "connected" }] });

    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ status: "connected" });

    expect(res.status).toBe(200);
    expect(mockLoadAdapterRegistry).toHaveBeenCalledTimes(1);
  });

  it("does NOT call loadAdapterRegistry for a name-only patch", async () => {
    const channelRow = makeChannelRow();
    mockDbQuery.mockResolvedValueOnce({ rows: [channelRow] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...channelRow, name: "Renamed Channel" }] });

    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ name: "Renamed Channel" });

    expect(res.status).toBe(200);
    expect(mockLoadAdapterRegistry).not.toHaveBeenCalled();
  });

  it("does NOT call loadAdapterRegistry when status is set to a non-connected value", async () => {
    const channelRow = makeChannelRow({ status: "connected" });
    mockDbQuery.mockResolvedValueOnce({ rows: [channelRow] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...channelRow, status: "disconnected" }] });

    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ status: "disconnected" });

    expect(res.status).toBe(200);
    expect(mockLoadAdapterRegistry).not.toHaveBeenCalled();
  });

  it("calls loadAdapterRegistry when access_token is patched alongside a name change", async () => {
    const channelRow = makeChannelRow();
    mockDbQuery.mockResolvedValueOnce({ rows: [channelRow] });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...channelRow, name: "Renamed", access_token: "enc:new_token" }],
    });

    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ name: "Renamed", access_token: "new_token" });

    expect(res.status).toBe(200);
    expect(mockLoadAdapterRegistry).toHaveBeenCalledTimes(1);
  });

  it("returns 404 and does not call loadAdapterRegistry when channel is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch("/omnichannel/channels/999")
      .send({ access_token: "new_token" });

    expect(res.status).toBe(404);
    expect(mockLoadAdapterRegistry).not.toHaveBeenCalled();
  });

  it("returns 400 and does not call loadAdapterRegistry for invalid status values", async () => {
    const res = await request(app)
      .patch("/omnichannel/channels/1")
      .send({ status: "invalid_status" });

    expect(res.status).toBe(400);
    expect(mockLoadAdapterRegistry).not.toHaveBeenCalled();
  });
});
