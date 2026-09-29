import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./reviewAttribution", () => ({ REWARD_PENDING_DAYS: 7 }));
vi.mock("./googleBusinessProfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./googleBusinessProfile")>();
  return {
    ...actual,
    decryptGbpCredentials: vi.fn().mockReturnValue({
      refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000,
    }),
    resolveGbpOauthClient: vi.fn().mockResolvedValue(null),
    getGbpAccessToken: vi.fn().mockResolvedValue("at"),
    listRecentGbpReviews: vi.fn(),
    fetchGbpReview: vi.fn(),
    fetchGbpLocation: vi.fn(),
    upsertFetchedReview: vi.fn().mockResolvedValue({ reviewId: 1, created: false }),
    handleDeletedReview: vi.fn().mockResolvedValue(true),
    clearGbpError: vi.fn(),
    recordGbpError: vi.fn(),
  };
});

import { db } from "./db";
import {
  listRecentGbpReviews,
  fetchGbpReview,
  fetchGbpLocation,
  handleDeletedReview,
  upsertFetchedReview,
} from "./googleBusinessProfile";
import { runGbpReconciliationTick } from "./gbpReconciliationJob";

const mockQuery = vi.mocked(db.query);
const mockList = vi.mocked(listRecentGbpReviews);
const mockFetch = vi.mocked(fetchGbpReview);
const mockLocation = vi.mocked(fetchGbpLocation);
const mockDeleted = vi.mocked(handleDeletedReview);
const mockUpsert = vi.mocked(upsertFetchedReview);

// Shape must match GbpLocationReconcileRow (joined from gbp_location_connections + gbp_connections).
const CONN = {
  location_id: 1,
  location_name: "locations/222",
  workspace_owner_id: "owner-1",
  location_synced_at: null,
  connection_id: 1,
  credentials_encrypted: "enc",
  account_name: "accounts/111",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockFetch.mockResolvedValue(null);
  mockLocation.mockResolvedValue(null);
});

describe("runGbpReconciliationTick — deletion provenance scoping", () => {
  it("only checks reviews ingested from the currently selected location and voids confirmed deletions", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONN], rowCount: 1 } as never) // connections
      .mockResolvedValueOnce({
        rows: [
          {
            google_review_id: "rev-current",
            gbp_review_name: "accounts/111/locations/222/reviews/rev-current",
          },
        ],
        rowCount: 1,
      } as never); // stored reviews (provenance-filtered)

    await runGbpReconciliationTick();

    // The stored-reviews query uses gbp_location_id (primary) and gbp_review_name
    // LIKE (fallback for NULL-location legacy rows), scoped to the current location.
    const storedCall = mockQuery.mock.calls[1];
    expect(String(storedCall[0])).toContain("gbp_location_id = $2");
    expect(String(storedCall[0])).toContain("gbp_review_name LIKE $3");
    expect(storedCall[1]).toEqual(["owner-1", 1, "accounts/111/locations/222/reviews/%"]);

    // Direct fetch uses the review's OWN stored resource name; 404 → voided.
    expect(mockFetch).toHaveBeenCalledWith(
      "at",
      "accounts/111/locations/222/reviews/rev-current",
    );
    expect(mockDeleted).toHaveBeenCalledWith("owner-1", "rev-current");
  });

  it("does not void reviews still present in the recent listing", async () => {
    mockList.mockResolvedValue([
      {
        name: "accounts/111/locations/222/reviews/rev-live",
        reviewId: "rev-live",
        reviewerName: null, rating: 5, comment: null,
        createTime: null, updateTime: null,
      },
    ]);
    mockQuery
      .mockResolvedValueOnce({ rows: [CONN], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            google_review_id: "rev-live",
            gbp_review_name: "accounts/111/locations/222/reviews/rev-live",
          },
        ],
        rowCount: 1,
      } as never);

    await runGbpReconciliationTick();

    expect(mockUpsert).toHaveBeenCalledTimes(1); // missed-notification catch-up
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDeleted).not.toHaveBeenCalled();
  });

  it("uses the per-location account_name for each location when a workspace has locations from two GBP accounts", async () => {
    // Two locations belonging to different GBP accounts.
    const LOC_A = { ...CONN, location_id: 1, location_name: "locations/222", account_name: "accounts/111" };
    const LOC_B = { ...CONN, location_id: 2, location_name: "locations/999", account_name: "accounts/888" };

    mockQuery
      .mockResolvedValueOnce({ rows: [LOC_A, LOC_B], rowCount: 2 } as never) // connections query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)              // stored-reviews for LOC_A
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)              // clearGbpLocationError for LOC_A
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)              // stored-reviews for LOC_B
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);             // clearGbpLocationError for LOC_B

    await runGbpReconciliationTick();

    // listRecentGbpReviews called twice — once per location with its OWN account.
    expect(mockList).toHaveBeenCalledTimes(2);
    const [callA, callB] = mockList.mock.calls;
    // First location uses accounts/111, second uses accounts/888.
    expect(callA[1]).toBe("accounts/111");
    expect(callA[2]).toBe("locations/222");
    expect(callB[1]).toBe("accounts/888");
    expect(callB[2]).toBe("locations/999");

    // Stored-reviews query for LOC_A uses LOC_A's account prefix.
    const storedCallA = mockQuery.mock.calls[1];
    expect(storedCallA[1]).toEqual(["owner-1", 1, "accounts/111/locations/222/reviews/%"]);

    // Stored-reviews query for LOC_B uses LOC_B's account prefix (not LOC_A's).
    const storedCallB = mockQuery.mock.calls[3];
    expect(storedCallB[1]).toEqual(["owner-1", 2, "accounts/888/locations/999/reviews/%"]);
  });

  it("refreshes legacy location metadata while preserving review reconciliation", async () => {
    mockLocation.mockResolvedValue({
      name: "locations/222",
      title: "Presentail",
      address: "Hamra Street 12, Beirut",
      verified: true,
      regionCode: "LB",
      locality: "Beirut",
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [CONN], rowCount: 1 } as never) // connections
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // metadata update
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // stored reviews
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // clear error

    await runGbpReconciliationTick();

    expect(mockLocation).toHaveBeenCalledWith("at", "locations/222");
    const metadataUpdate = mockQuery.mock.calls[1];
    expect(String(metadataUpdate[0])).toContain("location_locality = COALESCE($3, location_locality)");
    expect(metadataUpdate[1]).toEqual([1, "Presentail", "Beirut", "accounts/111", "Lebanon"]);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("continues review reconciliation when location metadata refresh fails", async () => {
    mockLocation.mockRejectedValue(new Error("GBP metadata unavailable"));
    mockQuery
      .mockResolvedValueOnce({ rows: [CONN], rowCount: 1 } as never) // connections
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // stored reviews
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // clear error

    await runGbpReconciliationTick();

    expect(mockList).toHaveBeenCalledWith(
      "at",
      "accounts/111",
      "locations/222",
      expect.any(Object),
    );
  });

  it("keeps stored metadata when Google omits optional location fields", async () => {
    const legacy = { ...CONN, account_name: null };
    mockLocation.mockResolvedValue({
      name: "locations/222",
      title: null,
      address: null,
      verified: true,
      regionCode: null,
      locality: null,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [legacy], rowCount: 1 } as never) // connections
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // metadata update
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // stored reviews
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // clear error

    await runGbpReconciliationTick();

    const metadataUpdate = mockQuery.mock.calls[1];
    const sql = String(metadataUpdate[0]);
    expect(sql).toContain("location_title = COALESCE($2, location_title)");
    expect(sql).toContain("location_locality = COALESCE($3, location_locality)");
    expect(sql).toContain("account_name = COALESCE($4, account_name)");
    expect(sql).toContain("country = COALESCE($5, country)");
    expect(metadataUpdate[1]).toEqual([1, null, null, null, null]);
    expect(mockList).toHaveBeenCalledTimes(1);
  });
});
