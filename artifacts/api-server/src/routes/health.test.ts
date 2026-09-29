import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_REVERIFICATION_WORKER_REVISION,
  API_BUILD_ID,
} from "../lib/buildInfo";
import { merchantExecutionScopeStatus } from "../lib/merchantExecutionScope";
import healthRouter from "./health";

describe("GET /healthz", () => {
  it("exposes the public API source-build marker", async () => {
    const app = express();
    app.use(healthRouter);

    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      buildId: API_BUILD_ID,
      addressReverificationWorkerRevision: ADDRESS_REVERIFICATION_WORKER_REVISION,
      merchantExecution: merchantExecutionScopeStatus(),
    });
  });
});