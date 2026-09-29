import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockUpsertContact = vi.fn();

vi.mock("../../lib/contactUpsert", () => ({
  upsertContact: (...args: unknown[]) => mockUpsertContact(...args),
}));

import contactsRouter from "./contacts";

const app = express();
app.use(express.json());
app.use("/api/v1", contactsRouter);

describe("POST /api/v1/contacts/upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates eligible contact creation to the shared upsert owner exactly once", async () => {
    mockUpsertContact.mockResolvedValueOnce("contact-1");

    const res = await request(app).post("/api/v1/contacts/upsert").send({
      workspace_owner_id: "workspace-1",
      first_name: "Rana",
      last_name: "K",
      phone: "+96170000001",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, id: "contact-1" });
    expect(mockUpsertContact).toHaveBeenCalledTimes(1);
    expect(mockUpsertContact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: "workspace-1",
        firstName: "Rana",
        lastName: "K",
        phone: "+96170000001",
      }),
    );
  });
});