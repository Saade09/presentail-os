import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// PORT is only consumed by the dev/preview server below — a production `vite
// build` never binds a port. The deployment's static build phase does not
// inject the service env vars, so requiring PORT here would (and did) crash the
// deploy build. Fall back to a sane default and only reject an explicitly
// provided but invalid value.
const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5000;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// BASE_PATH sets Vite's `base`. This artifact is served at the site root ("/"),
// so default to that when the env var is absent (e.g. during the deploy build)
// rather than throwing.
const basePath = process.env.BASE_PATH || "/";

// The Clerk proxy ensures the frontend and backend use the SAME Clerk instance.
// In dev the proxy runs through the local API server; in production it runs
// through the deployed API server so the JWT issuer always matches what the
// server verifies.
// Build cache buster: 2026-05-26T00:00Z (force proxy in production to fix
// Clerk instance mismatch between frontend custom domain and backend secret key)
const isProduction = process.env.NODE_ENV === "production";
// Under Playwright (NODE_ENV=test) the API server is not running, so the Clerk
// proxy URL must stay unset — otherwise Clerk.js routes its FAPI calls through
// /api/__clerk (which 404s) instead of talking to the test instance's FAPI
// host directly, where the e2e fixtures intercept /v1/** requests. This is the
// supported replacement for the old VITE_PLAYWRIGHT flag that used to disable
// the proxy in tests.
const isTest = process.env.NODE_ENV === "test";
// PROXY MODE IS DISABLED — Clerk talks to its FAPI directly in every environment.
//
// Production: the pk_live key encodes the custom-domain FAPI clerk.presentail.com,
// which has valid CNAMEs and serves os.presentail.com directly (same parent domain,
// so Clerk cookies work). Clerk REJECTS proxy-mode requests for this instance
// ("proxy_request_invalid_secret_key" / proxy URL "cannot be on a different domain"),
// so routing through /api/__clerk breaks sign-in with an infinite 401 spinner.
//
// Development: the pk_test key encodes becoming-man-73.clerk.accounts.dev, which
// Clerk serves directly to any origin (dev instances don't support proxying).
//
// Do NOT reintroduce a proxy URL here without confirming the Clerk instance has a
// registered proxy configuration.
const clerkProxyUrl = undefined;
void isTest;

// The Clerk publishable key is PUBLIC by design (it ships in every browser
// bundle), so baking the production value in here is safe.
//
// PRODUCTION IGNORES process.env ON PURPOSE. The deployment's build
// environment injects a STALE VITE_CLERK_PUBLISHABLE_KEY (decoding to the dead
// FAPI clerk.os.presentail.com) that the workspace config no longer contains —
// proven by fetching the live bundle: the stale key is statically inlined even
// though the deployed commit's config was correct. Letting the env var win in
// production re-ships the outage. Only development reads the env (pk_test).
const PROD_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsucHJlc2VudGFpbC5jb20k";
const clerkPublishableKey = isProduction
  ? PROD_CLERK_PUBLISHABLE_KEY
  : process.env.VITE_CLERK_PUBLISHABLE_KEY;
// Google Maps browser keys are intentionally public and must be restricted in
// Google Cloud Console by HTTP referrer. Defining the value explicitly keeps a
// missing deployment env from throwing during a static production build.
const googleMapsBrowserKey = process.env.VITE_GOOGLE_MAPS_BROWSER_KEY?.trim();

export default defineConfig({
  base: basePath,
  define: {
    // Statically replace the publishable key so no stale value can leak in from
    // env files or the deploy build environment. Undefined in dev only when the
    // workspace env is missing the key (App.tsx then throws a clear error).
    "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": clerkPublishableKey
      ? JSON.stringify(clerkPublishableKey)
      : "undefined",
    // Always define VITE_CLERK_PROXY_URL so Vite statically replaces every
    // reference in the bundle — prevents any stale value from leaking through
    // env files or Replit's build environment.
    "import.meta.env.VITE_CLERK_PROXY_URL": clerkProxyUrl
      ? JSON.stringify(clerkProxyUrl)
      : "undefined",
    "import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY": googleMapsBrowserKey
      ? JSON.stringify(googleMapsBrowserKey)
      : "undefined",
  },
  plugins: [
    react(),
    tailwindcss(),
    // Disable the runtime-error overlay in test mode so that transient errors
    // (e.g., a failed external script load) don't block Playwright from seeing
    // the actual page content.
    ...(process.env.NODE_ENV !== "test" ? [runtimeErrorOverlay()] : []),
    // Load Replit dev-only plugins only when running the main dev server, not
    // during Playwright e2e test runs.  During tests, NODE_ENV is set to "test"
    // so that the dev banner and cartographer plugins are not injected — they
    // intercept the page and prevent the React app from rendering, which causes
    // Playwright to see only the banner in its page snapshots.
    ...(process.env.NODE_ENV !== "production" &&
    process.env.NODE_ENV !== "test" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    // Deduplicate shared packages across all workspace packages.
    // Without this, pnpm installs a separate copy for each workspace package
    // that declares it as a dependency, and Rollup bundles multiple instances —
    // which breaks React context sharing (e.g. QueryClientProvider) at runtime.
    dedupe: ["react", "react-dom", "@tanstack/react-query"],
  },
  root: path.resolve(import.meta.dirname),
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "@clerk/react",
      "@clerk/themes",
      // The packages below ship CJS/ESM hybrid bundles (they have both a
      // CommonJS entry and an ESM entry in their dist/). Without explicit
      // pre-bundling here, Vite may load multiple copies of React — one for
      // the app and one inside each hybrid package — which triggers the
      // "duplicate React" invariant violation and produces a blank page.
      //
      // RULE: whenever you install a new UI primitive or utility that ships
      // CJS alongside ESM (check its dist/ for .cjs / .js files next to
      // .mjs), add it to this list. All @radix-ui/* packages, cmdk, vaul,
      // input-otp, embla-carousel-react, recharts, react-day-picker, sonner,
      // framer-motion, and react-resizable-panels are known offenders.
      "cmdk",
      "input-otp",
      "embla-carousel-react",
      "recharts",
      "react-day-picker",
      "sonner",
      "framer-motion",
      "react-resizable-panels",
      "@radix-ui/react-accordion",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-aspect-ratio",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-collapsible",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-label",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slider",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toast",
      "@radix-ui/react-toggle",
      "@radix-ui/react-toggle-group",
      "@radix-ui/react-tooltip",
      "vaul",
    ],
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-clerk": ["@clerk/react", "@clerk/themes"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-ui": [
            "@radix-ui/react-accordion",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-aspect-ratio",
            "@radix-ui/react-avatar",
            "@radix-ui/react-checkbox",
            "@radix-ui/react-collapsible",
            "@radix-ui/react-context-menu",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-hover-card",
            "@radix-ui/react-label",
            "@radix-ui/react-menubar",
            "@radix-ui/react-navigation-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-progress",
            "@radix-ui/react-radio-group",
            "@radix-ui/react-scroll-area",
            "@radix-ui/react-select",
            "@radix-ui/react-separator",
            "@radix-ui/react-slider",
            "@radix-ui/react-slot",
            "@radix-ui/react-switch",
            "@radix-ui/react-tabs",
            "@radix-ui/react-toast",
            "@radix-ui/react-toggle",
            "@radix-ui/react-toggle-group",
            "@radix-ui/react-tooltip",
            "cmdk",
            "input-otp",
            "vaul",
          ],
          "vendor-charts": [
            "recharts",
            "framer-motion",
          ],
          "vendor-dnd": [
            "@dnd-kit/core",
            "@dnd-kit/sortable",
            "@dnd-kit/utilities",
          ],
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      // Use a trailing slash so the proxy matches only real API calls
      // (e.g. /api/users) and not in-app routes whose paths happen to
      // share the "/api" prefix (e.g. /api-docs, /api-keys).  Without
      // the trailing slash, navigations to those routes get forwarded
      // to the API server and return 404 before the SPA's auth guard
      // can run.
      "/api/": {
        target: "http://localhost:8080",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            proxyReq.removeHeader("origin");
            // Preserve the original host so server-side middlewares (e.g.
            // Clerk proxy) can reconstruct the correct public-facing URL.
            const realHost =
              (req.headers["x-forwarded-host"] as string) ||
              req.headers.host ||
              "";
            if (realHost) {
              proxyReq.setHeader("x-forwarded-host", realHost);
            }
            const proto =
              (req.headers["x-forwarded-proto"] as string) || "https";
            proxyReq.setHeader("x-forwarded-proto", proto);
          });
        },
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
