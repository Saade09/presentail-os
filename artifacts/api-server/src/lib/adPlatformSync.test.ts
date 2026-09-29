import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db", () => ({
  db: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./credentialEncryption", () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.slice(4)),
}));

import { db } from "./db";
import {
  mapGoogleAdsRow,
  mapMetaInsightsRow,
  upsertSpendRows,
  PLATFORM_SOURCE,
  type SpendRow,
} from "./adPlatformSync";

const mockedDb = vi.mocked(db as unknown as {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
});

describe("mapGoogleAdsRow", () => {
  it("maps a report row to a daily spend entry", () => {
    const row = mapGoogleAdsRow(
      {
        campaign: { id: "123456", name: "Brand — UAE" },
        metrics: {
          costMicros: "12345678",
          impressions: "1000",
          clicks: "50",
          conversions: "3.4",
        },
        segments: { date: "2026-07-10" },
      },
      "AED",
    );
    expect(row).toEqual({
      channel: "google_ads",
      campaign: "Brand — UAE",
      campaignExternalId: "123456",
      date: "2026-07-10",
      spendAmount: 12.35,
      currency: "AED",
      impressions: 1000,
      clicks: 50,
      conversions: 3,
      source: "google_ads_api",
    });
  });

  it("falls back to a campaign-id label when the name is blank", () => {
    const row = mapGoogleAdsRow(
      {
        campaign: { id: 42, name: "  " },
        metrics: { costMicros: 1_000_000 },
        segments: { date: "2026-01-01" },
      },
      "USD",
    );
    expect(row?.campaign).toBe("Campaign 42");
  });

  it("skips zero-activity rows and rows missing date/campaign", () => {
    expect(
      mapGoogleAdsRow(
        {
          campaign: { id: "1", name: "x" },
          metrics: { costMicros: 0, impressions: 0, clicks: 0 },
          segments: { date: "2026-07-10" },
        },
        "USD",
      ),
    ).toBeNull();
    expect(mapGoogleAdsRow({ campaign: { id: "1" }, metrics: {} }, "USD")).toBeNull();
    expect(
      mapGoogleAdsRow({ metrics: {}, segments: { date: "2026-07-10" } }, "USD"),
    ).toBeNull();
  });

  it("keeps impression-only days (spend 0) so reach is recorded", () => {
    const row = mapGoogleAdsRow(
      {
        campaign: { id: "9", name: "Video" },
        metrics: { costMicros: 0, impressions: "12", clicks: 0 },
        segments: { date: "2026-07-01" },
      },
      "USD",
    );
    expect(row?.spendAmount).toBe(0);
    expect(row?.impressions).toBe(12);
  });
});

describe("mapMetaInsightsRow", () => {
  it("maps an insights row with purchase conversions", () => {
    const row = mapMetaInsightsRow(
      {
        campaign_id: "c-1",
        campaign_name: "Retargeting",
        spend: "45.678",
        impressions: "9000",
        clicks: "210",
        actions: [
          { action_type: "link_click", value: "180" },
          { action_type: "omni_purchase", value: "7" },
          { action_type: "purchase", value: "99" },
        ],
        date_start: "2026-07-09",
      },
      "USD",
    );
    expect(row).toEqual({
      channel: "meta_ads",
      campaign: "Retargeting",
      campaignExternalId: "c-1",
      date: "2026-07-09",
      spendAmount: 45.68,
      currency: "USD",
      impressions: 9000,
      clicks: 210,
      conversions: 7, // omni_purchase preferred over generic purchase
      source: "meta_api",
    });
  });

  it("prefers the first non-zero purchase action over a zero-valued one", () => {
    const row = mapMetaInsightsRow(
      {
        campaign_id: "c-3",
        campaign_name: "Mixed",
        spend: "20",
        impressions: "500",
        clicks: "30",
        actions: [
          { action_type: "omni_purchase", value: "0" },
          { action_type: "purchase", value: "4" },
        ],
        date_start: "2026-07-07",
      },
      "USD",
    );
    expect(row?.conversions).toBe(4);
  });

  it("keeps zero conversions when every purchase action is zero", () => {
    const row = mapMetaInsightsRow(
      {
        campaign_id: "c-4",
        campaign_name: "NoSales",
        spend: "20",
        impressions: "500",
        clicks: "30",
        actions: [{ action_type: "omni_purchase", value: "0" }],
        date_start: "2026-07-06",
      },
      "USD",
    );
    expect(row?.conversions).toBe(0);
  });

  it("returns null conversions when no purchase-type action exists", () => {
    const row = mapMetaInsightsRow(
      {
        campaign_id: "c-2",
        campaign_name: "Awareness",
        spend: "10",
        impressions: "100",
        clicks: "5",
        actions: [{ action_type: "link_click", value: "5" }],
        date_start: "2026-07-08",
      },
      "AED",
    );
    expect(row?.conversions).toBeNull();
  });

  it("skips zero-activity and malformed rows", () => {
    expect(
      mapMetaInsightsRow(
        { campaign_id: "c", spend: "0", impressions: "0", clicks: "0", date_start: "2026-07-01" },
        "USD",
      ),
    ).toBeNull();
    expect(mapMetaInsightsRow({ spend: "5", date_start: "2026-07-01" }, "USD")).toBeNull();
    expect(mapMetaInsightsRow({ campaign_id: "c", spend: "5" }, "USD")).toBeNull();
  });
});

describe("upsertSpendRows — precedence", () => {
  const clientQuery = vi.fn();
  const release = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedDb.connect.mockResolvedValue({ query: clientQuery, release });
  });

  const row: SpendRow = {
    channel: "google_ads",
    campaign: "Brand",
    campaignExternalId: "1",
    date: "2026-07-10",
    spendAmount: 10,
    currency: "USD",
    impressions: 100,
    clicks: 10,
    conversions: 1,
    source: PLATFORM_SOURCE.google_ads,
  };

  it("guards the ON CONFLICT UPDATE so only same-source rows are overwritten", async () => {
    clientQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
    const written = await upsertSpendRows("owner-1", [row]);
    expect(written).toBe(1);

    const insertCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO ad_spend_entries"),
    );
    expect(insertCall).toBeDefined();
    const sql = String(insertCall![0]);
    expect(sql).toMatch(/campaign_external_id = \$4/);
    // The precedence guard: only rows with the same API source are updated.
    expect(sql).toMatch(/AND source = \$11/);
    // Source is inserted so new rows are attributed to the API.
    expect(insertCall![1]).toContain("google_ads_api");
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("counts a conflicting manual row as not written (RETURNING empty)", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("INSERT INTO ad_spend_entries")) {
        return { rowCount: 0, rows: [] }; // guard blocked the update
      }
      return { rowCount: 0, rows: [] };
    });
    const written = await upsertSpendRows("owner-1", [row]);
    expect(written).toBe(0);
  });

  it("updates an API row by stable campaign ID when its display name changes", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("WITH updated AS")) {
        return { rowCount: 1, rows: [{ id: 7 }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const renamed = { ...row, campaign: "Brand — renamed" };
    expect(await upsertSpendRows("owner-1", [renamed])).toBe(1);
    const writeSql = String(
      clientQuery.mock.calls.find(([sql]) => String(sql).includes("WITH updated AS"))?.[0],
    );
    expect(writeSql).toContain("campaign_external_id = $4");
    expect(writeSql).toContain("SET campaign = $3");
  });

  it("rolls back and rethrows on failure", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("INSERT INTO")) throw new Error("boom");
      return { rowCount: 0, rows: [] };
    });
    await expect(upsertSpendRows("owner-1", [row])).rejects.toThrow("boom");
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });

  it("no-ops on an empty batch without connecting", async () => {
    expect(await upsertSpendRows("owner-1", [])).toBe(0);
    expect(mockedDb.connect).not.toHaveBeenCalled();
  });
});
