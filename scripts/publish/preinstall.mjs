import { existsSync, unlinkSync } from "node:fs";
import {
  cacheMetadata,
  emit,
  lockHash,
  pnpmStorePath,
  writeState,
} from "./phase.mjs";

const userAgent = process.env.npm_config_user_agent || "";
if (!userAgent.startsWith("pnpm/")) {
  throw new Error("Use pnpm instead");
}
for (const legacyLockfile of ["package-lock.json", "yarn.lock"]) {
  try {
    unlinkSync(legacyLockfile);
  } catch {
    // The files are optional; keep the historical cleanup behavior when present.
  }
}

const startedAt = Date.now();
const storePath = pnpmStorePath();
const cache = cacheMetadata(storePath);
await writeState({
  startedAt,
  lockHash: lockHash(),
  ...cache,
});
await emit({
  phase: "install",
  status: "started",
  elapsedMs: 0,
  cacheStatus: cache.storePresent ? "store-present" : "cold-store",
  lockHash: lockHash(),
  storePresent: cache.storePresent,
  storeBytesBefore: cache.storeBytes,
  lockfilePresent: existsSync("pnpm-lock.yaml"),
});