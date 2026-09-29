import sharp from "sharp";

/** Maximum edge lengths for product images used in catalog surfaces. */
export const PRODUCT_IMAGE_DISPLAY_MAX_EDGE = 1200;
export const PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE = 320;

export type ProductImageDerivatives = {
  display: Buffer;
  thumbnail: Buffer;
};

/**
 * Create the bounded product-image representations used by the dashboard and
 * ordering surfaces. `rotate()` applies EXIF orientation before resizing and
 * removes the orientation metadata, while `inside` preserves the complete
 * product and its aspect ratio. WebP keeps alpha for transparent PNG/WebP
 * uploads and avoids making a second, lossy original.
 */
export async function generateProductImageDerivatives(
  buffer: Buffer,
): Promise<ProductImageDerivatives> {
  const source = sharp(buffer, { animated: false }).rotate();
  const [display, thumbnail] = await Promise.all([
    source
      .clone()
      .resize({
        width: PRODUCT_IMAGE_DISPLAY_MAX_EDGE,
        height: PRODUCT_IMAGE_DISPLAY_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer(),
    source
      .clone()
      .resize({
        width: PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE,
        height: PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 76, effort: 4 })
      .toBuffer(),
  ]);

  return { display, thumbnail };
}

// ---------------------------------------------------------------------------
// IBackgroundExtender — interface for background-fill strategies
// ---------------------------------------------------------------------------

export interface IBackgroundExtender {
  /**
   * Resize `input` to exactly `targetWidth × targetHeight` using a
   * background-fill strategy that keeps the full product visible.
   */
  extend(
    input: Buffer,
    targetWidth: number,
    targetHeight: number,
    format: "jpeg" | "png" | "webp",
  ): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Level 1 — BlurredBackgroundExtender (no external dependencies)
// ---------------------------------------------------------------------------

export class BlurredBackgroundExtender implements IBackgroundExtender {
  async extend(
    input: Buffer,
    targetWidth: number,
    targetHeight: number,
    format: "jpeg" | "png" | "webp",
  ): Promise<Buffer> {
    // Step 1: blurred background — cover + strong Gaussian blur
    const blurredBackground = await sharp(input)
      .resize(targetWidth, targetHeight, { fit: "cover", position: "centre" })
      .blur(25)
      .toBuffer();

    // Step 2: contained product layer — fully visible, transparent padding
    const containedProduct = await sharp(input)
      .resize(targetWidth, targetHeight, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    // Step 3: composite product centered over blurred background
    const composed = await sharp(blurredBackground)
      .composite([{ input: containedProduct, gravity: "centre" }])
      [format]()
      .toBuffer();

    return composed;
  }
}

// ---------------------------------------------------------------------------
// Level 2 — AIBackgroundExtender stub (placeholder for future AI outpainting)
// ---------------------------------------------------------------------------

/**
 * Placeholder for AI-powered outpainting/background extension.
 *
 * To wire in a real provider:
 * 1. Implement the `extend` method using your chosen API
 *    (e.g. OpenAI image-edit, Replicate, Cloudinary AI, Stability AI).
 * 2. Register it at server startup:
 *    `BackgroundExtenderRegistry.setProvider(new AIBackgroundExtender())`
 *
 * No API key or paid service is added until a provider is approved.
 */
export class AIBackgroundExtender implements IBackgroundExtender {
  async extend(
    _input: Buffer,
    _targetWidth: number,
    _targetHeight: number,
    _format: "jpeg" | "png" | "webp",
  ): Promise<Buffer> {
    throw new Error(
      "AI background extension not configured — register a provider via BackgroundExtenderRegistry.setProvider()",
    );
  }
}

// ---------------------------------------------------------------------------
// BackgroundExtenderRegistry — singleton, defaults to BlurredBackgroundExtender
// ---------------------------------------------------------------------------

class _BackgroundExtenderRegistry {
  private provider: IBackgroundExtender = new BlurredBackgroundExtender();

  setProvider(extender: IBackgroundExtender): void {
    this.provider = extender;
  }

  getProvider(): IBackgroundExtender {
    return this.provider;
  }
}

export const BackgroundExtenderRegistry = new _BackgroundExtenderRegistry();

// ---------------------------------------------------------------------------
// smartResizeBuffer — single public entry point for all resize callers
// ---------------------------------------------------------------------------

/**
 * Resize `buffer` to exactly `width × height` using a smart pipeline:
 * - If the image's aspect ratio already matches the target (within 1%),
 *   a simple `fit: "contain"` resize is used (no compositing needed).
 * - Otherwise, delegates to the active `BackgroundExtenderRegistry` provider
 *   (default: `BlurredBackgroundExtender`) which fills empty space with a
 *   blurred version of the original image.
 */
export async function smartResizeBuffer(
  buffer: Buffer,
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp",
): Promise<Buffer> {
  const { width: origWidth, height: origHeight } = await sharp(buffer).metadata();

  if (origWidth && origHeight) {
    const sourceRatio = origWidth / origHeight;
    const targetRatio = width / height;
    const diff = Math.abs(sourceRatio - targetRatio) / targetRatio;

    if (diff < 0.01) {
      // Aspect ratios match within 1% — plain contain resize is sufficient
      return sharp(buffer)
        .resize(width, height, { fit: "contain" })
        [format]()
        .toBuffer();
    }
  }

  return BackgroundExtenderRegistry.getProvider().extend(buffer, width, height, format);
}
