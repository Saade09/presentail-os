import { describe, expect, it } from "vitest";
import { resolvePdfToImageWorkerFile } from "./pdfToImagePool.js";

describe("resolvePdfToImageWorkerFile", () => {
  it("resolves the worker beside the bundled server entry point", () => {
    const existing = new Set(["/app/dist/lib/pdfToImageWorker.mjs"]);

    expect(
      resolvePdfToImageWorkerFile(
        "file:///app/dist/index.mjs",
        (candidate) => existing.has(candidate),
      ),
    ).toBe("/app/dist/lib/pdfToImageWorker.mjs");
  });

  it("resolves the built worker when extraction runs from TypeScript source", () => {
    const existing = new Set(["/app/dist/lib/pdfToImageWorker.mjs"]);

    expect(
      resolvePdfToImageWorkerFile(
        "file:///app/src/lib/pdfToImagePool.ts",
        (candidate) => existing.has(candidate),
      ),
    ).toBe("/app/dist/lib/pdfToImageWorker.mjs");
  });
});