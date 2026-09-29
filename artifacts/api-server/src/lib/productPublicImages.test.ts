import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  copy: vi.fn(),
  getFile: vi.fn(),
  save: vi.fn(),
  derivatives: vi.fn(),
}));

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mocks.dbQuery(...args) },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./imageResize", () => ({
  generateProductImageDerivatives: (...args: unknown[]) =>
    mocks.derivatives(...args),
}));
vi.mock("./objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: (...args: unknown[]) => mocks.copy(...args),
    getObjectEntityFile: (...args: unknown[]) => mocks.getFile(...args),
    savePublicObject: (...args: unknown[]) => mocks.save(...args),
  },
}));

import {
  backfillProductPublicImages,
  syncProductPublicImages,
} from "./productPublicImages";

describe("product public image derivatives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copy.mockImplementation(
      (_source: string, key: string) => Promise.resolve(`${key}.jpg`),
    );
    mocks.getFile.mockResolvedValue({
      download: () => Promise.resolve([Buffer.from("source")]),
    });
    mocks.derivatives.mockResolvedValue({
      display: Buffer.from("display"),
      thumbnail: Buffer.from("thumbnail"),
    });
    mocks.save.mockImplementation((key: string) => Promise.resolve(key));
    mocks.dbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("stores versioned display and thumbnail paths while preserving originals", async () => {
    await syncProductPublicImages(
      42,
      "/objects/owner/uploads/main",
      ["/objects/owner/uploads/second"],
      "owner",
    );

    expect(mocks.save).toHaveBeenCalledTimes(4);
    expect(mocks.save.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^products\/42\/main-display-[a-f0-9]{16}\.webp$/,
        ),
        expect.stringMatching(
          /^products\/42\/main-thumbnail-[a-f0-9]{16}\.webp$/,
        ),
      ]),
    );
    const persisted = mocks.dbQuery.mock.calls.at(-1)?.[1];
    expect(persisted[0]).toBe("products/42/main.jpg");
    expect(persisted[2]).toMatch(/main-display-[a-f0-9]{16}\.webp$/);
    expect(persisted[3]).toMatch(/main-thumbnail-[a-f0-9]{16}\.webp$/);
    expect(persisted[8]).toBe("/objects/owner/uploads/main");
    expect(persisted[9]).toEqual(["/objects/owner/uploads/second"]);
    expect(mocks.dbQuery.mock.calls.at(-1)?.[0]).toContain(
      "main_image_url IS NOT DISTINCT FROM $9",
    );
  });

  it("does not fetch external images for derivative processing", async () => {
    await syncProductPublicImages(
      42,
      "https://images.example.com/product.jpg",
      [],
      "owner",
    );

    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.derivatives).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("selects failed derivative rows again so temporary failures retry", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            workspace_owner_id: "owner",
            main_image_url: "/objects/owner/uploads/main",
            additional_image_urls: [],
          },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await backfillProductPublicImages();

    expect(mocks.dbQuery.mock.calls[0][0]).toContain(
      "image_thumbnail_public_path IS NULL",
    );
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});