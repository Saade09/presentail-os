import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Intentionally do not mock apiKeyAuth: this proves the route has the real
// mandatory gate rather than merely relying on a test-only successful middleware.
vi.mock("../lib/db", () => ({ db: { query: vi.fn() } }));
vi.mock("../lib/objectStorage", () => ({
  buildPublicObjectUrl: (key: string | null) => key ? `https://public/${key}` : null,
}));
import router from "./realDeliveries";

describe("real deliveries API-key gate", () => {
  it("rejects requests without a workspace API key", async () => {
    const app = express();
    app.use(router);
    const res = await request(app).get("/storefront/real-deliveries?country=LB&city=beirut");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key/i);
  });
});