/**
 * Integration test for pdfToImage — runs against the real pdfjs-dist stack,
 * with no module mocks. This catches breakage from pdfjs upgrades (e.g. API
 * removals like pdfDoc.destroy() in pdfjs 6) and missing canvas globals
 * (Path2D / ImageData / DOMMatrix required by pdfjs path rendering).
 *
 * Run in isolation to avoid memory pressure from the full suite:
 *   pnpm --filter @workspace/api-server test --pool=forks pdfToImage.integration
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Import the real pdfToImage — no vi.mock() in this file.
import { pdfToImage } from "./pdfToImage";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "test-fixtures/scanned-invoice.pdf");

describe("pdfToImage — real pdfjs-dist integration (scanned PDF)", () => {
  it("renders a synthetic image-only PDF to a non-null PNG buffer", async () => {
    const pdfBuffer = readFileSync(FIXTURE_PATH);

    // Sanity: confirm the fixture is a valid PDF.
    expect(pdfBuffer.slice(0, 4).toString("ascii")).toBe("%PDF");

    // Call the real pdfToImage — no mocks.
    // Exercises: Path2D / ImageData / DOMMatrix polyfills, pdfjs loading,
    // page rendering, canvas rasterisation, and loadingTask.destroy() cleanup.
    const result = await pdfToImage(pdfBuffer);

    // A scanned (image-only) PDF must render to a non-null PNG buffer.
    expect(result).not.toBeNull();
    expect(Buffer.isBuffer(result)).toBe(true);
    // PNG magic bytes: 89 50 4E 47
    if (result) {
      expect(result[0]).toBe(0x89);
      expect(result[1]).toBe(0x50); // P
      expect(result[2]).toBe(0x4e); // N
      expect(result[3]).toBe(0x47); // G
    }
  }, 60_000);
});
