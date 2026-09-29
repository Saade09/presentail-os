#!/usr/bin/env node
/**
 * Release-time Clerk configuration contract.
 *
 * This intentionally checks source configuration rather than trusting the
 * deployment environment. The production build environment has previously
 * contained stale VITE_CLERK_PUBLISHABLE_KEY values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const productionKey = "pk_live_Y2xlcmsucHJlc2VudGFpbC5jb20k";
const files = {
  apiKey: path.join(root, "artifacts/api-server/src/lib/clerkPublishableKey.ts"),
  apiApp: path.join(root, "artifacts/api-server/src/app.ts"),
  apiProxy: path.join(root, "artifacts/api-server/src/middlewares/clerkProxyMiddleware.ts"),
  webApp: path.join(root, "artifacts/print-agent-web/src/App.tsx"),
  webVite: path.join(root, "artifacts/print-agent-web/vite.config.ts"),
};

function read(name) {
  if (!fs.existsSync(files[name])) {
    throw new Error(`Clerk config contract file is missing: ${files[name]}`);
  }
  return fs.readFileSync(files[name], "utf8");
}

const apiKey = read("apiKey");
const apiApp = read("apiApp");
const apiProxy = read("apiProxy");
const webApp = read("webApp");
const webVite = read("webVite");

const failures = [];
function requireText(name, source, text, reason) {
  if (!source.includes(text)) failures.push(`${name}: ${reason}`);
}

requireText("api key selector", apiKey, productionKey, "the pinned production key changed");
requireText(
  "api key selector",
  apiKey,
  'nodeEnv === "production"',
  "production must use an explicit environment branch",
);
requireText("API app", apiApp, "getEffectiveClerkPublishableKey", "Clerk middleware does not use the shared selector");
requireText("API proxy", apiProxy, "getEffectiveClerkPublishableKey", "Clerk proxy does not use the shared selector");
requireText("API app", apiApp, "clerkMiddleware({ publishableKey: clerkPublishableKey })", "middleware key wiring changed");
requireText("API proxy", apiProxy, "getClerkFapi()", "proxy FAPI wiring changed");
requireText("web Vite config", webVite, productionKey, "the browser build is not pinned to the same production key");
if (!/const\s+clerkPublishableKey\s*=\s*isProduction\s*\?\s*PROD_CLERK_PUBLISHABLE_KEY\s*:/.test(webVite)) {
  failures.push("web Vite config: production build may read stale environment key material");
}
requireText("web app", webApp, "publishableKey={clerkPublishableKey}", "ClerkProvider key wiring changed");
requireText("web Vite config", webVite, '"import.meta.env.VITE_CLERK_PUBLISHABLE_KEY"', "the browser key is not statically controlled");

const decodedProductionDomain = Buffer.from(
  productionKey.replace(/^pk_(live|test)_/, ""),
  "base64",
).toString("utf8").replace(/\$$/, "");
if (decodedProductionDomain !== "clerk.presentail.com") {
  failures.push(`production key decodes to unexpected Clerk domain: ${decodedProductionDomain}`);
}

if (failures.length > 0) {
  console.error("Clerk release configuration check FAILED:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Clerk release configuration check passed (${decodedProductionDomain}).`);