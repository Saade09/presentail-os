import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const TRANSCRIPT_SCHEMA = "presentail.publish.transcript.v1";
export const COMPARISON_PHASES = [
  "artifact-build",
  "chromium-preparation",
  "upload",
  "image-push",
  "startup",
  "mobile-readiness",
  "other",
];

const PUBLISH_ID_KEYS = new Set(["publishid", "publish_id", "correlationid", "correlation_id"]);
const DEPLOYMENT_ID_KEYS = new Set(["deploymentid", "deployment_id"]);

function keyName(key) {
  return String(key).replace(/[-\s]/g, "_").toLowerCase();
}

export function correlationId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (/^sha256:[a-f0-9]{32}$/.test(normalized)) return normalized;
  if (!normalized || normalized.length > 1_024) return null;
  return `sha256:${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

function firstValue(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return null;
  for (const [key, value] of Object.entries(object)) {
    if (keys.has(keyName(key)) && value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function redactText(value) {
  let text = String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");

  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/\-=]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|whsec|tpk|tps)_(?:live|test)?[_-]?[A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(
      /(https?:\/\/[^\s?]+)\?[^\s]+/gi,
      "$1?[redacted query]",
    );

  if (
    /[{\[].*[}\]]/.test(text)
  ) {
    text = text.replace(/[{\[].*[}\]]/g, "[redacted structured details]");
  }

  const sensitiveDetails = /(?:^|\s)([A-Za-z0-9_.-]*(?:payload|request|response|headers?|cookie|authorization|credential|secret|token|password|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]/i;
  const sensitiveMatch = text.match(sensitiveDetails);
  if (sensitiveMatch) {
    const start = sensitiveMatch.index ?? 0;
    const prefix = text.slice(0, start).trimEnd();
    return `${prefix}${prefix ? " " : ""}[redacted ${sensitiveMatch[1].toLowerCase()}]`;
  }
  return text.trim();
}

function parseDuration(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  const number = Number.parseFloat(text.replace(",", "."));
  if (!Number.isFinite(number) || number < 0) return null;
  if (text.endsWith("ms")) return Math.round(number);
  if (text.endsWith("s")) return Math.round(number * 1000);
  if (text.endsWith("m")) return Math.round(number * 60_000);
  return Math.round(number);
}

function parseTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonicalPhase(value, text = "") {
  const source = `${value || ""} ${text}`.toLowerCase().replace(/[_:]/g, " ");
  if (source.includes("chromium") || source.includes("browser")) return "chromium-preparation";
  if (source.includes("image push") || source.includes("push image") || source.includes("image-push")) {
    return "image-push";
  }
  if (source.includes("upload")) return "upload";
  if (
    source.includes("mobile") &&
    (source.includes("readiness") || source.includes("ready") || source.includes("health"))
  ) {
    return "mobile-readiness";
  }
  if (source.includes("startup") || source.includes("start up") || source.includes("boot") || source.includes("port bind")) {
    return "startup";
  }
  if (source.includes("artifact build") || source.includes("artifact") || source.includes("build")) {
    return "artifact-build";
  }
  return "other";
}

function canonicalService(value, text = "") {
  const source = `${value || ""} ${text}`.toLowerCase();
  if (source.includes("os-mobile") || source.includes("os mobile")) return "os-mobile";
  if (source.includes("pos")) return "pos";
  if (source.includes("api")) return "api-server";
  if (source.includes("web") || source.includes("print-agent")) return "print-agent-web";
  if (source.includes("artifact")) return "artifact";
  return null;
}

function statusValue(value, text = "") {
  const source = `${value || ""} ${text}`.toLowerCase();
  if (/\b(fail|error|failed)\b/.test(source)) return "failed";
  if (/\b(success|complete|completed|done|ready)\b/.test(source)) return "completed";
  if (/\b(skip|skipped)\b/.test(source)) return "skipped";
  if (/\b(running|in progress)\b/.test(source)) return "running";
  if (/\b(start|begin|running)\b/.test(source)) return "started";
  return null;
}

function cacheStatus(value, text = "") {
  const source = `${value || ""} ${text}`.toLowerCase();
  if (/\b(cache[- ]hit|cached|reus(?:e|ed)|already available)\b/.test(source)) return "hit";
  if (/\b(cache[- ]miss|install(?:ing)?|download(?:ing)?|not cached)\b/.test(source)) return "miss";
  if (/\b(not[- ]applicable|n\/a)\b/.test(source)) return "not-applicable";
  return null;
}

function textFields(line) {
  const fields = {};
  const keyValuePattern = /([A-Za-z][A-Za-z0-9_.:-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of line.matchAll(keyValuePattern)) {
    fields[match[1]] = match[2] ?? match[3] ?? match[4];
  }
  return fields;
}

function metadataFromText(value) {
  const fields = textFields(value);
  return {
    publishId: correlationId(firstValue(fields, PUBLISH_ID_KEYS)),
    deploymentId: correlationId(firstValue(fields, DEPLOYMENT_ID_KEYS)),
  };
}

function normalizeRecord(input, sequence, lineNumber) {
  const object = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const metadata =
    typeof input === "string" ? metadataFromText(input) : metadataFrom(object);
  const messageValue =
    object.message ??
    object.msg ??
    object.line ??
    (typeof input === "string" ? input : "");
  const message = redactText(messageValue).slice(0, 1_000);
  const phaseValue =
    firstValue(object, new Set(["phase", "stage", "step", "operation"])) ||
    textFields(message).phase ||
    null;
  const serviceValue =
    firstValue(object, new Set(["service", "component", "artifact", "app"])) ||
    textFields(message).component ||
    null;
  const elapsedValue =
    firstValue(object, new Set(["elapsedms", "elapsed_ms", "durationms", "duration_ms", "duration"])) ||
    textFields(message).elapsed_ms ||
    textFields(message).duration_ms ||
    null;
  const timestampValue =
    firstValue(object, new Set(["timestamp", "time", "startedat", "finishedat", "createdat"])) ||
    textFields(message).timestamp ||
    null;
  const status =
    firstValue(object, new Set(["status", "state", "result"])) ||
    textFields(message).status ||
    null;
  const cache =
    firstValue(object, new Set(["cachestatus", "cache_status", "cache", "cachehit"])) ||
    textFields(message).cache_status ||
    null;

  const record = {
    sequence,
    lineNumber,
    publishId: metadata.publishId,
    deploymentId: metadata.deploymentId,
    timestamp: parseTimestamp(timestampValue),
    service: canonicalService(serviceValue, message),
    phase: canonicalPhase(phaseValue, message),
    status: statusValue(status, message),
    elapsedMs: parseDuration(elapsedValue),
    cacheStatus: cacheStatus(cache, message),
  };
  record.message = [
    `service=${record.service || "unknown"}`,
    `phase=${record.phase}`,
    `status=${record.status || "unknown"}`,
    record.elapsedMs === null ? null : `elapsedMs=${record.elapsedMs}`,
    record.cacheStatus ? `cacheStatus=${record.cacheStatus}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return record;
}

function extractEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [value];
  for (const key of ["events", "entries", "records", "transcript", "logs", "lines", "phases"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [value];
}

function metadataFrom(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { publishId: null, deploymentId: null };
  }
  return {
    publishId: correlationId(firstValue(value, PUBLISH_ID_KEYS)),
    deploymentId: correlationId(firstValue(value, DEPLOYMENT_ID_KEYS)),
  };
}

export function parseTranscriptText(text) {
  const source = String(text);
  const lines = source.split(/\n/);
  const records = [];
  let publishId = null;
  let deploymentId = null;
  let sourceFormat = "text";
  let sequence = 0;
  let parsedJsonLines = 0;
  const publishIds = new Set();
  const deploymentIds = new Set();

  function retainMetadata(metadata) {
    if (metadata.publishId) publishIds.add(metadata.publishId);
    if (metadata.deploymentId) deploymentIds.add(metadata.deploymentId);
  }

  const trimmed = source.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      const metadata = metadataFrom(parsed);
      retainMetadata(metadata);
      for (const entry of extractEntries(parsed)) {
        const entryMetadata = metadataFrom(entry);
        retainMetadata(entryMetadata);
        records.push(normalizeRecord(entry, ++sequence, 1));
      }
      sourceFormat = "json";
    } catch {
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        let entry = line;
        try {
          entry = JSON.parse(line);
          parsedJsonLines += 1;
        } catch {
          // Publishing UI exports often contain prefixed key=value timing lines.
        }
        const entryMetadata = metadataFrom(entry);
        const textMetadata = metadataFromText(line);
        retainMetadata(entryMetadata);
        retainMetadata(textMetadata);
        records.push(normalizeRecord(entry, ++sequence, index + 1));
      }
      if (parsedJsonLines) sourceFormat = "jsonl";
    }
  }

  publishId = publishIds.size === 1 ? [...publishIds][0] : null;
  deploymentId = deploymentIds.size === 1 ? [...deploymentIds][0] : null;
  return {
    schema: TRANSCRIPT_SCHEMA,
    publishId,
    deploymentId,
    publishIds: [...publishIds],
    deploymentIds: [...deploymentIds],
    sourceFormat,
    lineCount: lines.filter((line) => line.trim()).length,
    recordCount: records.length,
    sourceComplete:
      records.length === lines.filter((line) => line.trim()).length ||
      sourceFormat === "json",
    records,
  };
}

export async function readTranscript(filePath) {
  const absolutePath = path.resolve(filePath);
  const contents = await readFile(absolutePath, "utf8");
  const transcript = parseTranscriptText(contents);
  return {
    ...transcript,
    source: {
      kind: "publishing-tool-ui-export",
      fileType: path.extname(absolutePath).slice(1).toLowerCase() || "text",
    },
  };
}

export function withCorrelation(transcript, requestedPublishId) {
  if (requestedPublishId && !correlationId(requestedPublishId)) {
    throw new Error("The publish ID is empty or too long.");
  }
  const publishId = correlationId(requestedPublishId) || transcript.publishId;
  if (!publishId) {
    throw new Error(
      "A publish ID is required when importing a Publishing transcript. Pass --publish-id or include publishId in the export.",
    );
  }
  const observedPublishIds = new Set([
    ...(transcript.publishIds || []),
    ...transcript.records.map((record) => record.publishId).filter(Boolean),
  ]);
  const mismatchedPublishIds = [...observedPublishIds].filter(
    (observedPublishId) => observedPublishId !== publishId,
  );
  if (mismatchedPublishIds.length) {
    throw new Error(
      "The transcript contains a publish ID that does not match the requested publish.",
    );
  }
  const records = transcript.records.map((record) => ({
    ...record,
    publishId,
  }));
  const phaseSummary = Object.fromEntries(
    COMPARISON_PHASES.map((phase) => [
      phase,
      records.filter((record) => record.phase === phase),
    ]),
  );
  const checks = {
    artifactBuild: phaseSummary["artifact-build"].length > 0,
    chromiumCacheHit: phaseSummary["chromium-preparation"].some((record) =>
      /\b(hit|cached|reuse|reused)\b/i.test(record.cacheStatus || record.message || ""),
    ),
    upload: phaseSummary.upload.length > 0,
    imagePush: phaseSummary["image-push"].length > 0,
    apiStartup: phaseSummary.startup.some(
      (record) => record.service === "api-server",
    ),
    osMobileReadiness: phaseSummary["mobile-readiness"].some(
      (record) => record.service === "os-mobile",
    ),
    posReadiness: phaseSummary["mobile-readiness"].some(
      (record) => record.service === "pos",
    ),
  };
  const missing = Object.entries(checks)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  return {
    ...transcript,
    publishId,
    records,
    complete: transcript.sourceComplete && missing.length === 0,
    correlation: {
      key: "publishId",
      value: publishId,
      status: "matched-single-publish",
    },
    omittedFields: [
      "request and response payloads",
      "authorization headers, cookies, tokens, credentials, and private keys",
    ],
    phaseSummary,
    completeness: {
      status:
        transcript.sourceComplete && missing.length === 0
          ? "complete"
          : "incomplete",
      checks,
      missing,
    },
  };
}

export function projectLocalEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const publishId = correlationId(event.publishId);
  const phase =
    typeof event.phase === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]{0,79}$/.test(event.phase)
      ? event.phase
      : null;
  if (!phase) return null;
  return {
    schema: "presentail.publish.v1",
    event: "publish.phase",
    publishId,
    timestamp: parseTimestamp(event.timestamp),
    phase,
    status: statusValue(event.status),
    elapsedMs: parseDuration(event.elapsedMs),
    cacheStatus: cacheStatus(event.cacheStatus),
  };
}