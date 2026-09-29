import { cacheMetadata, emit, pnpmStorePath, readState } from "./phase.mjs";

const state = await readState();
const cache = cacheMetadata(pnpmStorePath());
const cacheStatus = state?.storePresent
  ? "store-restored-or-reused"
  : "cold-store";
await emit({
  phase: "install",
  status: "completed",
  elapsedMs: state ? Date.now() - state.startedAt : null,
  cacheStatus,
  lockHash: state?.lockHash || "missing",
  storePresent: cache.storePresent,
  storeBytesBefore: state?.storeBytes || 0,
  storeBytesAfter: cache.storeBytes,
  downloadedBytes: null,
  note: "pnpm does not expose downloaded bytes through lifecycle hooks; deployment metadata can fill this field.",
});