#!/usr/bin/env node
/**
 * Account-free production Clerk configuration gate.
 *
 * This validates the deployed production instance and writes a short-lived
 * local receipt only after every check passes. It never creates a Clerk
 * session and never accepts PRODUCTION_AUTH_GATE as a manual bypass.
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

const canonicalBaseURL = "https://os.presentail.com";
const baseURL = (process.env.PRODUCTION_SMOKE_BASE_URL ?? canonicalBaseURL).replace(/\/$/, "");
const receiptPath = process.env.PRODUCTION_AUTH_GATE_RECEIPT ?? "/tmp/presentail-production-auth-gate.json";
const productionKey = "pk_live_Y2xlcmsucHJlc2VudGFpbC5jb20k";
const clerkDomain = Buffer.from(
  productionKey.replace(/^pk_(live|test)_/, ""),
  "base64",
).toString("utf8").replace(/\$$/, "");
const backendSecret =
  process.env.CLERK_SECRET_KEY_OVERRIDE_V2 ??
  process.env.CLERK_SECRET_KEY_OVERRIDE ??
  process.env.CLERK_SECRET_KEY;
const receiptSecret = process.env.PRESENTAIL_OS_WEBHOOK_SECRET;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function getJson(url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function productionBundleSource(html: string): Promise<string> {
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => new URL(match[1], `${baseURL}/`).toString());
  assert(sources.length > 0, "Production HTML did not reference a JavaScript bundle");
  const responses = await Promise.all(sources.map((url) => fetch(url, {
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  })));
  for (const response of responses) assert(response.ok, `Production JavaScript bundle returned HTTP ${response.status}`);
  return (await Promise.all(responses.map((response) => response.text()))).join("\n");
}

async function main() {
  assert(baseURL === canonicalBaseURL, `Production auth gate is pinned to ${canonicalBaseURL}`);
  assert(/^https:\/\//.test(baseURL), "Production URL must use HTTPS");
  assert(clerkDomain === "clerk.presentail.com", "Pinned production publishable key resolves to the wrong Clerk instance");
  assert(backendSecret, "Production Clerk backend secret is not configured");
  assert(receiptSecret, "Production auth gate receipt signing secret is not configured");

  const configCheck = spawnSync("node", ["scripts/publish/verify-clerk-config.mjs"], {
    cwd: new URL("../..", import.meta.url),
    stdio: "inherit",
    env: process.env,
  });
  assert(!configCheck.error && configCheck.status === 0, "Pinned Clerk middleware/proxy configuration check failed");

  const root = await fetch(`${baseURL}/`, {
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  assert(root.ok, `Production URL returned HTTP ${root.status}`);
  const html = await root.text();
  assert(!html.includes("becoming-man-73.clerk.accounts.dev"), "Production HTML references the development Clerk instance");
  assert(!html.includes("clerk.os.presentail.com"), "Production HTML references the retired Clerk proxy instance");
  const bundle = await productionBundleSource(html);
  assert(bundle.includes(productionKey), "Production browser bundle does not contain the pinned production Clerk key");
  assert(!bundle.includes("becoming-man-73.clerk.accounts.dev"), "Production browser bundle references the development Clerk instance");
  assert(!bundle.includes("clerk.os.presentail.com"), "Production browser bundle references the retired Clerk proxy instance");

  const health = await getJson(`${baseURL}/api/healthz`);
  assert(health.response.ok, `Public health endpoint returned HTTP ${health.response.status}`);
  assert(health.body && typeof health.body === "object", "Public health endpoint did not return JSON");

  const publicJwks = await getJson(`https://${clerkDomain}/.well-known/jwks.json`);
  assert(publicJwks.response.ok, `Clerk public JWKS returned HTTP ${publicJwks.response.status}`);
  const publicKids = new Set(
    ((publicJwks.body as { keys?: Array<{ kid?: string }> } | null)?.keys ?? [])
      .map((key) => key.kid)
      .filter((kid): kid is string => Boolean(kid)),
  );
  assert(publicKids.size > 0, "Clerk public JWKS returned no signing keys");

  const backendJwks = await getJson("https://api.clerk.com/v1/jwks", {
    headers: { Authorization: `Bearer ${backendSecret}` },
  });
  assert(backendJwks.response.ok, `Clerk backend secret JWKS probe returned HTTP ${backendJwks.response.status}`);
  const backendKids = ((backendJwks.body as { keys?: Array<{ kid?: string }> } | null)?.keys ?? [])
    .map((key) => key.kid)
    .filter((kid): kid is string => Boolean(kid));
  assert(backendKids.some((kid) => publicKids.has(kid)), "Clerk frontend and backend keys belong to different production instances");

  // Browser proxy mode is intentionally disabled for this Clerk instance.
  // Verify the direct FAPI selected by the pinned key instead; the source
  // contract above proves API middleware derives its issuer from that same key.
  const frontendEnvironment = await getJson(`https://${clerkDomain}/v1/environment`);
  assert(frontendEnvironment.response.ok, `Production Clerk FAPI returned HTTP ${frontendEnvironment.response.status}`);
  assert(frontendEnvironment.body && typeof frontendEnvironment.body === "object", "Production Clerk FAPI did not return environment JSON");

  const runtimeConfig = await getJson(`${baseURL}/api/auth/config-attestation`);
  assert(runtimeConfig.response.ok, `Production API auth attestation returned HTTP ${runtimeConfig.response.status}`);
  const runtimeBody = runtimeConfig.body as Record<string, unknown> | null;
  assert(runtimeBody?.clerk_issuer_domain === clerkDomain, "Deployed API middleware uses a different Clerk issuer");
  assert(runtimeBody?.clerk_fapi === `https://${clerkDomain}`, "Deployed API middleware uses a different Clerk FAPI");
  assert(runtimeBody?.browser_proxy_mode === "disabled_direct_fapi", "Deployed browser Clerk proxy mode is not the pinned direct-FAPI contract");

  for (const token of [
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJpbnZhbGlkIn0.invalid",
    "expired.production.smoke.token",
  ]) {
    const response = await fetch(`${baseURL}/api/users`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    assert(response.status === 401, `Invalid/expired token was not rejected (HTTP ${response.status})`);
  }

  const unsignedReceipt = {
    status: "passed",
    base_url: baseURL,
    clerk_domain: clerkDomain,
    passed_at: new Date().toISOString(),
    checks: {
      production_url: true,
      pinned_source_contract: true,
      public_health: true,
      public_jwks: true,
      backend_jwks_same_instance: true,
      production_middleware_and_fapi: true,
      deployed_api_attestation: true,
      invalid_tokens_rejected: true,
    },
  };
  const signature = createHmac("sha256", receiptSecret)
    .update(`presentail-production-auth-gate-v1\n${JSON.stringify(unsignedReceipt)}`)
    .digest("hex");
  const receipt = { ...unsignedReceipt, signature };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  await chmod(receiptPath, 0o600);
  console.log(JSON.stringify(receipt, null, 2));
  console.log("PRODUCTION AUTH GATE PASSED.");
}

main().catch((error: unknown) => {
  console.error(`PRODUCTION AUTH GATE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});