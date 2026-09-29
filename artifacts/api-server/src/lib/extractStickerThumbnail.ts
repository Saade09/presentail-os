import sharp from "sharp";
import { Buffer } from "node:buffer";
import { openai } from "@workspace/integrations-openai-ai-server/image";
import { logger } from "./logger";
import { aiUsageAttribution, type AiUsageAttribution } from "./aiUsageRecorder";

type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const TIMEOUT_MS = 15_000;

/**
 * Uses GPT-5-mini vision to detect the primary sticker/logo bounding box in an image,
 * then crops that region with sharp and returns a PNG buffer.
 * Returns null on any failure (timeout, bad response, sharp error, etc).
 */
export async function extractStickerThumbnail(
  imageBuffer: Buffer,
  attribution?: AiUsageAttribution,
): Promise<Buffer | null> {
  try {
    const result = await Promise.race([
      doExtract(imageBuffer, attribution),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    return result;
  } catch (err) {
    logger.warn({ err }, "extractStickerThumbnail: unexpected error");
    return null;
  }
}

async function doExtract(imageBuffer: Buffer, attribution?: AiUsageAttribution): Promise<Buffer | null> {
  const base64 = imageBuffer.toString("base64");

  let box: BoundingBox;
  try {
    const { callAI } = await import("./ai/callAI");
    const response = await callAI({
      actionKey: "stickers.thumbnail_extraction",
      surface: "stickers",
      provider: "openai",
      model: "gpt-5-mini",
      client: openai,
      ...aiUsageAttribution(attribution),
      maxTokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Examine this sticker sheet image and find ONE representative logo or sticker artwork instance.
Return ONLY a JSON object with the bounding box as percentage values of the full image dimensions (0-100):
{"x": <left_percent>, "y": <top_percent>, "width": <width_percent>, "height": <height_percent>}
No explanation, no markdown fences, just the JSON object.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${base64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ content }, "extractStickerThumbnail: no JSON found in OpenAI response");
      return null;
    }
    box = JSON.parse(jsonMatch[0]) as BoundingBox;
  } catch (err) {
    logger.warn({ err }, "extractStickerThumbnail: OpenAI call failed");
    return null;
  }

  if (
    typeof box.x !== "number" ||
    typeof box.y !== "number" ||
    typeof box.width !== "number" ||
    typeof box.height !== "number"
  ) {
    logger.warn({ box }, "extractStickerThumbnail: invalid bounding box shape");
    return null;
  }

  try {
    const meta = await sharp(imageBuffer).metadata();
    const imgWidth = meta.width ?? 0;
    const imgHeight = meta.height ?? 0;

    if (!imgWidth || !imgHeight) {
      logger.warn("extractStickerThumbnail: could not read image dimensions");
      return null;
    }

    const left = Math.round((box.x / 100) * imgWidth);
    const top = Math.round((box.y / 100) * imgHeight);
    const width = Math.round((box.width / 100) * imgWidth);
    const height = Math.round((box.height / 100) * imgHeight);

    const safeLeft = Math.max(0, Math.min(left, imgWidth - 1));
    const safeTop = Math.max(0, Math.min(top, imgHeight - 1));
    const safeWidth = Math.max(1, Math.min(width, imgWidth - safeLeft));
    const safeHeight = Math.max(1, Math.min(height, imgHeight - safeTop));

    const cropped = await sharp(imageBuffer)
      .extract({ left: safeLeft, top: safeTop, width: safeWidth, height: safeHeight })
      .png()
      .toBuffer();

    return cropped;
  } catch (err) {
    logger.warn({ err }, "extractStickerThumbnail: sharp crop failed");
    return null;
  }
}
