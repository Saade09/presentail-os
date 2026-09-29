import request from "supertest";
import { describe, expect, it } from "vitest";
import app from "./app";

const PRODUCTION_ORIGIN = "https://os.presentail.com";

describe("shared production request middleware", () => {
  const mutationMatrix = [
    ["POST", "/api/products"],
    ["PATCH", "/api/products/123"],
    ["PUT", "/api/products/123/city-availability"],
    ["DELETE", "/api/products/123"],
    ["POST", "/api/finance/invoice-review/123/approve"],
    ["POST", "/api/finance/invoice-review/123/sync"],
    ["PATCH", "/api/finance/invoice-review/123/draft"],
    ["DELETE", "/api/finance/ai-invoice-import/imports/123"],
    ["POST", "/api/cash-sessions"],
    ["PATCH", "/api/florist-orders/123/assign"],
    ["POST", "/api/workspace/image-token"],
    ["POST", "/api/team/invitations"],
  ] as const;

  it.each(mutationMatrix)(
    "accepts production-origin preflight for %s %s",
    async (method, path) => {
      const response = await request(app)
        .options(path)
        .set("Origin", PRODUCTION_ORIGIN)
        .set("Access-Control-Request-Method", method)
        .set(
          "Access-Control-Request-Headers",
          "authorization,content-type",
        );

      expect(response.status).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(
        PRODUCTION_ORIGIN,
      );
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-methods"]).toContain(method);
    },
  );

  it("rejects an unknown origin with a specific 403 instead of a generic 500", async () => {
    const response = await request(app)
      .post("/api/products")
      .set("Origin", "https://attacker.example")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: "Request origin is not allowed.",
      code: "CORS_ORIGIN_DENIED",
    });
  });

  it("preserves the browser Origin when forwarded proxy headers are present", async () => {
    const response = await request(app)
      .post("/api/products")
      .set("Origin", PRODUCTION_ORIGIN)
      .set("X-Forwarded-Host", "os.presentail.com")
      .set("X-Forwarded-Proto", "https")
      .send({});

    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(
      PRODUCTION_ORIGIN,
    );
    expect(response.body.error).toBe("Unauthorized");
  });

  it("returns a specific 400 for malformed JSON before route execution", async () => {
    const response = await request(app)
      .post("/api/products")
      .set("Origin", PRODUCTION_ORIGIN)
      .set("Content-Type", "application/json")
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_JSON");
  });

  it("returns a specific 413 for an oversized JSON body", async () => {
    const response = await request(app)
      .post("/api/products")
      .set("Origin", PRODUCTION_ORIGIN)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ payload: "x".repeat(110_000) }));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("REQUEST_BODY_TOO_LARGE");
  });
});