const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * Resolves a catalog item image URL to a fully-rooted path the browser can fetch.
 * Returns null for absent values, absolute http(s) URLs unchanged, and maps
 * storage-relative paths through ${BASE_PATH}/api/storage.
 */
export function imageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/objects/")) return `${BASE_PATH}/api/storage${url}`;
  return `${BASE_PATH}/api/storage${url}`;
}

export type ProductImageLike = {
  main_image_url?: string | null;
  main_image_display_url?: string | null;
  main_image_thumbnail_url?: string | null;
  main_image_display_public_url?: string | null;
  main_image_thumbnail_public_url?: string | null;
};

/** Resolve the optimized product image first, preserving the original fallback. */
export function productImageUrl(
  product: ProductImageLike,
  variant: "display" | "thumbnail",
): string | null {
  const optimized =
    variant === "thumbnail"
      ? product.main_image_thumbnail_url ?? product.main_image_thumbnail_public_url
      : product.main_image_display_url ?? product.main_image_display_public_url;
  return imageUrl(optimized ?? product.main_image_url);
}

/** Swap a failed derivative to the original once, then reveal its placeholder. */
export function fallbackToOriginalProductImage(
  image: HTMLImageElement,
  originalUrl: string | null | undefined,
): void {
  const fallback = imageUrl(originalUrl);
  if (fallback && image.dataset.originalFallback !== "true") {
    image.dataset.originalFallback = "true";
    image.src = fallback;
    return;
  }
  image.style.display = "none";
}
