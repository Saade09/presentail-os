// Unit tests for the manual gender override on PATCH /api/contacts/:id (task #3165).

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
  withTransaction: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user_abc";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueueGenderInference = vi.fn();
vi.mock("../lib/genderInference", () => ({
  queueGenderInference: (...args: unknown[]) => mockQueueGenderInference(...args),
}));

const mockSyncContactToRespondIo = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/contactUpsert", () => ({
  syncContactToRespondIo: (...args: unknown[]) => mockSyncContactToRespondIo(...args),
}));

import contactsRouter from "./contactsDashboard.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", contactsRouter);
  return app;
}

describe("PATCH /api/contacts/:id — gender override", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockQueueGenderInference.mockReset();
    mockSyncContactToRespondIo.mockReset();
    mockSyncContactToRespondIo.mockResolvedValue(undefined);
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE contacts")) {
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      if (sql.includes("SELECT gender FROM contacts")) {
        return Promise.resolve({ rows: [{ gender: "male" }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  it("sets gender manually with gender_source='manual' and null confidence", async () => {
    const res = await request(buildApp())
      .patch("/api/contacts/11111111-1111-4111-8111-111111111111")
      .send({ gender: "female" });
    expect(res.status).toBe(200);

    const update = mockDbQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE contacts"));
    expect(update).toBeDefined();
    const sql = String(update![0]);
    expect(sql).toContain("gender_source = 'manual'");
    expect(sql).toContain("gender_confidence = NULL");
    expect(update![1]).toContain("female");

    // logs a gender_updated activity row with old + new values
    const activity = mockDbQuery.mock.calls.find(
      (c) =>
        String(c[0]).includes("INSERT INTO contact_activity") &&
        (c[1] as unknown[])[2] === "gender_updated",
    );
    expect(activity).toBeDefined();
    expect(JSON.parse(String((activity![1] as unknown[])[5]))).toEqual({
      old: "male",
      new: "female",
    });

    // manual override must NOT queue re-inference
    expect(mockQueueGenderInference).not.toHaveBeenCalled();
  });

  it("rejects invalid gender values", async () => {
    const res = await request(buildApp())
      .patch("/api/contacts/11111111-1111-4111-8111-111111111111")
      .send({ gender: "other" });
    expect(res.status).toBe(400);
    expect(mockDbQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE contacts"))).toBe(
      false,
    );
  });

  it("queues re-inference when the name changes without a gender override", async () => {
    const res = await request(buildApp())
      .patch("/api/contacts/11111111-1111-4111-8111-111111111111")
      .send({ first_name: "Nour" });
    expect(res.status).toBe(200);
    expect(mockQueueGenderInference).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("queues re-inference when the phone (country context) changes", async () => {
    const res = await request(buildApp())
      .patch("/api/contacts/11111111-1111-4111-8111-111111111111")
      .send({ phone: "+971501234567" });
    expect(res.status).toBe(200);
    expect(mockQueueGenderInference).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockSyncContactToRespondIo).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("does not queue re-inference on unrelated edits", async () => {
    const res = await request(buildApp())
      .patch("/api/contacts/11111111-1111-4111-8111-111111111111")
      .send({ email: "a@b.co" });
    expect(res.status).toBe(200);
    expect(mockQueueGenderInference).not.toHaveBeenCalled();
  });

  it("uses the shared sync owner for a manual Respond.io link", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, phone, first_name, last_name, respondio_contact_id")) {
        return Promise.resolve({
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            phone: "+96170000001",
            first_name: "Rana",
            last_name: "K",
            respondio_contact_id: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    mockSyncContactToRespondIo.mockResolvedValueOnce({
      status: "synced",
      contactId: "respondio-1",
    });

    const res = await request(buildApp())
      .post("/api/contacts/11111111-1111-4111-8111-111111111111/respondio-sync");

    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe("respondio-1");
    expect(mockSyncContactToRespondIo).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });
});
