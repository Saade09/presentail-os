import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based.
//
// `backfillTable` issues, per catalog-attribute table:
//   1. drizzleDb.select({...}).from(table).where(...)   → rows to backfill
//   2. for each row: drizzleDb.update(table).set({...}).where(...)
//
// The whole-batch entry point processes the four tables in BACKFILL_TABLES
// order: occasions, catalog_categories, catalog_brands, recipients. Each
// table's SELECT pops one entry off the shared queue, so push results in
// that order.
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

const mockUpdateSet = vi.fn(() => ({ where: () => Promise.resolve(undefined) }));
const mockUpdate = vi.fn((..._args: unknown[]) => ({ set: mockUpdateSet }));

vi.mock("./drizzle", () => ({
  drizzleDb: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(popResult()) }),
    }),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockCopyToPublic = vi.fn();

vi.mock("./objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: (...args: unknown[]) => mockCopyToPublic(...args),
  },
}));

import { backfillOccasionPublicImages } from "./backfillOccasionPublicImages";

beforeEach(() => {
  vi.clearAllMocks();
  drizzleQueue.length = 0;
});

describe("backfillOccasionPublicImages — catalog_brands", () => {
  it("mirrors a pre-existing brand image into the public bucket and persists the key", async () => {
    mockCopyToPublic.mockResolvedValue("catalog_brands/7.jpg");

    drizzleQueue.push([]); // occasions
    drizzleQueue.push([]); // catalog_categories
    drizzleQueue.push([
      {
        id: 7,
        imageUrl: "/objects/owner_1/uploads/abc-uuid",
        workspaceOwnerId: "owner_1",
      },
    ]); // catalog_brands
    drizzleQueue.push([]); // recipients

    await backfillOccasionPublicImages();

    // Copies the migrated /objects/... private image into the public bucket
    // under the brand's stable key.
    expect(mockCopyToPublic).toHaveBeenCalledTimes(1);
    expect(mockCopyToPublic).toHaveBeenCalledWith(
      "/objects/owner_1/uploads/abc-uuid",
      "catalog_brands/7",
      "owner_1",
    );

    // Persists the resulting public key onto the row.
    expect(mockUpdateSet).toHaveBeenCalledWith({ imagePublicPath: "catalog_brands/7.jpg" });
  });

  it("is idempotent: does nothing when no rows need a public copy", async () => {
    // WHERE clause (image_url NOT NULL AND image_public_path IS NULL) already
    // filtered everything out on a repeat startup → all tables return empty.
    drizzleQueue.push([], [], [], []);

    await backfillOccasionPublicImages();

    expect(mockCopyToPublic).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("continues to the next row when one brand image copy fails", async () => {
    mockCopyToPublic
      .mockRejectedValueOnce(new Error("source missing"))
      .mockResolvedValueOnce("catalog_brands/9.jpg");

    drizzleQueue.push([]); // occasions
    drizzleQueue.push([]); // catalog_categories
    drizzleQueue.push([
      { id: 8, imageUrl: "/objects/owner_1/uploads/broken", workspaceOwnerId: "owner_1" },
      { id: 9, imageUrl: "/objects/owner_1/uploads/ok", workspaceOwnerId: "owner_1" },
    ]); // catalog_brands
    drizzleQueue.push([]); // recipients

    await backfillOccasionPublicImages();

    expect(mockCopyToPublic).toHaveBeenCalledTimes(2);
    // Only the successful row persists a key.
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ imagePublicPath: "catalog_brands/9.jpg" });
  });
});
