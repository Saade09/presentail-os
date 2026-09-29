/**
 * Worker-thread pool for pdfToImage processing.
 *
 * Each call to runPdfToImageInWorker() spawns a dedicated Worker thread
 * and enforces a hard timeout via worker.terminate() — unlike Promise.race(),
 * this actually stops the underlying CPU/memory work.
 *
 * A global semaphore caps concurrent workers so a flood of requests cannot
 * exhaust server memory.
 */
import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { logger } from "./logger.js";

const WORKER_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_WORKERS = 2;

let activeWorkers = 0;

interface WorkerOutput {
  ok: boolean;
  resultBase64?: string | null;
  error?: string;
}

export function resolvePdfToImageWorkerFile(
  moduleUrl = import.meta.url,
  fileExists: (filePath: string) => boolean = existsSync,
): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    // Bundled server: dist/index.mjs -> dist/lib/pdfToImageWorker.mjs
    path.join(moduleDir, "lib", "pdfToImageWorker.mjs"),
    // Separately bundled/imported pool module: dist/lib/pdfToImagePool.mjs
    path.join(moduleDir, "pdfToImageWorker.mjs"),
    // TypeScript source execution after the normal API build:
    // src/lib/pdfToImagePool.ts -> dist/lib/pdfToImageWorker.mjs
    path.resolve(moduleDir, "../../dist/lib/pdfToImageWorker.mjs"),
  ];
  return candidates.find(fileExists) ?? candidates[0];
}

/**
 * Run pdfToImage in a dedicated worker thread that can be forcibly terminated.
 * pageNumber is 1-based; defaults to 1 (first page).
 * Returns null if the worker times out, the pool is at capacity, or processing fails.
 */
export async function runPdfToImageInWorker(buffer: Buffer, pageNumber = 1): Promise<Buffer | null> {
  if (activeWorkers >= MAX_CONCURRENT_WORKERS) {
    logger.warn({ activeWorkers }, "pdfToImagePool: at capacity, dropping request");
    return null;
  }

  activeWorkers++;
  try {
    return await _runWorker(buffer, pageNumber);
  } finally {
    activeWorkers--;
  }
}

function _runWorker(buffer: Buffer, pageNumber: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    // Resolve the worker script path from the bundled main file.
    // esbuild outputs multiple entry points preserving the src/ sub-structure:
    //   src/index.ts              → dist/index.mjs         (import.meta.url points here)
    //   src/lib/pdfToImageWorker.ts → dist/lib/pdfToImageWorker.mjs
    // So from dist/index.mjs we look in dist/lib/.
    const workerFile = resolvePdfToImageWorkerFile();

    let worker: Worker;
    try {
      worker = new Worker(workerFile, {
        workerData: { bufferBase64: buffer.toString("base64"), pageNumber },
      });
    } catch (err) {
      logger.warn({ err }, "pdfToImagePool: failed to spawn worker");
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      logger.warn("pdfToImagePool: worker timed out, terminating");
      worker.terminate();
      resolve(null);
    }, WORKER_TIMEOUT_MS);

    worker.on("message", (msg: WorkerOutput) => {
      clearTimeout(timer);
      if (msg.ok && msg.resultBase64) {
        resolve(Buffer.from(msg.resultBase64, "base64"));
      } else {
        resolve(null);
      }
    });

    worker.on("error", (err) => {
      clearTimeout(timer);
      logger.warn({ err }, "pdfToImagePool: worker error");
      resolve(null);
    });

    worker.on("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}
