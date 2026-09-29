import { describe, expect, it } from "vitest";
import { compressFloristEvidenceImage } from "./FloristPhotoVerification";

describe("compressFloristEvidenceImage", () => {
  it("keeps a large accepted card photo byte-for-byte instead of re-encoding it", async () => {
    const original = {
      size: 8 * 1024 * 1024,
      type: "image/jpeg",
    } as File;

    await expect(
      compressFloristEvidenceImage(original, "card"),
    ).resolves.toBe(original);
  });
});