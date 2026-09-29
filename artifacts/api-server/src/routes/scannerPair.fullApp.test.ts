import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const CLERK_ERROR = { error: "Unauthorized" };

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      res.status(401).json(CLERK_ERROR);
    },
  getAuth: vi.fn(),
  clerkClient: { users: { getUser: vi.fn() } },
}));

const mockDbQuery = vi.fn();
const mockProcessInvoiceAsync = vi.fn().mockResolvedValue(undefined);
const mockPersistInvoiceSource = vi.fn().mockResolvedValue("/objects/private/full-app-scan");

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn().mockResolvedValue({
      query: (...args: unknown[]) => {
        const sql = String(args[0]);
        if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock")) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return mockDbQuery(...args);
      },
      release: vi.fn(),
    }),
  },
  withTransaction: vi.fn(),
}));

vi.mock("./finance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./finance")>();
  return {
    ...actual,
    persistInvoiceSource: (...args: unknown[]) => mockPersistInvoiceSource(...args),
    processInvoiceAsync: (...args: unknown[]) => mockProcessInvoiceAsync(...args),
  };
});

import app from "../app";

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("scanner machine authentication through the full app", () => {
  it("reaches pairing-code validation before Clerk authentication", async () => {
    const res = await request(app)
      .post("/api/scanner/pair")
      .send({ code: "ZZZZZZZZ", device_info: { agent_version: "test" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Pairing code was not recognized.");
    expect(res.body).not.toEqual(CLERK_ERROR);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("pairs, accepts the immediate 1.0.3 heartbeat, and uploads before Clerk", async () => {
    mockDbQuery.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("WITH candidate AS")) {
        return {
          rows: [{
            result: "accepted",
            correlation_id: "11111111-1111-4111-8111-111111111111",
            station_id: 7,
            workspace_owner_id: "owner_1",
            name: "Reception",
            default_entity_id: 42,
            default_entity_name: "Presentail UAE",
            location: "Dubai",
            credential_issued_at: "2026-09-01T10:00:00.000Z",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM scanner_device_tokens sdt")) {
        return {
          rows: [{
            station_id: 7,
            workspace_owner_id: "owner_1",
            entity_id: 42,
            status: "active",
            entity_active: true,
            pairing_correlation_id: "11111111-1111-4111-8111-111111111111",
            station_name: "Reception",
            entity_name: "Presentail UAE",
            location: "Dubai",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO ai_invoice_imports")) {
        return { rows: [{ id: 101 }], rowCount: 1 };
      }
      if (sql.includes("UPDATE scanner_stations")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const paired = await request(app)
      .post("/api/scanner/pair")
      .send({ code: "ABCD2345", device_info: { agent_version: "1.0.3" } });
    expect(paired.status).toBe(200);
    expect(paired.body.credential.token).toMatch(/^[a-f0-9]{64}$/);

    const heartbeat = await request(app)
      .patch("/api/scanner/heartbeat")
      .set("Authorization", `Bearer ${paired.body.credential.token}`)
      .send({ agent_version: "1.0.3", queued_count: 0 });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toMatchObject({
      ok: true,
      station_id: 7,
      station: { default_entity_id: 42 },
    });
    const heartbeatUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE scanner_stations"),
    );
    expect(heartbeatUpdate?.[1]).toEqual(["1.0.3", 0, 7]);

    const upload = await request(app)
      .post("/api/scanner/upload")
      .set("Authorization", `Bearer ${paired.body.credential.token}`)
      .field("captured_at", "2026-09-02T10:00:00.000Z")
      .field("original_filename", "invoice-from-1.0.3")
      .field("sha256", "agent-calculated-value")
      .field("agent_version", "1.0.3")
      .attach("file", Buffer.from("%PDF-1.4 full app scanner test"), {
        filename: "invoice-from-1.0.3",
        contentType: "application/octet-stream",
      });
    expect(upload.status).toBe(202);
    expect(upload.body.import_id).toBe(101);
    expect(mockPersistInvoiceSource).toHaveBeenCalled();
    expect(mockProcessInvoiceAsync).toHaveBeenCalled();
    expect(mockPersistInvoiceSource.mock.invocationCallOrder[0]).toBeLessThan(
      mockProcessInvoiceAsync.mock.invocationCallOrder[0],
    );
    expect(heartbeat.body).not.toEqual(CLERK_ERROR);
    expect(upload.body).not.toEqual(CLERK_ERROR);
  });

  it("rejects invalid scanner tokens in scanner authentication before Clerk", async () => {
    const res = await request(app)
      .patch("/api/scanner/heartbeat")
      .set("Authorization", "Bearer revoked-scanner-token")
      .send({ agent_version: "1.0.2", queued_count: 0 });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Invalid or revoked scanner token",
      code: "SCANNER_TOKEN_REVOKED",
    });
    expect(res.body).not.toEqual(CLERK_ERROR);
    expect(String(mockDbQuery.mock.calls[0]?.[0])).toContain(
      "FROM scanner_device_tokens sdt",
    );
  });

  it("keeps scanner management and normal API routes behind Clerk", async () => {
    const scannerManagement = await request(app).get("/api/scanner/stations");
    const res = await request(app).get("/api/request-access");

    expect(scannerManagement.status).toBe(401);
    expect(scannerManagement.body).toEqual(CLERK_ERROR);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CLERK_ERROR);
  });
});