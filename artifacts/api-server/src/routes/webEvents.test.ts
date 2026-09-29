import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { mockDbQuery } = vi.hoisted(() => ({ mockDbQuery: vi.fn() }));

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { userId: string }).userId = "owner_abc";
    (req as unknown as { log: unknown }).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
    };
    next();
  },
}));

import webEventsRouter from "./webEvents";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", webEventsRouter);
  return app;
}

/** Extract the inserted row's search_query value from the single multi-row INSERT. */
function insertedSearchQuery(callIndex = 0): unknown {
  const [sql, values] = mockDbQuery.mock.calls[callIndex] as [string, unknown[]];
  const cols = sql.match(/INSERT INTO web_events \(([^)]+)\)/)?.[1]?.split(", ") ?? [];
  return values[cols.indexOf("search_query")];
}

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe("POST /api/web-events search-term mapping", () => {
  it("maps a term-like property into search_query for search events", async () => {
    const res = await request(makeApp())
      .post("/api/web-events")
      .send({ type: "search", properties: { query: "  red roses " } });
    expect(res.status).toBe(201);
    expect(insertedSearchQuery()).toBe("red roses");
  });

  it("supports alternate term keys (search_term, q) and no_result types", async () => {
    const res = await request(makeApp())
      .post("/api/web-events")
      .send({
        events: [
          { type: "search_no_result", search_term: "tulips" },
          { type: "search_performed", properties: { q: "lilies" } },
        ],
      });
    expect(res.status).toBe(201);
    const [sql, values] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const cols = sql.match(/INSERT INTO web_events \(([^)]+)\)/)?.[1]?.split(", ") ?? [];
    const idx = cols.indexOf("search_query");
    const rowLen = cols.length;
    expect(values[idx]).toBe("tulips");
    expect(values[rowLen + idx]).toBe("lilies");
  });

  it("does not override an explicit top-level searchQuery", async () => {
    await request(makeApp())
      .post("/api/web-events")
      .send({ type: "search", searchQuery: "peonies", properties: { query: "other" } });
    expect(insertedSearchQuery()).toBe("peonies");
  });

  it("does not map term-like properties on non-search events", async () => {
    await request(makeApp())
      .post("/api/web-events")
      .send({ type: "filter_selected", properties: { q: "not-a-search" } });
    expect(insertedSearchQuery()).toBeNull();
  });
});
