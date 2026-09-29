import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockDbClientQuery = vi.fn((...args: unknown[]) => mockDbQuery(...args));
const mockDbClientRelease = vi.hoisted(() => vi.fn());
const mockProcessInvoiceAsync = vi.fn().mockResolvedValue(undefined);
const mockPersistInvoiceSource = vi.fn().mockResolvedValue("/objects/private/scanner-invoice");
const mockGetObjectEntityFile = vi.fn().mockResolvedValue({});
let stubWorkspaceOwnerId = "owner_1";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn().mockResolvedValue({
      query: (...args: unknown[]) => {
        const sql = String(args[0]);
        if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock")) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return mockDbClientQuery(...args);
      },
      release: mockDbClientRelease,
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" ||
    !!wreq.allowedPages?.includes(pageKey),
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/scannerAuth", () => ({
  requireScannerDevice: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const sreq = req as express.Request & {
      scannerStationId: number;
      scannerWorkspaceOwnerId: string;
      scannerEntityId: number | null;
      scannerEntityActive: boolean;
      scannerPairingCorrelationId: string | null;
      scannerStationName: string;
      scannerEntityName: string | null;
      scannerLocation: string | null;
    };
    sreq.scannerStationId = 7;
    sreq.scannerWorkspaceOwnerId = "owner_1";
    sreq.scannerEntityId =
      req.headers["x-test-no-entity"] === "1" ? null : 42;
    sreq.scannerEntityActive =
      req.headers["x-test-inactive-entity"] !== "1";
    sreq.scannerPairingCorrelationId = "11111111-1111-4111-8111-111111111111";
    sreq.scannerStationName = "HQ 2";
    sreq.scannerEntityName = "Presentail Lebanon";
    sreq.scannerLocation = "HQ";
    next();
  },
  scannerDevice: (req: express.Request) => req,
}));

vi.mock("./finance", () => ({
  persistInvoiceSource: (...args: unknown[]) => mockPersistInvoiceSource(...args),
  processInvoiceAsync: (...args: unknown[]) => mockProcessInvoiceAsync(...args),
}));

vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  objectStorageService: {
    getObjectEntityFile: (...args: unknown[]) => mockGetObjectEntityFile(...args),
  },
}));
vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import scannerRouter, {
  scannerDeviceRouter,
  scannerPublicRouter,
} from "./scanner";
import { broadcastEvent } from "../lib/eventsSse";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", scannerPublicRouter);
  app.use("/api", scannerDeviceRouter);
  app.use("/api", scannerRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubWorkspaceOwnerId = "owner_1";
  stubWorkspaceRole = "owner";
  stubAllowedPages = null;
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockGetObjectEntityFile.mockResolvedValue({});
  mockDbClientRelease.mockClear();
});

describe("scanner station entity contract", () => {
  it("lets an Invoice Scanners member list every station in their workspace", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["invoice-scanners"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 8, workspace_owner_id: "owner_1", name: "Member station" },
        { id: 7, workspace_owner_id: "owner_1", name: "Owner station" },
      ],
      rowCount: 2,
    });

    const res = await request(makeApp()).get("/api/scanner/stations");

    expect(res.status).toBe(200);
    expect(res.body.stations).toHaveLength(2);
    expect(res.body.stations.map((station: { id: number }) => station.id)).toEqual([8, 7]);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE ss\.workspace_owner_id = \$1/),
      ["owner_1"],
    );
  });

  it("keeps station creation bound to the member's resolved workspace", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["invoice-scanners"];
    stubWorkspaceOwnerId = "workspace_2";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 9,
          workspace_owner_id: "workspace_2",
          name: "Finance scanner",
          default_entity_id: 42,
          default_entity_name: "Workspace Two",
        }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/api/scanner/stations")
      .send({ name: "Finance scanner", default_entity_id: 42, location: "HQ" });

    expect(res.status).toBe(201);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([42, "workspace_2"]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual(["workspace_2", "Finance scanner", 42, "HQ"]);
  });

  it("allows owners to manage stations without a page grant", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = [];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).get("/api/scanner/stations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stations: [] });
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/WHERE ss\.workspace_owner_id = \$1/),
      ["owner_1"],
    );
  });

  it("uses the Invoice Scanners permission for every station control", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["devices"];

    const responses = await Promise.all([
      request(makeApp()).get("/api/scanner/stations"),
      request(makeApp()).post("/api/scanner/stations"),
      request(makeApp()).patch("/api/scanner/stations/7").send({ name: "Updated" }),
      request(makeApp()).delete("/api/scanner/stations/7"),
      request(makeApp()).post("/api/scanner/stations/7/pairing-code"),
      request(makeApp()).post("/api/scanner/stations/7/revoke"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    for (const response of responses) {
      expect(response.body).toEqual({ error: "Invoice Scanners access required" });
    }
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("persists and returns default_entity_id when creating a station", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          name: "Reception",
          default_entity_id: 42,
          default_entity_name: "Presentail UAE",
        }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/api/scanner/stations")
      .send({ name: "Reception", default_entity_id: 42, location: "Dubai" });

    expect(res.status).toBe(201);
    expect(res.body.station).toMatchObject({
      default_entity_id: 42,
      default_entity_name: "Presentail UAE",
    });
    expect(mockDbQuery.mock.calls[1][1]).toEqual(["owner_1", "Reception", 42, "Dubai"]);
  });

  it("persists the edited default entity and returns the standardized shape", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, name: "Reception" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 43 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          default_entity_id: 43,
          default_entity_name: "Presentail Lebanon",
        }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .patch("/api/scanner/stations/7")
      .send({ default_entity_id: 43 });

    expect(res.status).toBe(200);
    expect(res.body.station.default_entity_id).toBe(43);
    expect(mockDbQuery.mock.calls[2][1]).toEqual([43, 7, "owner_1"]);
  });

  it("requires a default entity before creating or generating a pairing code", async () => {
    const create = await request(makeApp())
      .post("/api/scanner/stations")
      .send({ name: "Legacy scanner" });
    expect(create.status).toBe(400);
    expect(create.body.error).toMatch(/default_entity_id is required/i);

    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 7,
        entity_id: null,
        status: "active",
        default_entity_active: false,
      }],
      rowCount: 1,
    });
    const code = await request(makeApp())
      .post("/api/scanner/stations/7/pairing-code");
    expect(code.status).toBe(409);
    expect(code.body.error).toMatch(/select an active default entity/i);
  });

  it("blocks pairing-code generation for disabled or inactive stations", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 7,
        entity_id: 42,
        status: "disabled",
        default_entity_active: true,
      }],
      rowCount: 1,
    });
    const disabled = await request(makeApp())
      .post("/api/scanner/stations/7/pairing-code");

    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 7,
        entity_id: 42,
        status: "active",
        default_entity_active: false,
      }],
      rowCount: 1,
    });
    const inactive = await request(makeApp())
      .post("/api/scanner/stations/7/pairing-code");

    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe("SCANNER_STATION_DISABLED");
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe("SCANNER_CONFIGURATION_REQUIRED");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });
});

describe("scanner pairing, heartbeat, and first upload", () => {
  it("uses a one-time code and returns the configured default entity", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          station_id: 7,
          workspace_owner_id: "owner_1",
          name: "Reception",
          default_entity_id: 42,
          default_entity_name: "Presentail UAE",
          location: "Dubai",
          result: "accepted",
          correlation_id: "11111111-1111-4111-8111-111111111111",
          credential_issued_at: "2026-09-01T10:00:00.000Z",
        }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/api/scanner/pair")
      .send({ code: "abcd2345", device_info: { hostname: "SCAN-PC" } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: "accepted",
      correlation_id: "11111111-1111-4111-8111-111111111111",
      credential: {
        token_type: "Bearer",
        issued_at: "2026-09-01T10:00:00.000Z",
        expires_at: null,
      },
    });
    expect(res.body.credential.token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.station).toMatchObject({
      default_entity_id: 42,
      default_entity_name: "Presentail UAE",
    });
    expect(mockDbQuery.mock.calls[0][1][0]).toBe("ABCD2345");
    expect(mockDbQuery.mock.calls[0][0]).toMatch(/UPDATE scanner_pairing_codes/);
    expect(mockDbQuery.mock.calls[0][0]).toMatch(/INSERT INTO scanner_device_tokens/);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("allows only one successful redemption of a one-time code", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          station_id: 7,
          workspace_owner_id: "owner_1",
          name: "Reception",
          default_entity_id: 42,
          default_entity_name: "Presentail UAE",
          location: "Dubai",
          result: "accepted",
          correlation_id: "11111111-1111-4111-8111-111111111111",
          credential_issued_at: "2026-09-01T10:00:00.000Z",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          station_id: 7,
          workspace_owner_id: "owner_1",
          name: "Reception",
          default_entity_id: 42,
          default_entity_name: "Presentail UAE",
          location: "Dubai",
          result: "used_code",
          correlation_id: "11111111-1111-4111-8111-111111111111",
          credential_issued_at: null,
        }],
        rowCount: 1,
      });

    const [first, second] = await Promise.all([
      request(makeApp()).post("/api/scanner/pair").send({ code: "ONETIME2" }),
      request(makeApp()).post("/api/scanner/pair").send({ code: "ONETIME2" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 410]);
    expect(
      [first.body, second.body].filter((body) => body.credential?.token),
    ).toHaveLength(1);
    expect([first.body.result, second.body.result].sort()).toEqual([
      "accepted",
      "used_code",
    ]);
  });

  it.each([
    ["expired_code", 410],
    ["used_code", 410],
    ["station_disabled", 403],
    ["inactive_entity", 409],
  ] as const)("returns the stable %s pairing result", async (result, status) => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        result,
        correlation_id: "22222222-2222-4222-8222-222222222222",
        station_id: 7,
        workspace_owner_id: "owner_1",
        name: "HQ 2",
        default_entity_id: result === "inactive_entity" ? null : 42,
        default_entity_name: result === "inactive_entity" ? null : "Presentail Lebanon",
        location: "HQ",
        credential_issued_at: null,
      }],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/api/scanner/pair")
      .send({ code: "ABCDEFGH" });

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({
      result,
      correlation_id: "22222222-2222-4222-8222-222222222222",
    });
    expect(res.body.credential).toBeUndefined();
  });

  it("distinguishes missing and unknown pairing codes", async () => {
    const missing = await request(makeApp()).post("/api/scanner/pair").send({});
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const invalid = await request(makeApp())
      .post("/api/scanner/pair")
      .send({ code: "UNKNOWN2" });

    expect(missing.status).toBe(400);
    expect(missing.body.result).toBe("missing_code");
    expect(invalid.status).toBe(400);
    expect(invalid.body.result).toBe("invalid_code");
  });

  it("records the first heartbeat so the station becomes connected", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/scanner/heartbeat")
      .send({ agent_version: "1.0.0", queued_count: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      station_id: 7,
      correlation_id: "11111111-1111-4111-8111-111111111111",
      station: {
        id: 7,
        name: "HQ 2",
        default_entity_id: 42,
        default_entity_name: "Presentail Lebanon",
        location: "HQ",
      },
    });
    expect(mockDbQuery.mock.calls[0][0]).toMatch(/last_seen_at = now/);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["1.0.0", 2, 7]);
  });

  it("rejects heartbeat when the default entity is missing or inactive", async () => {
    const missing = await request(makeApp())
      .patch("/api/scanner/heartbeat")
      .set("x-test-no-entity", "1")
      .send({ agent_version: "1.0.1" });
    const inactive = await request(makeApp())
      .patch("/api/scanner/heartbeat")
      .set("x-test-inactive-entity", "1")
      .send({ agent_version: "1.0.1" });

    expect(missing.status).toBe(409);
    expect(inactive.status).toBe(409);
    expect(missing.body.code).toBe("SCANNER_CONFIGURATION_REQUIRED");
    expect(inactive.body.error).toMatch(/select an active entity.*re-pair/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["PDF", Buffer.from("%PDF-1.4 extensionless scanner invoice"), "application/pdf"],
    ["JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), "image/jpeg"],
    [
      "PNG",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "image/png",
    ],
  ] as const)("accepts an extensionless generic-MIME %s scan by its content", async (
    _label,
    buffer,
    expectedMime,
  ) => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 101 }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .field("captured_at", "2026-09-02T10:00:00.000Z")
      .field("original_filename", "scan-from-agent")
      .field("sha256", "agent-calculated-value")
      .field("agent_version", "1.0.3")
      .attach("file", buffer, {
        filename: "scan-from-agent",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(202);
    expect(res.body.import_id).toBe(101);
    expect(mockDbQuery.mock.calls[2][1][1]).toBe(42);
    expect(mockProcessInvoiceAsync).toHaveBeenCalledWith(
      101,
      { buffer, mimeType: expectedMime },
      { id: 42, legal_name: "Presentail UAE", is_active: true },
      "owner_1",
      true,
    );
    expect(mockPersistInvoiceSource).toHaveBeenCalledWith(
      101,
      { originalname: "scan-from-agent", buffer },
      expectedMime,
      "owner_1",
    );
    expect(broadcastEvent).toHaveBeenCalledWith("owner_1", expect.objectContaining({
      event: "finance.scanner_import.created",
      data: expect.objectContaining({
        importId: 101,
        stationId: 7,
        filename: "scan-from-agent",
      }),
    }));
  });

  it("rejects unsupported generic-MIME content before creating an import", async () => {
    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", Buffer.from("not a PDF, JPEG, or PNG"), {
        filename: "scan-from-agent",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Unsupported file type" });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockProcessInvoiceAsync).not.toHaveBeenCalled();
  });

  it("returns a retryable failure instead of extracting when scanner source storage fails", async () => {
    const buffer = Buffer.from("%PDF-1.4 scanner invoice");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 102 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPersistInvoiceSource.mockRejectedValueOnce(new Error("storage unavailable"));

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", buffer, {
        filename: "scanner-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      import_id: 102,
      retryable: true,
      error: "Source document storage failed. Scanner will retry.",
    });
    expect(mockProcessInvoiceAsync).not.toHaveBeenCalled();
    expect(String(mockDbQuery.mock.calls[3][0])).toContain("source_storage_failed");
  });

  it("repairs a duplicate scanner import whose source attachment was never stored", async () => {
    const buffer = Buffer.from("%PDF-1.4 scanner invoice");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 103, pdf_storage_path: null }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", buffer, {
        filename: "scanner-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(202);
    expect(res.body.import_id).toBe(103);
    expect(mockPersistInvoiceSource).toHaveBeenCalledWith(
      103,
      { originalname: "scanner-invoice.pdf", buffer },
      "application/pdf",
      "owner_1",
    );
    expect(mockProcessInvoiceAsync).toHaveBeenCalledWith(
      103,
      { buffer, mimeType: "application/pdf" },
      { id: 42, legal_name: "Presentail UAE", is_active: true },
      "owner_1",
      true,
    );
  });

  it("returns a verified duplicate only when its referenced source object exists", async () => {
    const buffer = Buffer.from("%PDF-1.4 scanner invoice");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 104, pdf_storage_path: "/objects/owner_1/uploads/existing" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", buffer, {
        filename: "scanner-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      import_id: 104,
      duplicate: true,
      source_verified: true,
    });
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith("/objects/owner_1/uploads/existing");
    expect(mockPersistInvoiceSource).not.toHaveBeenCalled();
    expect(mockProcessInvoiceAsync).not.toHaveBeenCalled();
  });

  it("repairs a duplicate scanner import whose referenced source object is missing", async () => {
    const buffer = Buffer.from("%PDF-1.4 scanner invoice");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 105, pdf_storage_path: "/objects/owner_1/uploads/missing" }],
        rowCount: 1,
      });
    const { ObjectNotFoundError } = await import("../lib/objectStorage");
    mockGetObjectEntityFile.mockRejectedValueOnce(new ObjectNotFoundError());

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", buffer, {
        filename: "scanner-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ import_id: 105, source_stored: true });
    expect(mockPersistInvoiceSource).toHaveBeenCalledWith(
      105,
      { originalname: "scanner-invoice.pdf", buffer },
      "application/pdf",
      "owner_1",
    );
    expect(mockProcessInvoiceAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps a duplicate queued when source verification is temporarily unavailable", async () => {
    const buffer = Buffer.from("%PDF-1.4 scanner invoice");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, legal_name: "Presentail UAE", is_active: true }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 106, pdf_storage_path: "/objects/owner_1/uploads/existing" }],
        rowCount: 1,
      });
    mockGetObjectEntityFile.mockRejectedValueOnce(new Error("storage timeout"));

    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", buffer, {
        filename: "scanner-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      import_id: 106,
      retryable: true,
      error: "Source document could not be verified. Scanner will retry.",
    });
    expect(mockPersistInvoiceSource).not.toHaveBeenCalled();
    expect(mockProcessInvoiceAsync).not.toHaveBeenCalled();
    expect(mockDbClientRelease).toHaveBeenCalled();
  });

  it("rejects content that does not match a supported filename or MIME type", async () => {
    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .attach("file", Buffer.from("not a PDF"), {
        filename: "renamed-invoice.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "File content does not match its declared type",
    });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockProcessInvoiceAsync).not.toHaveBeenCalled();
  });

  it("rejects uploads without an entity with corrective guidance", async () => {
    const res = await request(makeApp())
      .post("/api/scanner/upload")
      .set("x-test-no-entity", "1")
      .attach("file", Buffer.from("%PDF-1.4 test invoice"), {
        filename: "first-scan.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/edit the station.*select an active entity.*re-pair/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});