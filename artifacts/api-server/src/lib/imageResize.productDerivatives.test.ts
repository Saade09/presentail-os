import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  generateProductImageDerivatives,
  PRODUCT_IMAGE_DISPLAY_MAX_EDGE,
  PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE,
} from "./imageResize";

describe("generateProductImageDerivatives", () => {
  it("preserves aspect ratio while bounding large display and thumbnail output", async () => {
    const source = await sharp({
      create: {
        width: 2000,
        height: 1000,
        channels: 3,
        background: "#d94f70",
      },
    })
      .jpeg()
      .toBuffer();

    const result = await generateProductImageDerivatives(source);
    const display = await sharp(result.display).metadata();
    const thumbnail = await sharp(result.thumbnail).metadata();

    expect(display).toMatchObject({
      format: "webp",
      width: PRODUCT_IMAGE_DISPLAY_MAX_EDGE,
      height: PRODUCT_IMAGE_DISPLAY_MAX_EDGE / 2,
    });
    expect(thumbnail).toMatchObject({
      format: "webp",
      width: PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE,
      height: PRODUCT_IMAGE_THUMBNAIL_MAX_EDGE / 2,
    });
  });

  it("does not upscale already-small transparent images", async () => {
    const source = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();

    const result = await generateProductImageDerivatives(source);
    const display = await sharp(result.display).metadata();
    const thumbnail = await sharp(result.thumbnail).metadata();

    expect(display).toMatchObject({ width: 40, height: 20, hasAlpha: true });
    expect(thumbnail).toMatchObject({ width: 40, height: 20, hasAlpha: true });
  });

  it("rejects invalid image bytes without producing a derivative", async () => {
    await expect(
      generateProductImageDerivatives(Buffer.from("not an image")),
    ).rejects.toThrow();
  });
});