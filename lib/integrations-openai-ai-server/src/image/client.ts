import OpenAI, { toFile } from "openai";
import { Buffer } from "node:buffer";

function getOpenAI(): OpenAI {
  if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || !process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
    throw new Error("OpenAI image integration is not configured");
  }
  return new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
}
/** Kept for compatibility; unlike the old eager client this is safe at startup. */
export const openai = new Proxy({} as OpenAI, { get: (_target, key) => Reflect.get(getOpenAI(), key) });

export async function generateImageBuffer(
  prompt: string,
  size: "1024x1024" | "512x512" | "256x256" = "1024x1024",
  model = "gpt-image-1",
  options?: { quality?: string },
): Promise<Buffer> {
  const response = await getOpenAI().images.generate({
    model,
    prompt,
    size,
    ...(options?.quality ? { quality: options.quality as never } : {}),
  });
  const base64 = (response.data ?? [])[0]?.b64_json ?? "";
  return Buffer.from(base64, "base64");
}

export type ImageEditInput = {
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  filename?: string;
};

/**
 * Edits with bytes already held in memory. This is deliberately separate from
 * temporary image files to the application filesystem, so callers with private
 * object-storage images can keep the entire operation in memory.
 */
export async function editImageBuffers(
  images: ImageEditInput[],
  prompt: string,
  model = "gpt-image-1",
  options?: {
    quality?: string;
    size?: "1024x1024" | "1536x1024" | "1024x1536";
    outputFormat?: "png" | "jpeg" | "webp";
    inputFidelity?: "low" | "high";
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Buffer> {
  if (images.length === 0) throw new Error("At least one reference image is required");
  const files = await Promise.all(
    images.map((image, index) =>
      toFile(image.bytes, image.filename ?? `reference-${index + 1}.png`, {
        type: image.mimeType,
      }),
    ),
  );
  const response = await getOpenAI().images.edit(
    {
      model,
      image: files,
      prompt,
      size: options?.size ?? "1024x1024",
      ...(options?.quality ? { quality: options.quality as never } : {}),
      ...(options?.outputFormat ? { output_format: options.outputFormat as never } : {}),
      ...(options?.inputFidelity ? { input_fidelity: options.inputFidelity } : {}),
    } as never,
    {
      ...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return Buffer.from((response.data ?? [])[0]?.b64_json ?? "", "base64");
}
