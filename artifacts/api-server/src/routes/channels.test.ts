import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("image-size", () => ({
  imageSize: vi.fn().mockReturnValue({ width: 100, height: 100 }),
}));

vi.mock("sharp", () => ({
  default: vi.fn().mockReturnValue({
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("resized-logo")),
  }),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubCustomRoleId: number | null = null;
let stubAllowedPages: string[] | null | undefined = undefined;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.customRoleId = stubCustomRoleId;
    wreq.allowedPages = stubAllowedPages as string[] | null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import channelsRouter from "./channels";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(channelsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// GET /channels
// ---------------------------------------------------------------------------

describe("GET /channels", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
  });

  it("returns 200 with channels array on success", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Online Store",
          has_cover_photo: true,
          cover_photo_width: 1920,
          cover_photo_height: 1080,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("channels");
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].name).toBe("Online Store");
  });

  it("returns 200 with empty array when no channels exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          // id should be a number — string here triggers Zod failure
          id: "not-a-number",
          name: "Bad Row",
          has_cover_photo: true,
          cover_photo_width: 1920,
          cover_photo_height: 1080,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /channels", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

// ---------------------------------------------------------------------------
// GET /channels — access filtering by role
// ---------------------------------------------------------------------------

describe("GET /channels — access filtering by role", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubCustomRoleId = null;
    stubAllowedPages = undefined;
  });

  it("owner always gets all channels regardless of role_channel_access", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Retail", has_cover_photo: true, cover_photo_width: 1920, cover_photo_height: 1080, has_logo: false, created_at: "2024-01-01T00:00:00Z" },
        { id: 2, name: "Online Store", has_cover_photo: false, cover_photo_width: null, cover_photo_height: null, has_logo: false, created_at: "2024-01-02T00:00:00Z" },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(2);
    expect(res.body.channels.map((c: { name: string }) => c.name)).toEqual(["Retail", "Online Store"]);
  });

  it("owner query uses workspace_owner_id and does not join role_channel_access", async () => {
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "ws_owner_abc";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/channels");

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_owner_abc");
    expect((sql as string).toUpperCase()).not.toContain("ROLE_CHANNEL_ACCESS");
  });

  it("member with no custom role gets an empty channel list without querying the DB", async () => {
    stubActualRole = "member";
    stubCustomRoleId = null;

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("member with a custom role gets only the channels granted to that role", async () => {
    stubActualRole = "member";
    stubCustomRoleId = 7;
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "Wholesale", has_cover_photo: true, cover_photo_width: 800, cover_photo_height: 600, has_logo: false, created_at: "2024-01-03T00:00:00Z" },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].name).toBe("Wholesale");
  });

  it("member query passes customRoleId and workspaceOwnerId to the role-filtered SQL", async () => {
    stubActualRole = "member";
    stubCustomRoleId = 42;
    stubWorkspaceOwnerId = "ws_member_owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/channels");

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain(42);
    expect(params).toContain("ws_member_owner");
    expect((sql as string).toUpperCase()).toContain("ROLE_CHANNEL_ACCESS");
  });

  it("member with channels.manage gets all channels without a ROLE_CHANNEL_ACCESS join", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Retail", has_cover_photo: false, cover_photo_width: null, cover_photo_height: null, has_logo: false, created_at: "2024-01-01T00:00:00Z" },
        { id: 2, name: "Wholesale", has_cover_photo: true, cover_photo_width: 1920, cover_photo_height: 1080, has_logo: false, created_at: "2024-01-02T00:00:00Z" },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(2);
    const [sql] = mockDbQuery.mock.calls[0];
    expect((sql as string).toUpperCase()).not.toContain("ROLE_CHANNEL_ACCESS");
  });

  it("member with channels.manage but without channels in allowedPages still gets full list", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage", "brands"];
    stubCustomRoleId = 5;
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 3, name: "Online Store", has_cover_photo: false, cover_photo_width: null, cover_photo_height: null, has_logo: false, created_at: "2024-01-03T00:00:00Z" },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    const [sql] = mockDbQuery.mock.calls[0];
    expect((sql as string).toUpperCase()).not.toContain("ROLE_CHANNEL_ACCESS");
  });

  it("member without channels.manage falls back to role-scoped query", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    stubCustomRoleId = 9;
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "Retail", has_cover_photo: false, cover_photo_width: null, cover_photo_height: null, has_logo: false, created_at: "2024-01-01T00:00:00Z" },
      ],
    });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    const [sql] = mockDbQuery.mock.calls[0];
    expect((sql as string).toUpperCase()).toContain("ROLE_CHANNEL_ACCESS");
  });

  it("member gets no channels when their role's channel access entries belong to a different workspace", async () => {
    stubActualRole = "member";
    stubCustomRoleId = 7;
    stubWorkspaceOwnerId = "ws_current_workspace";
    // The JOIN filters by c.workspace_owner_id = workspaceOwnerId, so channels from
    // another workspace are excluded even if role_channel_access has entries for them.
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/channels");

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
    // Confirm the query was issued with the correct workspace scoping
    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_current_workspace");
  });
});

// ---------------------------------------------------------------------------
// POST /channels
// ---------------------------------------------------------------------------

describe("POST /channels — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
  });

  it("returns 403 for members without channels.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    mockDbQuery.mockImplementation(() => new Promise(() => {}));
    const res = await request(app)
      .post("/channels")
      .send({ name: "Test", has_cover_photo: false });

    expect(res.status).toBe(403);
  });

  it("returns 403 for members with no allowedPages at all", async () => {
    stubActualRole = "member";
    stubAllowedPages = undefined;
    const res = await request(app)
      .post("/channels")
      .send({ name: "Test", has_cover_photo: false });

    expect(res.status).toBe(403);
  });

  it("allows members with channels.manage to create a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          name: "Member Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels")
      .send({ name: "Member Channel", has_cover_photo: false });

    expect(res.status).toBe(201);
    expect(res.body.channel.name).toBe("Member Channel");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ has_cover_photo: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when has_cover_photo=true but width is missing", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_height: 1080 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_width/i);
  });

  it("returns 400 when has_cover_photo=true but height is missing", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: 1920 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_height/i);
  });

  it("returns 400 when has_cover_photo=true and width is zero", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: 0, cover_photo_height: 1080 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_width/i);
  });

  it("returns 400 when has_cover_photo=true and width is negative", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: -100, cover_photo_height: 1080 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_width/i);
  });

  it("returns 400 when has_cover_photo=true and width is a non-numeric string", async () => {
    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: "abc", cover_photo_height: 1080 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_width/i);
  });

  it("returns 409 on name conflict", async () => {
    // name-check query returns one existing row
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });

    const res = await request(app)
      .post("/channels")
      .send({ name: "Duplicate", has_cover_photo: false });

    expect(res.status).toBe(409);
  });

  it("creates a channel without cover photo (has_cover_photo=false)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          name: "Retail",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels")
      .send({ name: "Retail", has_cover_photo: false });

    expect(res.status).toBe(201);
    expect(res.body.channel.name).toBe("Retail");
    expect(res.body.channel.has_cover_photo).toBe(false);
  });

  it("creates a channel with cover photo and valid dimensions", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 3,
          name: "Online Store",
          has_cover_photo: true,
          cover_photo_width: 1920,
          cover_photo_height: 1080,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: 1920, cover_photo_height: 1080 });

    expect(res.status).toBe(201);
    expect(res.body.channel.cover_photo_width).toBe(1920);
    expect(res.body.channel.cover_photo_height).toBe(1080);
  });

  it("returns 400 when logo has an invalid mime type (text/plain)", async () => {
    const textBuffer = Buffer.from("this is not an image");

    const res = await request(app)
      .post("/channels")
      .field("name", "Bad Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", textBuffer, { filename: "logo.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  it("returns 400 when logo has an invalid mime type (application/pdf)", async () => {
    const pdfBuffer = Buffer.from("%PDF-1.4 fake pdf content");

    const res = await request(app)
      .post("/channels")
      .field("name", "PDF Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", pdfBuffer, { filename: "logo.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  it("creates a channel with a logo: has_logo is true and the INSERT receives non-null logo_data", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no name conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 4,
          name: "Logo Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: true,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    // Minimal valid 1×1 PNG buffer — image-size and sharp are mocked above.
    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .post("/channels")
      .field("name", "Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.channel.has_logo).toBe(true);

    // The INSERT query (2nd DB call) must pass non-null logo_data ($6, index 5).
    const [insertSql, insertParams] = mockDbQuery.mock.calls[1];
    expect((insertSql as string).toLowerCase()).toContain("logo_data");
    const logoDataParam = (insertParams as unknown[])[5]; // $6 logo_data
    expect(logoDataParam).not.toBeNull();
    expect(Buffer.isBuffer(logoDataParam)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PUT /channels/:id
// ---------------------------------------------------------------------------

describe("PUT /channels/:id — validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
  });

  it("returns 403 for members without channels.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Test", has_cover_photo: false });

    expect(res.status).toBe(403);
  });

  it("allows members with channels.manage to update a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Updated Name",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Updated Name", has_cover_photo: false });

    expect(res.status).toBe(200);
    expect(res.body.channel.name).toBe("Updated Name");
  });

  it("returns 400 when has_cover_photo=true but width is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_height: 1080 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_width/i);
  });

  it("returns 400 when has_cover_photo=true but height is missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Online Store", has_cover_photo: true, cover_photo_width: 1920 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cover_photo_height/i);
  });

  it("returns 404 when channel does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not found
    const res = await request(app)
      .put("/channels/999")
      .send({ name: "X", has_cover_photo: false });

    expect(res.status).toBe(404);
  });

  it("updates a channel successfully", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Renamed",
          has_cover_photo: true,
          cover_photo_width: 800,
          cover_photo_height: 600,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Renamed", has_cover_photo: true, cover_photo_width: 800, cover_photo_height: 600 });

    expect(res.status).toBe(200);
    expect(res.body.channel.name).toBe("Renamed");
  });

  it("remove_logo=true clears the logo: has_logo is false in the response and the UPDATE sets logo_data to NULL", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "My Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1")
      .send({ name: "My Channel", has_cover_photo: false, remove_logo: "true" });

    expect(res.status).toBe(200);
    expect(res.body.channel.has_logo).toBe(false);

    // The UPDATE query (3rd call) must include logo_data/logo_mime_type columns
    // and pass NULL for both at the exact param positions ($5/$6).
    const [updateSql, updateParams] = mockDbQuery.mock.calls[2];
    expect((updateSql as string).toLowerCase()).toContain("logo_data");
    expect((updateParams as unknown[])[4]).toBeNull(); // $5 logo_data
    expect((updateParams as unknown[])[5]).toBeNull(); // $6 logo_mime_type
  });

  it("returns 400 when logo has an invalid mime type (text/plain)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    const textBuffer = Buffer.from("this is not an image");

    const res = await request(app)
      .put("/channels/1")
      .field("name", "Bad Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", textBuffer, { filename: "logo.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  it("returns 400 when logo has an invalid mime type (application/pdf)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    const pdfBuffer = Buffer.from("%PDF-1.4 fake pdf content");

    const res = await request(app)
      .put("/channels/1")
      .field("name", "PDF Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", pdfBuffer, { filename: "logo.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/jpeg|png|webp/i);
  });

  it("uploading a new logo takes precedence over remove_logo=true", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // exists
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no conflict
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "My Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: true,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    // Minimal 1×1 PNG so multer parses the multipart request successfully.
    // image-size and sharp are mocked above (100×100, small enough to skip resize).
    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .put("/channels/1")
      .field("name", "My Channel")
      .field("has_cover_photo", "false")
      .field("remove_logo", "true")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    // A new logo was uploaded so has_logo should be true in the DB response.
    expect(res.body.channel.has_logo).toBe(true);

    // The UPDATE must include logo_data with a non-null value (the uploaded logo bytes).
    const [updateSql, updateParams] = mockDbQuery.mock.calls[2];
    expect((updateSql as string).toLowerCase()).toContain("logo_data");
    const logoDataParam = (updateParams as unknown[])[4]; // 5th param: logo_data
    expect(logoDataParam).not.toBeNull();
    expect(Buffer.isBuffer(logoDataParam)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DELETE /channels/:id
// ---------------------------------------------------------------------------

describe("DELETE /channels/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubAllowedPages = undefined;
  });

  it("returns 403 for members without channels.manage permission", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(403);
  });

  it("returns 403 for members with no allowedPages at all", async () => {
    stubActualRole = "member";
    stubAllowedPages = undefined;
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(403);
  });

  it("allows members with channels.manage to delete a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.manage"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when channel not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).delete("/channels/999");
    expect(res.status).toBe(404);
  });

  it("returns 200 and ok:true on success", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-permission: channels.create
// ---------------------------------------------------------------------------

describe("POST /channels — channels.create sub-permission", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = undefined;
  });

  it("returns 403 for member without channels.manage or channels.create", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    const res = await request(app)
      .post("/channels")
      .send({ name: "Test", has_cover_photo: false });
    expect(res.status).toBe(403);
  });

  it("allows member with channels.create to create a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.create"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          name: "New Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .post("/channels")
      .send({ name: "New Channel", has_cover_photo: false });

    expect(res.status).toBe(201);
    expect(res.body.channel.name).toBe("New Channel");
  });

  it("returns 403 when member with channels.create tries to upload a logo without channels.manage-logo", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.create"];

    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .post("/channels")
      .field("name", "Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/logo/i);
  });

  it("allows member with channels.create and channels.manage-logo to upload a logo", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.create", "channels.manage-logo"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 12,
          name: "Logo Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: true,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .post("/channels")
      .field("name", "Logo Channel")
      .field("has_cover_photo", "false")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.channel.has_logo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-permission: channels.edit
// ---------------------------------------------------------------------------

describe("PUT /channels/:id — channels.edit sub-permission", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = undefined;
  });

  it("returns 403 for member without channels.manage or channels.edit", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Test", has_cover_photo: false });
    expect(res.status).toBe(403);
  });

  it("allows member with channels.edit to update a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.edit"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "Edited Name",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: false,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const res = await request(app)
      .put("/channels/1")
      .send({ name: "Edited Name", has_cover_photo: false });

    expect(res.status).toBe(200);
    expect(res.body.channel.name).toBe("Edited Name");
  });

  it("returns 403 when member with channels.edit tries to upload a logo without channels.manage-logo", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.edit"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .put("/channels/1")
      .field("name", "My Channel")
      .field("has_cover_photo", "false")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/logo/i);
  });

  it("allows member with channels.edit and channels.manage-logo to upload a logo", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.edit", "channels.manage-logo"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          name: "My Channel",
          has_cover_photo: false,
          cover_photo_width: null,
          cover_photo_height: null,
          has_logo: true,
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    });

    const minimalPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
      "2e000000000c4944415478016360f8cfc000000002000171dd3831000000000" +
      "049454e44ae426082",
      "hex",
    );

    const res = await request(app)
      .put("/channels/1")
      .field("name", "My Channel")
      .field("has_cover_photo", "false")
      .attach("logo", minimalPng, { filename: "logo.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.channel.has_logo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-permission: channels.delete
// ---------------------------------------------------------------------------

describe("DELETE /channels/:id — channels.delete sub-permission", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = undefined;
  });

  it("returns 403 for member without channels.manage or channels.delete", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["brands", "products"];
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(403);
  });

  it("allows member with channels.delete to delete a channel", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["channels.delete"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/channels/1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
