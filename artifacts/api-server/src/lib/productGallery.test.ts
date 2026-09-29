import { describe, expect, it, vi } from "vitest";
import {
  buildGalleryPrompt,
  classifyGalleryError,
  galleryFailureDisposition,
  GALLERY_TYPES,
  PRODUCT_GALLERY_FORMAT,
  PRODUCT_GALLERY_MODEL,
  PRODUCT_GALLERY_PROMPT_VERSION,
  PRODUCT_GALLERY_SIZE,
  withProductGalleryDeadline,
} from "./productGallery";

describe("product gallery provider contract", () => {
  it("supports only the four contracted gallery types", () => {
    expect(GALLERY_TYPES).toEqual([
      "alternative_composition",
      "close_up_details",
      "lifestyle_setting",
      "hand_held_scale",
    ]);
  });

  it("uses the configured image-edit model and versioned square WebP output", () => {
    expect(PRODUCT_GALLERY_MODEL).toBe("gpt-image-2");
    expect(PRODUCT_GALLERY_SIZE).toBe("1024x1024");
    expect(PRODUCT_GALLERY_FORMAT).toBe("webp");
    expect(PRODUCT_GALLERY_PROMPT_VERSION).toBe("product-gallery-fidelity-v2");
  });

  it("builds a product-aware prompt with the primary image as authority", () => {
    const prompt = buildGalleryPrompt("close_up_details", {
      name: "Rose Garden",
      category: "Flowers",
      description: "Pink and white arrangement",
      recipe: [
        { name: "Pink rose", quantity: "12" },
        { name: "White wrapping", quantity: 1 },
      ],
    });
    expect(prompt).toContain("Rose Garden");
    expect(prompt).toContain("Pink rose (12)");
    expect(prompt).toContain("primary image is the authoritative visual reference");
    expect(prompt).toContain("Preserve flower types");
    expect(prompt).toContain("TRUE CLOSE-UP DETAIL");
    expect(prompt).toContain("Fill approximately 85–95% of the square frame");
    expect(prompt).toContain("Do not merely add or emphasize a ribbon");
    expect(prompt).toContain(`Prompt version: ${PRODUCT_GALLERY_PROMPT_VERSION}`);
  });

  it("retries transient provider and storage errors but not moderation or corrupt media", () => {
    expect(classifyGalleryError({ status: 429, message: "rate limit" })).toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retryable: true,
    });
    expect(classifyGalleryError(new Error("request timed out"))).toMatchObject({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(classifyGalleryError(new Error("STORAGE_WRITE_FAILED"))).toMatchObject({
      code: "STORAGE_WRITE_FAILED",
      retryable: true,
    });
    expect(classifyGalleryError({ status: 400, message: "content policy moderation" })).toMatchObject({
      code: "MODERATION_REFUSAL",
      retryable: false,
    });
    expect(classifyGalleryError(new Error("INVALID_SOURCE_MEDIA"))).toMatchObject({
      code: "INVALID_SOURCE_MEDIA",
      retryable: false,
    });
  });

  it("aborts a hung provider call at the hard deadline", async () => {
    vi.useFakeTimers();
    const provider = vi.fn((signal: AbortSignal) => new Promise<Buffer>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const pending = withProductGalleryDeadline(provider, 250);
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
      code: "PROVIDER_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][0].aborted).toBe(true);
    vi.useRealTimers();
  });

  it("exposes when an abort-ignoring provider has actually settled", async () => {
    vi.useFakeTimers();
    let finishProvider!: () => void;
    const provider = vi.fn(() => new Promise<Buffer>((resolve) => {
      finishProvider = () => resolve(Buffer.from("late"));
    }));

    const pending = withProductGalleryDeadline(provider, 250);
    const rejection = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(250);
    const deadlineError = await rejection;
    let settled = false;
    void deadlineError.providerSettled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishProvider();
    await deadlineError.providerSettled;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it("returns delayed provider work before the deadline", async () => {
    vi.useFakeTimers();
    const pending = withProductGalleryDeadline(
      () => new Promise<Buffer>((resolve) => setTimeout(() => resolve(Buffer.from("draft")), 100)),
      250,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual(Buffer.from("draft"));
    vi.useRealTimers();
  });

  it("stops retrying timeout failures after the final attempt", () => {
    expect(galleryFailureDisposition(new Error("request timed out"), 2)).toMatchObject({
      status: "RETRY_WAITING",
      error: { code: "PROVIDER_TIMEOUT", retryable: true },
    });
    expect(galleryFailureDisposition(new Error("request timed out"), 3)).toMatchObject({
      status: "FAILED",
      error: { code: "PROVIDER_TIMEOUT", retryable: true },
    });
  });
});