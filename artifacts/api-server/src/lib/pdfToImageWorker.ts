/**
 * Worker thread entry point for pdfToImage processing.
 * Runs in a dedicated thread so the parent can call worker.terminate()
 * to forcibly stop CPU/memory-heavy PDF or image rendering.
 */
import { DOMMatrix as CanvasDOMMatrix, Path2D as CanvasPath2D, ImageData as CanvasImageData } from "@napi-rs/canvas";
(globalThis as Record<string, unknown>).DOMMatrix = CanvasDOMMatrix;
(globalThis as Record<string, unknown>).Path2D = CanvasPath2D;
(globalThis as Record<string, unknown>).ImageData = CanvasImageData;

import { parentPort, workerData } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { pdfToImage } from "./pdfToImage.js";

interface WorkerInput {
  bufferBase64: string;
  pageNumber?: number;
}

interface WorkerOutput {
  ok: boolean;
  resultBase64?: string | null;
  error?: string;
}

async function main(): Promise<void> {
  const { bufferBase64, pageNumber = 1 } = workerData as WorkerInput;
  const buffer = Buffer.from(bufferBase64, "base64");
  const result = await pdfToImage(buffer, pageNumber);
  const msg: WorkerOutput = {
    ok: true,
    resultBase64: result ? result.toString("base64") : null,
  };
  parentPort?.postMessage(msg);
}

main().catch((err: unknown) => {
  const msg: WorkerOutput = { ok: false, error: String(err) };
  parentPort?.postMessage(msg);
});
