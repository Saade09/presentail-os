/// <reference lib="dom" />
import { DOMMatrix as CanvasDOMMatrix, Path2D as CanvasPath2D, ImageData as CanvasImageData } from "@napi-rs/canvas";
if (!("DOMMatrix" in globalThis)) {
  (globalThis as Record<string, unknown>).DOMMatrix = CanvasDOMMatrix;
}
if (!("Path2D" in globalThis)) {
  (globalThis as Record<string, unknown>).Path2D = CanvasPath2D;
}
if (!("ImageData" in globalThis)) {
  (globalThis as Record<string, unknown>).ImageData = CanvasImageData;
}

import sharp from "sharp";
import { Buffer } from "node:buffer";
import { logger } from "./logger";

const MAX_IMAGE_PIXELS = 4096 * 4096;
const MAX_PDF_PAGE_PX = 4096;

/** Minimal interface for pdfjs PDFDocumentLoadingTask (pdfjs 6+ destroy lives here). */
interface PdfLoadingTask {
  promise: Promise<unknown>;
  destroy(): Promise<void>;
}

/**
 * Converts a specific page of a PDF buffer to a PNG image buffer.
 * pageNumber is 1-based; defaults to 1 (first page).
 * If the buffer is not a PDF, it is passed through to sharp directly (treated as raw image).
 * Returns null if conversion fails or if the image/PDF dimensions exceed resource limits.
 */
export async function pdfToImage(buffer: Buffer, pageNumber = 1): Promise<Buffer | null> {
  const isPdf = buffer.slice(0, 4).equals(Buffer.from("%PDF"));

  if (!isPdf) {
    try {
      const meta = await sharp(buffer).metadata();
      const pixels = (meta.width ?? 0) * (meta.height ?? 0);
      if (pixels > MAX_IMAGE_PIXELS) {
        logger.warn(
          { width: meta.width, height: meta.height },
          "pdfToImage: image dimensions too large, rejecting to prevent resource exhaustion",
        );
        return null;
      }
      return await sharp(buffer).png().toBuffer();
    } catch (err) {
      logger.warn({ err }, "pdfToImage: failed to convert non-PDF buffer via sharp");
      return null;
    }
  }

  // Keep loadingTask in outer scope so cleanup can use loadingTask.destroy() (pdfjs 6 API).
  let loadingTask: PdfLoadingTask | null = null;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");

    loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) }) as unknown as PdfLoadingTask;
    const pdfDoc = await loadingTask.promise as { getPage(n: number): Promise<unknown>; numPages: number };
    const page = await pdfDoc.getPage(pageNumber) as {
      getViewport(opts: { scale: number }): { width: number; height: number };
      render(opts: { canvas: unknown; canvasContext: unknown; viewport: unknown }): { promise: Promise<void> };
    };

    // Compute a safe scale so neither rendered dimension exceeds MAX_PDF_PAGE_PX,
    // preventing a malicious PDF with huge reported page dimensions from allocating
    // an enormous canvas.
    const baseViewport = page.getViewport({ scale: 1 });
    const maxRawDim = Math.max(baseViewport.width, baseViewport.height);
    const desiredScale = 2;
    const safeScale = maxRawDim > 0 ? Math.min(desiredScale, MAX_PDF_PAGE_PX / maxRawDim) : desiredScale;

    const viewport = page.getViewport({ scale: safeScale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const pngBuffer = canvas.toBuffer("image/png");

    // Best-effort cleanup: use loadingTask.destroy() (pdfjs 6 removed pdfDoc.destroy()).
    // Cleanup failures must never discard an already-successful render result.
    const taskToClean = loadingTask;
    loadingTask = null;
    taskToClean.destroy().catch(() => {});

    return pngBuffer as unknown as Buffer;
  } catch (err) {
    logger.warn({ err }, "pdfToImage: failed to render PDF page");
    // Best-effort cleanup on error path.
    if (loadingTask !== null) {
      loadingTask.destroy().catch(() => {});
    }
    return null;
  }
}
