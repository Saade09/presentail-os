import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockDbConnect(),
  },
  withTransaction: vi.fn(async (_client: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("multer", () => {
  const multerMock = () => ({
    single: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    array: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    fields: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    none: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  });
  multerMock.memoryStorage = () => ({});
  return { default: multerMock };
});

const mockImageSize = vi.fn();
vi.mock("image-size", () => ({
  imageSize: (...args: unknown[]) => mockImageSize(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import brandsRouter from "./brands";

// ---------------------------------------------------------------------------
// Test apps
// ---------------------------------------------------------------------------

function silentLog(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
    error: () => {},
    warn: () => {},
    info: () => {},
  };
  next();
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(silentLog);
  app.use(brandsRouter);
  return app;
}

/** App that injects a fake square 300×300 PNG file so the route proceeds past the file checks. */
function makeAppWithFile() {
  const fakeFile: Express.Multer.File = {
    fieldname: "logo",
    originalname: "logo.png",
    encoding: "7bit",
    mimetype: "image/png",
    buffer: Buffer.from("fake"),
    size: 4,
    stream: Readable.from([]),
    destination: "",
    filename: "",
    path: "",
  };
  const app = express();
  app.use(express.json());
  app.use(silentLog);
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).file = fakeFile;
    next();
  });
  app.use(brandsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// POST /brands — whitespace-only name validation
// ---------------------------------------------------------------------------

describe("POST /brands — name validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 400 when name is all spaces", async () => {
    const res = await request(app)
      .post("/brands")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is a tab character", async () => {
    const res = await request(app)
      .post("/brands")
      .send({ name: "\t" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is a mix of spaces, tabs, and newlines", async () => {
    const res = await request(app)
      .post("/brands")
      .send({ name: "  \t\n  " });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is an empty string", async () => {
    const res = await request(app)
      .post("/brands")
      .send({ name: "" });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("returns 400 when name is omitted", async () => {
    const res = await request(app)
      .post("/brands")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error", "name is required");
  });

  it("does not make any DB calls when name is whitespace-only", async () => {
    await request(app)
      .post("/brands")
      .send({ name: "   " });

    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is a non-owner member without brands.create permission", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .post("/brands")
      .send({ name: "   " });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /brands — duplicate name check (409)
// ---------------------------------------------------------------------------

describe("POST /brands — duplicate name check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";

    mockImageSize.mockReturnValue({ width: 300, height: 300 });
  });

  it("returns 409 when a brand with the exact same name already exists", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 });

    const app = makeAppWithFile();
    const res = await request(app)
      .post("/brands")
      .send({ name: "Acme Brand" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error", "A brand with this name already exists");
  });

  it("returns 409 when a brand with the same name exists in a different case", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 });

    const app = makeAppWithFile();
    const res = await request(app)
      .post("/brands")
      .send({ name: "ACME BRAND" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error", "A brand with this name already exists");
  });

  it("does not return 409 when no brand with that name exists", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    mockClientQuery.mockResolvedValue({
      rows: [
        {
          id: 42,
          name: "New Brand",
          description: null,
          target_cogs: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });
    mockClientRelease.mockReturnValue(undefined);
    mockDbConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    });

    const app = makeAppWithFile();
    const res = await request(app)
      .post("/brands")
      .send({ name: "New Brand" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("brand");
  });

  it("passes the workspace owner ID and trimmed name to the duplicate-check query", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 });

    const app = makeAppWithFile();
    await request(app)
      .post("/brands")
      .send({ name: "  Acme Brand  " });

    const duplicateCheckCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /lower\(name\)/i.test(sql),
    );
    expect(duplicateCheckCall).toBeDefined();
    expect(duplicateCheckCall![1]).toContain("owner_123");
    expect(duplicateCheckCall![1]).toContain("Acme Brand");
    expect(duplicateCheckCall![1]).not.toContain("  Acme Brand  ");
  });
});

// ---------------------------------------------------------------------------
// POST /brands — trimmed name is stored and accepted on creation
// ---------------------------------------------------------------------------

describe("POST /brands — trimmed name acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";

    mockImageSize.mockReturnValue({ width: 300, height: 300 });

    mockClientQuery.mockResolvedValue({
      rows: [
        {
          id: 42,
          name: "Acme Brand",
          description: null,
          target_cogs: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      rowCount: 1,
    });
    mockClientRelease.mockReturnValue(undefined);
    mockDbConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    });

    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("accepts a name with surrounding whitespace and stores the trimmed value", async () => {
    const app = makeAppWithFile();

    const res = await request(app)
      .post("/brands")
      .send({ name: "  Acme Brand  " });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("brand");
    expect(res.body.brand.name).toBe("Acme Brand");

    const insertCall = mockClientQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO brands/i.test(sql),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]).toContain("Acme Brand");
    expect(insertCall![1]).not.toContain("  Acme Brand  ");
  });
});
