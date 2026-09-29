import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

import { requireScannerDevice, scannerDevice } from "./scannerAuth";

function makeApp() {
  const app = express();
  app.get("/device", requireScannerDevice, (req, res) => {
    const sreq = scannerDevice(req);
    res.json({
      stationId: sreq.scannerStationId,
      entityId: sreq.scannerEntityId,
      entityActive: sreq.scannerEntityActive,
    });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scanner device authentication status contract", () => {
  it("reports a revoked credential without exposing its value", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const token = "secret-device-token";
    const res = await request(makeApp())
      .get("/device")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Invalid or revoked scanner token",
      code: "SCANNER_TOKEN_REVOKED",
    });
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(mockDbQuery.mock.calls[0][1][0]).not.toBe(token);
  });

  it("distinguishes a disabled station from a revoked credential", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        station_id: 7,
        workspace_owner_id: "owner_1",
        entity_id: 42,
        status: "disabled",
        entity_active: true,
      }],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .get("/device")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SCANNER_STATION_DISABLED");
  });

  it("passes default-entity status to the heartbeat and upload routes", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        station_id: 7,
        workspace_owner_id: "owner_1",
        entity_id: 42,
        status: "active",
        entity_active: false,
      }],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .get("/device")
      .set("Authorization", "Bearer valid-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stationId: 7,
      entityId: 42,
      entityActive: false,
    });
  });
});