import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  correlationId,
  parseTranscriptText,
  withCorrelation,
} from "../../scripts/publish/transcript.mjs";

const execFileAsync = promisify(execFile);

test("normalizes JSONL timing phases and correlates them to a publish", () => {
  const transcript = parseTranscriptText(
    [
      '{"publishId":"pub-2026-08-29","component":"api-server","phase":"artifact-build","status":"completed","elapsed_ms":2100}',
      '[TIMING] component=api-server phase=chromium-preparation event=complete timestamp=2026-08-29T04:50:00.000Z elapsed_ms=581 status=success',
      "Reusing full Chromium build; cache hit",
      "mobile OS Mobile readiness complete elapsed_ms=4200",
    ].join("\n"),
  );
  const correlated = withCorrelation(transcript, "pub-2026-08-29");

  assert.equal(correlated.publishId, correlationId("pub-2026-08-29"));
  assert.equal(correlated.correlation.status, "matched-single-publish");
  assert.equal(correlated.recordCount, 4);
  assert.deepEqual(
    correlated.records.map((record) => record.phase),
    ["artifact-build", "chromium-preparation", "chromium-preparation", "mobile-readiness"],
  );
  assert.equal(correlated.records[1].elapsedMs, 581);
  assert.equal(correlated.records[2].cacheStatus, "hit");
  assert.equal(correlated.phaseSummary["mobile-readiness"].length, 1);
});

test("retains sanitized evidence without request payloads or credentials", () => {
  const transcript = parseTranscriptText(
    [
      "PUBLISH_ID=pub-1 phase=upload status=complete payload={\"token\":\"sk_live_secret\"} https://example.test/upload?token=secret",
      "phase=image-push API_KEY=plain-secret",
      'phase=startup message={"token":"quoted-secret","requestPayload":{"name":"private"}}',
    ].join("\n"),
  );
  const serialized = JSON.stringify(transcript);

  assert.equal(transcript.publishId, correlationId("pub-1"));
  assert.doesNotMatch(
    serialized,
    /sk_live_secret|plain-secret|quoted-secret|private|token=secret|\\"token\\"/,
  );
  assert.equal(
    transcript.records.every((record) =>
      /^service=.+ phase=.+ status=/.test(record.message),
    ),
    true,
  );
});

test("retained summaries fail closed for punctuated secrets and relative URL queries", () => {
  const transcript = parseTranscriptText(
    [
      'phase=upload detail="token=leak2"',
      "phase=upload x&api_key=leak3",
      "phase=upload (password=leak4)",
      "phase=upload /api/upload?token=leak5",
    ].join("\n"),
  );
  const serialized = JSON.stringify(transcript);
  assert.doesNotMatch(serialized, /leak2|leak3|leak4|leak5|api_key|password/);
  assert.equal(transcript.records.every((record) => record.phase === "upload"), true);
});

test("rejects a transcript that is correlated to a different publish", () => {
  const transcript = parseTranscriptText('{"publishId":"pub-a","phase":"upload","status":"complete"}');
  assert.throws(
    () => withCorrelation(transcript, "pub-b"),
    /does not match the requested publish/,
  );
});

test("rejects mixed publish IDs instead of merging their phases", () => {
  const transcript = parseTranscriptText(
    [
      "publishId=pub-a phase=upload status=complete",
      "publishId=pub-b phase=image-push status=complete",
    ].join("\n"),
  );
  assert.throws(
    () => withCorrelation(transcript, "pub-a"),
    /does not match the requested publish/,
  );
});

test("marks evidence incomplete until every required phase and mobile service is present", () => {
  const transcript = withCorrelation(
    parseTranscriptText("publishId=pub-a phase=upload status=complete"),
    "pub-a",
  );
  assert.equal(transcript.complete, false);
  assert.equal(transcript.completeness.status, "incomplete");
  assert.ok(transcript.completeness.missing.includes("chromiumCacheHit"));
  assert.ok(transcript.completeness.missing.includes("posReadiness"));
});

test("CLI writes correlated sanitized report and standalone transcript evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "publish-report-test-"));
  const inputPath = path.join(directory, "raw.txt");
  const outputPath = path.join(directory, "evidence", "publish-report.json");
  const localReportDirectory = path.join(directory, "local-events");
  await mkdir(localReportDirectory);
  await writeFile(
    path.join(localReportDirectory, "events.jsonl"),
    [
      '{"publishId":"stale-publish","phase":"startup","status":"completed"}',
      '{"publishId":"pub-cli","phase":"health-check","status":"completed","command":"curl","args":["/api?token=local-leak"],"error":"password=local-leak"}',
    ].join("\n"),
  );
  await writeFile(
    inputPath,
    [
      "publishId=pub-cli service=artifact phase=artifact-build status=completed elapsed_ms=100",
      "publishId=pub-cli component=api-server phase=chromium-preparation status=completed elapsed_ms=20 cache_status=cache-hit",
      "publishId=pub-cli phase=upload status=completed elapsed_ms=30",
      'publishId=pub-cli phase=image-push status=completed elapsed_ms=40 message={"token":"must-not-survive"}',
      "publishId=pub-cli component=api-server phase=startup status=completed elapsed_ms=50",
      "publishId=pub-cli component=os-mobile phase=mobile-readiness status=completed elapsed_ms=60",
      "publishId=pub-cli component=pos phase=mobile-readiness status=completed elapsed_ms=70",
    ].join("\n"),
  );
  try {
    await execFileAsync(
      "node",
      [
        "scripts/publish/publish-report.mjs",
        "--transcript",
        inputPath,
        "--publish-id",
        "pub-cli",
        "--output",
        outputPath,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PUBLISH_REPORT_DIR: localReportDirectory },
      },
    );
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    const evidence = JSON.parse(
      await readFile(path.join(path.dirname(outputPath), "publishing-transcript.json"), "utf8"),
    );
    assert.equal(report.publishId, correlationId("pub-cli"));
    assert.equal(report.excludedLocalEventCount, 1);
    assert.equal(report.phases.startup.length, 0);
    assert.equal(report.phases["health-check"].length, 1);
    assert.deepEqual(Object.keys(report.phases["health-check"][0]).sort(), [
      "cacheStatus",
      "elapsedMs",
      "event",
      "phase",
      "publishId",
      "schema",
      "status",
      "timestamp",
    ]);
    assert.equal(evidence.complete, true);
    assert.equal(evidence.completeness.status, "complete");
    assert.equal(
      evidence.records.every(
        (record) => record.publishId === correlationId("pub-cli"),
      ),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify({ report, evidence }),
      /must-not-survive|local-leak|password=|\/api\?token=/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hashes credential-shaped publish and deployment IDs before retention", () => {
  const transcript = withCorrelation(
    parseTranscriptText(
      "publishId=client_secret_verySensitiveValue deploymentId=eyJheader.eyJpayload.signature phase=upload",
    ),
    "client_secret_verySensitiveValue",
  );
  const serialized = JSON.stringify(transcript);
  assert.doesNotMatch(
    serialized,
    /client_secret_verySensitiveValue|eyJheader|eyJpayload|signature/,
  );
  assert.match(transcript.publishId, /^sha256:[a-f0-9]{32}$/);
  assert.match(transcript.deploymentId, /^sha256:[a-f0-9]{32}$/);
});