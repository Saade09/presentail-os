import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("production API bootstrap contract", () => {
  it("routes the deployed API through the production-only entrypoint", async () => {
    const artifactConfig = await readFile(
      resolve(import.meta.dirname, "../../.replit-artifact/artifact.toml"),
      "utf8",
    );

    expect(artifactConfig).toContain(
      'run = ["node", "artifacts/api-server/production-entry.cjs"]',
    );
    expect(artifactConfig).toContain('NODE_ENV = "production"');
    expect(artifactConfig).toContain('path = "/api/healthz"');
  });

  it("sets production mode before importing any application module", async () => {
    const entrypoint = await readFile(
      resolve(import.meta.dirname, "../../production-entry.cjs"),
      "utf8",
    );
    const modeAssignment = entrypoint.indexOf(
      'process.env.NODE_ENV = "production"',
    );
    const firstRequire = entrypoint.indexOf("require(");
    const bundleImport = entrypoint.indexOf('import("./dist/index.mjs")');

    expect(modeAssignment).toBeGreaterThanOrEqual(0);
    expect(firstRequire).toBeGreaterThan(modeAssignment);
    expect(bundleImport).toBeGreaterThan(modeAssignment);
  });

  it("keeps the artifact-root probe healthy before the Express bundle loads", async () => {
    const entrypoint = await readFile(
      resolve(import.meta.dirname, "../../production-entry.cjs"),
      "utf8",
    );

    expect(entrypoint).toContain(
      'pathname === "/api/healthz" || pathname === "/api" || pathname === "/api/"',
    );
  });
});