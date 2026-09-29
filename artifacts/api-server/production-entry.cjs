// This file is the production-only entrypoint. Set the runtime mode here rather
// than relying exclusively on deployment env injection: security-sensitive
// middleware, cookies, routes, and CORS policy all branch on NODE_ENV.
process.env.NODE_ENV = "production";

const http = require("node:http");
const { logTiming } = require("../../scripts/publish-timing.cjs");

const processStartedAt = Date.now();
// Keep in sync with src/lib/buildInfo.ts. This bootstrap serves the liveness
// endpoints before the Express bundle has loaded, so the marker must exist in
// both paths.
const API_BUILD_ID = "address-reverification-recovery-2026-09-15-v2";
const ADDRESS_REVERIFICATION_WORKER_REVISION =
  "nullable-worker-and-pin-clear-casts-pause-recovery-2026-09-15-v2";
const executionScope = process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE?.trim() || null;
const executionEnabled =
  process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED === "true";
const merchantExecution = {
  executionEnabled,
  scopeConfigured: executionScope !== null,
  scopeName: executionScope,
  lbCreateOnlyEnforced:
    executionEnabled && executionScope === "LB_CREATE_ONLY",
  lbCreateAndUpdateEnforced:
    executionEnabled && executionScope === "LB_CREATE_AND_UPDATE",
};
const trustedPresentailOrigins = new Set([
  "https://os.presentail.com",
  "https://www.os.presentail.com",
  "https://presentail.com",
  "https://www.presentail.com",
]);
const configuredOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function bootstrapCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!trustedPresentailOrigins.has(origin) && !configuredOrigins.has(origin)) {
    return null;
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}
logTiming("api-server", "process_start", "start", undefined, {
  pid: process.pid,
});
globalThis.__PRESENTAIL_API_PROCESS_STARTED_AT__ = processStartedAt;
let firstHealthCheckLogged = false;

function publishPhase(phase, status, elapsedMs, extra = {}) {
  console.log(
    JSON.stringify({
      schema: "presentail.publish.v1",
      event: "publish.phase",
      timestamp: new Date().toISOString(),
      phase,
      status,
      elapsedMs,
      cacheStatus: "not-applicable",
      ...extra,
    }),
  );
}

publishPhase("startup", "started", 0);

const rawPort = process.env.PORT;
const port = Number(rawPort);

if (!rawPort || !Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid or missing PORT: ${rawPort || "<missing>"}`);
}

let requestHandler = (req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;

  if (pathname === "/api/healthz" || pathname === "/api" || pathname === "/api/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      buildId: API_BUILD_ID,
      addressReverificationWorkerRevision: ADDRESS_REVERIFICATION_WORKER_REVISION,
      merchantExecution,
    }));
    return;
  }

  const corsHeaders = bootstrapCorsHeaders(req);
  if (corsHeaders === null) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      '{"error":"Request origin is not allowed.","code":"CORS_ORIGIN_DENIED"}',
    );
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders,
      "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
      "access-control-allow-headers":
        req.headers["access-control-request-headers"] || "authorization,content-type",
    });
    res.end();
    return;
  }

  res.writeHead(503, {
    ...corsHeaders,
    "content-type": "application/json",
    "retry-after": "1",
  });
  res.end(
    '{"error":"API startup is still in progress.","code":"startup_in_progress"}',
  );
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/api/healthz" || pathname === "/api" || pathname === "/api/") {
    const healthRequestStartedAt = Date.now();
    if (!firstHealthCheckLogged) {
      firstHealthCheckLogged = true;
      publishPhase("health-check", "completed", Date.now() - processStartedAt, {
        readiness: "port-bound",
      });
    }
    res.once("finish", () => {
      logTiming(
        "api-server",
        "health_response",
        "complete",
        healthRequestStartedAt,
        { endpoint: "/api/healthz", status_code: res.statusCode },
      );
    });
  }
  return requestHandler(req, res);
});
const portBindingStartedAt = Date.now();
logTiming("api-server", "port_binding", "start", portBindingStartedAt, {
  port,
});

server.on("error", (error) => {
  logTiming("api-server", "port_binding", "complete", portBindingStartedAt, {
    status: "failed",
    error_code: error.code || "unknown",
  });
  console.error(
    `[PORT DEBUG] LISTEN ERROR artifact=api-server code=${error.code || "unknown"} message=${error.message}`,
  );
});

console.log("[PORT DEBUG] artifact=api-server");
console.log(`[PORT DEBUG] process.env.PORT=${rawPort}`);
console.log(`[PORT DEBUG] calling listen host=0.0.0.0 port=${port}`);

server.listen(port, "0.0.0.0", () => {
  logTiming("api-server", "port_binding", "complete", portBindingStartedAt, {
    status: "success",
    port,
  });
  publishPhase("startup:port-bind", "completed", Date.now() - processStartedAt);
  console.log(`[PORT DEBUG] LISTENING artifact=api-server host=0.0.0.0 port=${port}`);
  // Start parsing the large bundle only after the OS confirms the deployment
  // port is bound. On low-CPU cold starts, parsing it earlier can block the
  // listen callback until after Replit's runnable-port deadline.
  const bundleLoadStartedAt = Date.now();
  logTiming("api-server", "bundle_loading", "start", bundleLoadStartedAt);
  import("./dist/index.mjs")
    .then(({ app }) => {
      if (typeof app !== "function") {
        throw new TypeError("The API bundle did not export an Express application.");
      }
      requestHandler = app;
      logTiming("api-server", "bundle_loading", "complete", bundleLoadStartedAt, {
        status: "success",
      });
      console.log(
        `[PORT DEBUG] API READY artifact=api-server bundleLoadMs=${Date.now() - bundleLoadStartedAt}`,
      );
      publishPhase("startup", "completed", Date.now() - processStartedAt, {
        bundleLoadMs: Date.now() - bundleLoadStartedAt,
      });
    })
    .catch((error) => {
      logTiming("api-server", "bundle_loading", "complete", bundleLoadStartedAt, {
        status: "failed",
      });
      console.error("[PORT DEBUG] API LOAD ERROR artifact=api-server", error);
      server.close(() => {
        process.exitCode = 1;
      });
    });
});

globalThis.__PRESENTAIL_API_HTTP_SERVER__ = server;