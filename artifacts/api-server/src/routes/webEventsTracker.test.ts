import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import webEventsTrackerRouter from "./webEventsTracker";

function makeApp() {
  const app = express();
  app.use("/api", webEventsTrackerRouter);
  return app;
}

describe("GET /api/web-events/tracker.js", () => {
  it("serves the tracker script publicly with JS content type and caching", async () => {
    const res = await request(makeApp()).get("/api/web-events/tracker.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.headers["cache-control"]).toContain("max-age=3600");
    expect(res.text).toContain("window.PresentailAnalytics");
  });

  it("uses the canonical event-type names the analytics backend recognizes", async () => {
    const res = await request(makeApp()).get("/api/web-events/tracker.js");
    for (const type of [
      '"search"',
      '"search_no_result"',
      '"search_result_click"',
      '"category_click"',
      '"occasion_click"',
      '"filter_selected"',
      '"sort_selected"',
      '"recipient_selected"',
      '"brand_selected"',
      '"price_range_selected"',
    ]) {
      expect(res.text).toContain(type);
    }
  });

  it("sends the fields the Search & Discovery section reads", async () => {
    const res = await request(makeApp()).get("/api/web-events/tracker.js");
    for (const field of [
      "searchQuery",
      "resultCount",
      "sessionId",
      "visitorId",
      "filterType",
      "sortOption",
      "category",
      "occasion",
    ]) {
      expect(res.text).toContain(field);
    }
  });
});
