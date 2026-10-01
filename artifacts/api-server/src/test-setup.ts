import { vi } from "vitest";

// Provide a deterministic credential-encryption key so unit tests never depend
// on a deployment secret being injected. Remove the legacy name so tests that
// assert "key not set" behaviour aren't satisfied by an ambient fallback.
delete process.env.WOOCOMMERCE_ENCRYPTION_KEY;
process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);

// The AI integration clients are constructed at import time:
// @workspace/integrations-anthropic-ai-server throws from resolveConfig() when
// AI_INTEGRATIONS_* is absent, and the OpenAI SDK throws on an undefined
// apiKey. Any test file that transitively imports src/lib/ai/callAI.ts
// therefore fails to load at all unless these are set, and CI injects no AI
// credentials. Provide inert values so importing those modules is safe: the
// base URL is deliberately unroutable and every test that exercises an AI call
// mocks the SDK, so no request is ever made to it. The Anthropic client derives
// its own endpoint from these two by swapping "openai" → "anthropic", so the
// direct AI_INTEGRATIONS_ANTHROPIC_* names are removed to keep the resolution
// path deterministic rather than dependent on a developer's local environment.
delete process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://ai-integrations.invalid/openai";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "test-ai-integrations-key";

// src/app.ts throws at import time when no Clerk publishable key is set, so
// the suites that import the Express app cannot load in CI either. Use a
// syntactically valid test key (pk_test_ + base64 "<domain>$", which app.ts
// decodes for its startup diagnostics) pointing at a Clerk domain that does
// not exist. No JWT is ever verified against it in unit tests.
process.env.VITE_CLERK_PUBLISHABLE_KEY =
  "pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk";

// With pool:"threads" and isolate:false, all test files in the same worker
// thread share one module registry. Calling vi.resetModules() here (setupFiles
// runs once per test file) clears stale module instances between files so that
// each file's vi.mock() factories are applied to freshly-imported modules.
// V8 bytecode compilation remains cached in the worker-thread process, so
// subsequent imports are fast even though the instances are re-created.
vi.unstubAllGlobals();
vi.resetModules();
