import { describe, it, expect } from "vitest";
import { imageUrl } from "./imageUrl";

describe("imageUrl", () => {
  it("returns null for null", () => {
    expect(imageUrl(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(imageUrl(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(imageUrl("")).toBeNull();
  });

  it("returns absolute http URLs unchanged", () => {
    const url = "http://example.com/image.png";
    expect(imageUrl(url)).toBe(url);
  });

  it("returns absolute https URLs unchanged", () => {
    const url = "https://cdn.example.com/assets/photo.jpg";
    expect(imageUrl(url)).toBe(url);
  });

  it("maps /objects/ paths through /api/storage", () => {
    const result = imageUrl("/objects/abc123.png");
    expect(result).toBe("/api/storage/objects/abc123.png");
  });

  it("maps other relative paths through /api/storage", () => {
    const result = imageUrl("/uploads/photo.webp");
    expect(result).toBe("/api/storage/uploads/photo.webp");
  });
});
