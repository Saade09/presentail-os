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

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceRole: "owner" | "member" = "member";
let stubUserId = "user_abc";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = "user@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import profileRouter from "./profile";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLog; warn: typeof mockReqLog; info: typeof mockReqLog } }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
    };
    next();
  });
  app.use(profileRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEMBER_ROW = {
  member_id: 1,
  phone: "+9611234567",
  job_title: "Engineer",
  birthday: "1990-05-15",
  gender: "male",
  notify_email_on_time_off_request: true,
  notify_email_on_time_off_decision: true,
  notify_email_on_new_sign_in: true,
  notify_email_on_new_order: true,
  notify_email_weekly_digest: true,
  working_days: null,
  department: "Engineering",
  location: "Beirut",
  employment_type: "full_time",
  employment_status: "active",
  start_date: "2022-01-01",
  manager_member_id: null,
  manager_name: null,
  role: "member",
  custom_role_id: null,
  custom_role_name: null,
  member_email: "user@example.com",
  ec_name: "Jane Doe",
  ec_relationship: "Spouse",
  ec_phone_country_code: "+961",
  ec_phone: "+9619876543",
};

const LOCATIONS_ROWS: { id: number; name: string }[] = [];

// ---------------------------------------------------------------------------
// GET /profile
// ---------------------------------------------------------------------------

describe("GET /profile", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("returns 200 with profile data including EC fields", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MEMBER_ROW] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp()).get("/profile");

    expect(res.status).toBe(200);
    expect(res.body.member_email).toBe("user@example.com");
    expect(res.body.ec_name).toBe("Jane Doe");
    expect(res.body.ec_relationship).toBe("Spouse");
    expect(res.body.ec_phone_country_code).toBe("+961");
    expect(res.body.ec_phone).toBe("+9619876543");
  });

  it("returns null EC fields when none saved", async () => {
    const rowWithoutEc = { ...MEMBER_ROW, ec_name: null, ec_relationship: null, ec_phone_country_code: null, ec_phone: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [rowWithoutEc] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp()).get("/profile");

    expect(res.status).toBe(200);
    expect(res.body.ec_name).toBeNull();
    expect(res.body.ec_relationship).toBeNull();
    expect(res.body.ec_phone_country_code).toBeNull();
    expect(res.body.ec_phone).toBeNull();
  });

  it("returns 404 when member not found", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get("/profile");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// PATCH /profile
// ---------------------------------------------------------------------------

describe("PATCH /profile", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  const EXISTING_ROW = {
    phone: null,
    job_title: null,
    birthday: null,
    gender: null,
    notify_email_on_time_off_request: true,
    notify_email_on_time_off_decision: true,
    notify_email_on_new_sign_in: true,
    notify_email_on_new_order: true,
    notify_email_weekly_digest: true,
    ec_name: null,
    ec_relationship: null,
    ec_phone_country_code: null,
    ec_phone: null,
  };

  it("accepts all EC fields as null without returning 400", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, ec_name: null, ec_relationship: null, ec_phone_country_code: null, ec_phone: null }] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({
        ec_name: null,
        ec_relationship: null,
        ec_phone_country_code: null,
        ec_phone: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.ec_name).toBeNull();
    expect(res.body.ec_relationship).toBeNull();
    expect(res.body.ec_phone_country_code).toBeNull();
    expect(res.body.ec_phone).toBeNull();
  });

  it("accepts ec_name only (no phone) without returning 400", async () => {
    const updatedMember = { ...MEMBER_ROW, ec_name: "Jane Doe", ec_relationship: null, ec_phone_country_code: null, ec_phone: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedMember] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({ ec_name: "Jane Doe", ec_relationship: null, ec_phone_country_code: null, ec_phone: null });

    expect(res.status).toBe(200);
    expect(res.body.ec_name).toBe("Jane Doe");
  });

  it("saves EC fields and returns updated profile", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [MEMBER_ROW] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({
        ec_name: "Jane Doe",
        ec_relationship: "Spouse",
        ec_phone_country_code: "+961",
        ec_phone: "+9619876543",
      });

    expect(res.status).toBe(200);
    expect(res.body.ec_name).toBe("Jane Doe");
    expect(res.body.ec_relationship).toBe("Spouse");
  });

  it("returns 400 when ec_phone is provided without ec_name", async () => {
    const res = await request(makeApp())
      .patch("/profile")
      .send({ ec_phone: "+9619876543" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it("returns 400 when ec_phone is provided without ec_relationship", async () => {
    const res = await request(makeApp())
      .patch("/profile")
      .send({ ec_name: "Jane Doe", ec_phone: "+9619876543" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/relationship is required/i);
  });

  it("saves other fields without touching EC if no EC fields provided", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, job_title: "Manager" }] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({ job_title: "Manager" });

    expect(res.status).toBe(200);
    expect(res.body.job_title).toBe("Manager");

    const updateCall = mockDbQuery.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE workspace_members");
  });

  it("returns 404 when member not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .patch("/profile")
      .send({ job_title: "Manager" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("updates notify_email_on_new_order and returns it", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, notify_email_on_new_order: false }] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({ notify_email_on_new_order: false });

    expect(res.status).toBe(200);
    expect(res.body.notify_email_on_new_order).toBe(false);

    const updateCall = mockDbQuery.mock.calls[1];
    expect(updateCall[0]).toContain("notify_email_on_new_order = $8");
    expect(updateCall[1][7]).toBe(false);
    // Weekly digest untouched — keeps the existing (true) value
    expect(updateCall[1][8]).toBe(true);
  });

  it("updates notify_email_weekly_digest and returns it", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_ROW] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, notify_email_weekly_digest: false }] })
      .mockResolvedValueOnce({ rows: LOCATIONS_ROWS });

    const res = await request(makeApp())
      .patch("/profile")
      .send({ notify_email_weekly_digest: false });

    expect(res.status).toBe(200);
    expect(res.body.notify_email_weekly_digest).toBe(false);

    const updateCall = mockDbQuery.mock.calls[1];
    expect(updateCall[0]).toContain("notify_email_weekly_digest = $9");
    expect(updateCall[1][8]).toBe(false);
    // New-order preference untouched — keeps the existing (true) value
    expect(updateCall[1][7]).toBe(true);
  });
});
