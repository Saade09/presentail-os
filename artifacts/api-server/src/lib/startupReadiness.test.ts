import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markDatabaseReady,
  markDatabaseStarting,
  startupReadinessGate,
} from "./startupReadiness";

afterEach(() => {
  markDatabaseReady();
});

describe("startupReadinessGate", () => {
  const protectedRouteMatrix = [
    ["get", "/api/orders"],
    ["post", "/api/orders/manual"],
    ["patch", "/api/orders/123"],
    ["get", "/api/products"],
    ["post", "/api/products"],
    ["patch", "/api/products/123"],
    ["put", "/api/products/123/city-availability"],
    ["delete", "/api/products/123"],
    ["post", "/api/finance/invoice-review/123/approve"],
    ["patch", "/api/finance/invoice-review/123/draft"],
    ["delete", "/api/finance/ai-invoice-import/imports/123"],
    ["post", "/api/cash-sessions"],
    ["patch", "/api/florist-orders/123/assign"],
    ["post", "/api/team/invitations"],
    ["patch", "/api/locations/123"],
    ["post", "/api/payment-links"],
    ["post", "/api/web-events"],
    ["patch", "/api/scanner/heartbeat"],
  ] as const;

  it.each(protectedRouteMatrix)(
    "blocks %s %s before any application handler executes",
    async (method, path) => {
      markDatabaseStarting();
      const handler = vi.fn((_req, res) => {
        res.status(200).json({ reached: true });
      });
      const app = express();
      app.use(startupReadinessGate);
      app[method](path, handler);

      const response = await request(app)[method](path).send({});

      expect(response.status).toBe(503);
      expect(response.body.code).toBe("startup_in_progress");
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("returns a clear 503 before an API handler can run", async () => {
    markDatabaseStarting();
    const app = express();
    app.use(startupReadinessGate);
    app.post("/api/orders", (_req, res) => {
      res.status(201).json({ created: true });
    });

    const response = await request(app).post("/api/orders").send({});

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.headers["x-presentail-startup"]).toBe("pending");
    expect(response.body).toEqual({
      error: "System update in progress. Please retry in a moment.",
      code: "startup_in_progress",
    });
  });

  it("allows API handlers only after database startup completes", async () => {
    markDatabaseStarting();
    markDatabaseReady();
    const app = express();
    app.use(startupReadinessGate);
    app.patch("/api/products/123", (_req, res) => {
      res.status(200).json({ updated: true });
    });

    const response = await request(app).patch("/api/products/123").send({});

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: true });
  });

  it.each([
    ["get", "/api/healthz"],
    ["head", "/api/healthz"],
    ["get", "/api"],
    ["get", "/api/"],
  ] as const)(
    "keeps the deployment liveness probe healthy during database startup for %s %s requests",
    async (method, path) => {
      markDatabaseStarting();
      const handler = vi.fn((_req, res) => {
        res.status(200).json({ status: "ok" });
      });
      const app = express();
      app.use(startupReadinessGate);
      app[method](path, handler);

      const response = await request(app)[method](path);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("does not expose the health-check exception to non-liveness methods", async () => {
    markDatabaseStarting();
    const handler = vi.fn((_req, res) => {
      res.status(200).json({ status: "ok" });
    });
    const app = express();
    app.use(startupReadinessGate);
    app.post("/api/healthz", handler);

    const response = await request(app).post("/api/healthz").send({});

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("startup_in_progress");
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not block CORS preflight requests", async () => {
    markDatabaseStarting();
    const app = express();
    app.use(startupReadinessGate);
    app.options("/api/products", (_req, res) => {
      res.sendStatus(204);
    });

    const response = await request(app).options("/api/products");

    expect(response.status).toBe(204);
  });
});