import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

export const REPORT_DIR =
  process.env.PUBLISH_REPORT_DIR || path.join("/tmp", "presentail-publish");
export const EVENTS_FILE = path.join(REPORT_DIR, "events.jsonl");
export const STATE_FILE = path.join(REPORT_DIR, "install-state.json");

export async function ensureReportDir() {
  await mkdir(REPORT_DIR, { recursive: true });
}

function isoNow() {
  return new Date().toISOString();
}

function publishCorrelationId(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export async function emit(event) {
  await ensureReportDir();
  const line = `${JSON.stringify({
    schema: "presentail.publish.v1",
    event: "publish.phase",
    timestamp: isoNow(),
    ...(process.env.PUBLISH_ID
      ? { publishId: publishCorrelationId(process.env.PUBLISH_ID) }
      : {}),
    ...event,
  })}\n`;
  process.stdout.write(line);
  await appendFile(EVENTS_FILE, line);
}

export function lockHash() {
  try {
    return createHash("sha256")
      .update(requireFile("pnpm-lock.yaml"))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "missing";
  }
}

function requireFile(filePath) {
  return readFileSync(filePath);
}

export function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function byteSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function directoryBytes(dirPath) {
  const output = commandOutput("du", ["-sb", dirPath]);
  const bytes = Number(output.split(/\s+/, 1)[0]);
  return Number.isFinite(bytes) ? bytes : 0;
}

export async function runPhase(phase, fn, metadata = {}) {
  const started = Date.now();
  await emit({
    phase,
    status: "started",
    elapsedMs: 0,
    cacheStatus: metadata.cacheStatus || "not-applicable",
    ...metadata,
  });
  try {
    const result = await fn();
    await emit({
      phase,
      status: "completed",
      elapsedMs: Date.now() - started,
      cacheStatus: metadata.cacheStatus || "not-applicable",
      ...metadata,
    });
    return result;
  } catch (error) {
    await emit({
      phase,
      status: "failed",
      elapsedMs: Date.now() - started,
      cacheStatus: metadata.cacheStatus || "not-applicable",
      error: error instanceof Error ? error.message : String(error),
      ...metadata,
    });
    throw error;
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

export async function runCommandPhase(phase, command, args, metadata = {}) {
  return runPhase(
    phase,
    () => runCommand(command, args),
    { command, args, ...metadata },
  );
}

export async function writeState(state) {
  await ensureReportDir();
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function pnpmStorePath() {
  return commandOutput("pnpm", ["store", "path"]) || "";
}

export function cacheMetadata(storePath) {
  // `du -sb` recursively walks the pnpm content-addressable store. Running
  // that from pnpm's preinstall/postinstall hooks can consume the entire
  // post-merge setup timeout on a warm store. Presence is sufficient for the
  // install-path decision; opt into the expensive measurement only for
  // publish diagnostics.
  const measureBytes = process.env.PUBLISH_MEASURE_STORE_SIZE === "1";
  return {
    storePath: storePath || null,
    storePresent: Boolean(storePath && existsSync(storePath)),
    storeBytes: measureBytes && storePath && existsSync(storePath)
      ? directoryBytes(storePath)
      : 0,
  };
}