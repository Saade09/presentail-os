import { readFileSync } from "fs";
import { resolve } from "path";
import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  ADDRESS_REVERIFICATION_WORKER_REVISION,
  API_BUILD_ID,
} from "../lib/buildInfo";
import { merchantExecutionScopeStatus } from "../lib/merchantExecutionScope";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({
    ...data,
    buildId: API_BUILD_ID,
    addressReverificationWorkerRevision: ADDRESS_REVERIFICATION_WORKER_REVISION,
    merchantExecution: merchantExecutionScopeStatus(),
  });
});

router.get("/openapi.yaml", (_req, res) => {
  try {
    const specPath = resolve(
      new URL(import.meta.url).pathname,
      "../../../../lib/api-spec/openapi.yaml",
    );
    const spec = readFileSync(specPath, "utf-8");
    res.setHeader("Content-Type", "application/yaml");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(spec);
  } catch (err) {
    logger.warn({ err }, "Could not read openapi.yaml");
    res.status(404).json({ error: "Spec not found" });
  }
});

export default router;
