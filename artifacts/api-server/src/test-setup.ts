import { vi } from "vitest";

// Provide a deterministic credential-encryption key so unit tests never depend
// on a deployment secret being injected. Remove the legacy name so tests that
// assert "key not set" behaviour aren't satisfied by an ambient fallback.
delete process.env.WOOCOMMERCE_ENCRYPTION_KEY;
process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);

// With pool:"threads" and isolate:false, all test files in the same worker
// thread share one module registry. Calling vi.resetModules() here (setupFiles
// runs once per test file) clears stale module instances between files so that
// each file's vi.mock() factories are applied to freshly-imported modules.
// V8 bytecode compilation remains cached in the worker-thread process, so
// subsequent imports are fast even though the instances are re-created.
vi.unstubAllGlobals();
vi.resetModules();
