import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, copyFile, mkdir, cp } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const isProductionBuild = process.env.NODE_ENV === "production";

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/lib/pdfToImageWorker.ts"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    minify: isProductionBuild,
    keepNames: isProductionBuild,
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "@napi-rs/canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      // @google-cloud/storage is used by objectStorage.ts and must stay bundled:
      // deployment runtime images contain build output, not workspace pnpm links.
      // Externalizing it crashes the API before it can serve the health check.
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "playwright-core",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "pdfkit",
    ],
    sourcemap: isProductionBuild ? false : "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // pdfjs-dist resolves its worker module (pdf.worker.mjs) relative to the
  // importing file. Once bundled, the importer is dist/lib/pdfToImageWorker.mjs,
  // so pdfjs looks for dist/lib/pdf.worker.mjs — which esbuild does not emit.
  // Copy the real worker next to the bundle so the pdfjs "fake worker" dynamic
  // import succeeds in the bundled runtime (PDF→image render fails otherwise).
  const requireFromBuild = createRequire(import.meta.url);
  const pdfWorkerSrc = requireFromBuild.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const libDir = path.resolve(distDir, "lib");
  await mkdir(libDir, { recursive: true });
  await copyFile(pdfWorkerSrc, path.resolve(libDir, "pdf.worker.mjs"));

  // The gift-card PDF generator reads its stationery background image and
  // bundled Roboto fonts from disk at runtime. esbuild does not copy these,
  // so mirror the source `assets/` dir into `dist/assets/` where the bundled
  // code (running from dist/) resolves them.
  const assetsSrc = path.resolve(artifactDir, "assets");
  await cp(assetsSrc, path.resolve(distDir, "assets"), { recursive: true });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
