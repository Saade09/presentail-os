import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  db: { query: vi.fn(), connect: vi.fn() },
  withTransaction: vi.fn(),
}));
vi.mock("./merchantCenterClient", () => ({
  getMerchantAccountConfig: vi.fn(),
  listGoogleProducts: vi.fn(),
  verifyMerchantAccountAccessForConfig: vi.fn(),
}));
vi.mock("./googleMerchant", () => ({
  buildMerchantProductInputForMarket: vi.fn(),
  slugifyProductName: vi.fn((name: string) => name.toLowerCase().replaceAll(" ", "-")),
}));
vi.mock("./merchantImagePreflight", () => ({
  preflightMerchantImages: vi.fn().mockResolvedValue({ ok: true, checked: 0, failures: [] }),
}));

import { db, withTransaction } from "./db";
import {
  applyApprovedDeleteBatch,
  applyApprovedRun,
  approveReconciliationRun,
  createMarketReconciliationDryRuns,
  getDesiredOffers,
  merchantReconciliationExecutionEnabled,
} from "./merchantReconciliation";
import { preflightMerchantImages } from "./merchantImagePreflight";
import {
  buildMerchantProductInputForMarket,
  slugifyProductName,
} from "./googleMerchant";
import {
  getMerchantAccountConfig,
  verifyMerchantAccountAccessForConfig,
} from "./merchantCenterClient";

describe("Merchant reconciliation execution gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED;
    delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE;
    delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE;
  });

  function mockApplyRunItems(rows: Array<{
    action: "CREATE" | "UPDATE" | "DELETE";
    country: "LB" | "AE";
    account_id: string;
    data_source_id: string;
    data_source_name: string;
  }>) {
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT i.action")) {
          return Promise.resolve({ rows, rowCount: rows.length });
        }
        if (sql.includes("SELECT j.operation")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes("INSERT INTO merchant_sync_jobs")) {
          const createOrUpdateCount = rows.filter(
            (row) => row.action === "CREATE" || row.action === "UPDATE",
          ).length;
          return Promise.resolve({ rows: [], rowCount: createOrUpdateCount });
        }
        if (sql.includes("SELECT COUNT(*)::text count")) {
          return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1 });
        }
        if (sql.includes("UPDATE merchant_reconciliation_runs")) {
          return Promise.resolve({ rows: [{ id: 10 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation(
      (async (_client: unknown, callback: (value: unknown) => Promise<unknown>) =>
        callback(client)) as never,
    );
    return client;
  }

  const lbTarget = {
    country: "LB" as const,
    account_id: "5844806121",
    data_source_id: "10717818285",
    data_source_name: "accounts/5844806121/dataSources/10717818285",
  };
  const aeTarget = {
    country: "AE" as const,
    account_id: "5689332635",
    data_source_id: "10717818297",
    data_source_name: "accounts/5689332635/dataSources/10717818297",
  };

  it("is disabled unless explicitly enabled", () => {
    expect(merchantReconciliationExecutionEnabled()).toBe(false);
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    expect(merchantReconciliationExecutionEnabled()).toBe(true);
  });

  it("does not treat the global flag alone as an executable scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation(
      (async (_client: unknown, callback: (value: unknown) => Promise<unknown>) =>
        callback(client)) as never,
    );

    await expect(applyApprovedRun("ws", 1)).rejects.toThrow(
      "outside the configured Merchant execution scope",
    );
  });

  it("refuses create application without touching the database", async () => {
    await expect(applyApprovedRun("ws", 1)).rejects.toThrow("execution is disabled");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses delete batches without touching the database", async () => {
    await expect(applyApprovedDeleteBatch("ws", 1, 25)).rejects.toThrow("execution is disabled");
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses every delete while Lebanon create-only scope is active", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    await expect(applyApprovedDeleteBatch("ws", 1, 25)).rejects.toThrow(
      "DELETE is forbidden",
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses every delete while Lebanon create-and-update scope is active", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    await expect(applyApprovedDeleteBatch("ws", 1, 25)).rejects.toThrow(
      "DELETE is forbidden",
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([24, 51])("rejects delete batch size %s before touching the database", async (batchSize) => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    await expect(applyApprovedDeleteBatch("ws", 1, batchSize)).rejects.toThrow(
      "between 25 and 50",
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it("queues exact Lebanon updates with the create-and-update scope binding", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT i.action")) {
          return Promise.resolve({
            rows: [{
              action: "UPDATE",
              country: "LB",
              account_id: "5844806121",
              data_source_id: "10717818285",
              data_source_name: "accounts/5844806121/dataSources/10717818285",
            }],
            rowCount: 1,
          });
        }
        if (sql.includes("SELECT j.operation")) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes("INSERT INTO merchant_sync_jobs")) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        if (sql.includes("SELECT COUNT(*)::text count")) {
          return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1 });
        }
        if (sql.includes("UPDATE merchant_reconciliation_runs")) {
          return Promise.resolve({ rows: [{ id: 303 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation(
      (async (_client: unknown, callback: (value: unknown) => Promise<unknown>) =>
        callback(client)) as never,
    );

    await expect(applyApprovedRun("ws", 303)).resolves.toBe(1);

    const queueCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"));
    expect(String(queueCall?.[0])).toContain("'executionScope',$3::text");
    expect(queueCall?.[1]).toEqual([303, "ws", "LB_CREATE_AND_UPDATE"]);
  });

  it("queues exact UAE updates with the independent UAE scope binding", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = "AE_CREATE_AND_UPDATE";
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT i.action")) {
          return Promise.resolve({
            rows: [{
              action: "UPDATE",
              country: "AE",
              account_id: "5689332635",
              data_source_id: "10717818297",
              data_source_name: "accounts/5689332635/dataSources/10717818297",
            }],
            rowCount: 1,
          });
        }
        if (sql.includes("SELECT j.operation")) return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql.includes("INSERT INTO merchant_sync_jobs")) return Promise.resolve({ rows: [], rowCount: 1 });
        if (sql.includes("SELECT COUNT(*)::text count")) return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1 });
        if (sql.includes("UPDATE merchant_reconciliation_runs")) {
          return Promise.resolve({ rows: [{ id: 305 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation(
      (async (_client: unknown, callback: (value: unknown) => Promise<unknown>) =>
        callback(client)) as never,
    );

    await expect(applyApprovedRun("ws", 305)).resolves.toBe(1);
    const queueCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"));
    expect(queueCall?.[1]).toEqual([305, "ws", "AE_CREATE_AND_UPDATE"]);
  });

  it("applies a DELETE-only Lebanon run under LB_CREATE_UPDATE_DELETE", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    const client = mockApplyRunItems([{ action: "DELETE", ...lbTarget }]);

    await expect(applyApprovedRun("ws", 10)).resolves.toBe(0);

    const scopeQuery = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT i.action"));
    expect(String(scopeQuery?.[0])).toContain(
      "i.action IN ('CREATE','UPDATE','DELETE')",
    );
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE merchant_reconciliation_runs"))).toBe(true);
  });

  it.each([
    {
      name: "Lebanon create-only",
      lbScope: "LB_CREATE_ONLY",
      aeScope: undefined,
      item: { action: "DELETE" as const, ...lbTarget },
    },
    {
      name: "Lebanon create-and-update",
      lbScope: "LB_CREATE_AND_UPDATE",
      aeScope: undefined,
      item: { action: "DELETE" as const, ...lbTarget },
    },
    {
      name: "UAE create-only",
      lbScope: undefined,
      aeScope: "AE_CREATE_ONLY",
      item: { action: "DELETE" as const, ...aeTarget },
    },
    {
      name: "UAE create-and-update",
      lbScope: undefined,
      aeScope: "AE_CREATE_AND_UPDATE",
      item: { action: "DELETE" as const, ...aeTarget },
    },
  ])("rejects a DELETE-only run under $name scope", async ({ lbScope, aeScope, item }) => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    if (lbScope) process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = lbScope;
    if (aeScope) process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = aeScope;
    const client = mockApplyRunItems([item]);

    await expect(applyApprovedRun("ws", 10)).rejects.toThrow(
      "outside the configured Merchant execution scope",
    );
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"))).toBe(false);
  });

  it("applies a mixed CREATE+DELETE Lebanon run under LB_CREATE_UPDATE_DELETE", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    const client = mockApplyRunItems([
      { action: "CREATE", ...lbTarget },
      { action: "DELETE", ...lbTarget },
    ]);

    await expect(applyApprovedRun("ws", 10)).resolves.toBe(1);
    const queueCall = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"));
    expect(queueCall?.[1]).toEqual([10, "ws", "LB_CREATE_UPDATE_DELETE"]);
  });

  it.each([
    {
      name: "Lebanon create-only",
      lbScope: "LB_CREATE_ONLY",
      aeScope: undefined,
      target: lbTarget,
    },
    {
      name: "Lebanon create-and-update",
      lbScope: "LB_CREATE_AND_UPDATE",
      aeScope: undefined,
      target: lbTarget,
    },
    {
      name: "UAE create-only",
      lbScope: undefined,
      aeScope: "AE_CREATE_ONLY",
      target: aeTarget,
    },
    {
      name: "UAE create-and-update",
      lbScope: undefined,
      aeScope: "AE_CREATE_AND_UPDATE",
      target: aeTarget,
    },
  ])("rejects a mixed CREATE+DELETE run under $name scope", async ({
    lbScope,
    aeScope,
    target,
  }) => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    if (lbScope) process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = lbScope;
    if (aeScope) process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = aeScope;
    const client = mockApplyRunItems([
      { action: "CREATE", ...target },
      { action: "DELETE", ...target },
    ]);

    await expect(applyApprovedRun("ws", 10)).rejects.toThrow(
      "outside the configured Merchant execution scope",
    );
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"))).toBe(false);
  });

  it("queues guarded Lebanon deletes only under the explicit delete scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{
          country: "LB",
          account_id: "5844806121",
          data_source_id: "10717818285",
          data_source_name: "accounts/5844806121/dataSources/10717818285",
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    vi.mocked(getMerchantAccountConfig).mockReturnValue({
      country: "LB",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    });

    await expect(applyApprovedDeleteBatch("ws", 306, 25)).resolves.toBe(1);
    const insertCall = vi.mocked(db.query).mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"));
    const insertSql = String(insertCall?.[0]);
    expect(insertSql).toContain("'executionScope',$4::text");
    expect(insertSql).toContain("r.status='APPLIED'");
    expect(insertSql).toContain("COALESCE((r.summary->>'blocked')::boolean,FALSE) IS FALSE");
    expect(insertSql).toContain("i.delete_approved IS TRUE");
    expect(insertSql).toContain("i.last_offer_approved IS TRUE");
    expect(insertSql).toContain("replacement.approval_status='APPROVED'");
    expect(insertSql).toContain("replacement.is_owned IS TRUE");
    expect(insertSql).toContain("replacement.deleted_at IS NULL");
    expect(insertSql).toContain("ORDER BY i.id");
    expect(insertSql).toContain("LIMIT $3");
    expect(insertCall?.[1]).toEqual([306, "ws", 25, "LB_CREATE_UPDATE_DELETE"]);
  });

  it("refuses an active job that was queued under another scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT i.action")) {
          return Promise.resolve({
            rows: [{
              action: "UPDATE",
              country: "LB",
              account_id: "5844806121",
              data_source_id: "10717818285",
              data_source_name: "accounts/5844806121/dataSources/10717818285",
            }],
            rowCount: 1,
          });
        }
        if (sql.includes("SELECT j.operation")) {
          return Promise.resolve({
            rows: [{
              operation: "CREATE_OR_UPDATE",
              status: "RUNNING",
              action: "UPDATE",
              execution_scope: "LB_CREATE_ONLY",
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation(
      (async (_client: unknown, callback: (value: unknown) => Promise<unknown>) =>
        callback(client)) as never,
    );

    await expect(applyApprovedRun("ws", 304)).rejects.toThrow(
      "queued under a different execution scope",
    );
    expect(client.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO merchant_sync_jobs"))).toBe(false);
  });
});

describe("multi-market reconciliation validation", () => {
  beforeEach(() => {
    delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE;
  });

  it("rejects approval when the exact submitted image fails crawl preflight", async () => {
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [{ payload: { productAttributes: { imageLink: "https://presentail.com/api/storage/public-objects/missing.jpg" } } }],
      rowCount: 1,
    } as never);
    vi.mocked(preflightMerchantImages).mockResolvedValueOnce({
      ok: false,
      checked: 1,
      failures: [{
        url: "https://presentail.com/api/storage/public-objects/missing.jpg",
        reason: "Googlebot is blocked by robots.txt",
      }],
    });

    await expect(approveReconciliationRun("ws", 44, "owner")).rejects.toThrow(
      "Merchant image preflight failed",
    );
    expect(db.query).toHaveBeenCalledOnce();
  });

  it("approves only after every submitted image passes preflight", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [{ payload: { productAttributes: { imageLink: "https://os.presentail.com/api/storage/public-objects/products/1/main.webp" } } }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    vi.mocked(preflightMerchantImages).mockResolvedValueOnce({
      ok: true,
      checked: 1,
      failures: [],
    });

    await expect(approveReconciliationRun("ws", 45, "owner")).resolves.toBe(true);
    expect(vi.mocked(db.query).mock.calls.some(([sql]) =>
      String(sql).includes("SET status='APPROVED'"))).toBe(true);
  });

  it("uses the storefront name slug when an active publication has no stored slug", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{
        id: 228,
        sku: "8046004",
        name: "Big Pink Baby Rose Bouquet",
        is_archived: false,
        merchant_sync_disabled: false,
        has_publication: true,
        country_excluded: false,
        default_city_excluded: false,
        price_usd: "10",
        price_aed: "37",
        main_image_url: "https://example.com/rose.jpg",
        image_public_path: null,
        additional_image_urls: [],
        additional_image_public_paths: [],
        description: "Rose bouquet",
        description_ar: null,
        brand: null,
        google_product_category: null,
        public_slug: null,
        status: "available",
      }],
      rowCount: 1,
    } as never);
    vi.mocked(buildMerchantProductInputForMarket).mockReturnValue({
      offerId: "8046004-LB",
      contentLanguage: "en",
      feedLabel: "LB",
      productAttributes: {} as never,
    });

    const offers = await getDesiredOffers("ws", "LB", "en");

    expect(slugifyProductName).toHaveBeenCalledWith("Big Pink Baby Rose Bouquet");
    expect(buildMerchantProductInputForMarket).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ country: "LB", city: "beirut" }),
      "big-pink-baby-rose-bouquet",
    );
    expect(offers).toHaveLength(1);
    expect(offers[0].action).toBe("CREATE");
  });

  it("uses the shared public object host for promoted Merchant images", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{
        id: 1041,
        sku: "9943239",
        name: "Birthday Boy Grand Celebration",
        is_archived: false,
        merchant_sync_disabled: false,
        has_publication: true,
        country_excluded: false,
        default_city_excluded: false,
        price_usd: "300",
        price_aed: "1160",
        main_image_url: "/objects/owner/products/source.png",
        image_public_path: "products/1041/main.png",
        additional_image_urls: ["/objects/owner/products/1041/second.png"],
        additional_image_public_paths: ["products/1041/second.png"],
        description: "Birthday arrangement",
        description_ar: null,
        brand: "Presentail Flowers & Gifts",
        google_product_category: null,
        public_slug: "birthday-boy-grand-celebration",
        status: "available",
      }],
      rowCount: 1,
    } as never);
    vi.mocked(buildMerchantProductInputForMarket).mockReturnValue({
      offerId: "9943239-LB",
      contentLanguage: "en",
      feedLabel: "LB",
      productAttributes: {} as never,
    });

    await getDesiredOffers("ws", "LB", "en");

    expect(buildMerchantProductInputForMarket).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImageUrl: "https://os.presentail.com/api/storage/public-objects/products/1041/main.png",
        additionalImageUrls: [
          "https://os.presentail.com/api/storage/public-objects/products/1041/second.png",
        ],
      }),
      expect.objectContaining({ country: "LB", city: "beirut" }),
      "birthday-boy-grand-celebration",
    );
  });

  it("prefers the promoted public copy over a legacy HTTPS storefront URL", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{
        id: 1042, sku: "9943240", name: "Reachable Rose", is_archived: false,
        merchant_sync_disabled: false, has_publication: true, country_excluded: false,
        default_city_excluded: false, price_usd: "30", price_aed: "110",
        main_image_url: "https://presentail.com/api/storage/public-objects/products/1042/main.png",
        image_public_path: "products/1042/main.png", additional_image_urls: [],
        additional_image_public_paths: [], description: "Rose", description_ar: null,
        brand: null, google_product_category: null, public_slug: "reachable-rose",
        status: "available",
      }],
      rowCount: 1,
    } as never);
    vi.mocked(buildMerchantProductInputForMarket).mockReturnValue({
      offerId: "9943240-LB", contentLanguage: "en", feedLabel: "LB",
      productAttributes: {} as never,
    });

    await getDesiredOffers("ws", "LB", "en");

    expect(buildMerchantProductInputForMarket).toHaveBeenCalledWith(
      expect.objectContaining({
        mainImageUrl: "https://os.presentail.com/api/storage/public-objects/products/1042/main.png",
      }),
      expect.any(Object),
      "reachable-rose",
    );
  });

  it("reports one market failure without hiding the other market", async () => {
    vi.mocked(getMerchantAccountConfig).mockImplementation((country) => {
      if (country === "LB") throw new Error("LB destination is invalid");
      return {
        country,
        accountId: "uae-account",
        dataSourceId: "uae-source",
        dataSourceName: "accounts/uae-account/dataSources/uae-source",
      };
    });
    vi.mocked(verifyMerchantAccountAccessForConfig).mockResolvedValue({ ok: true, detail: {} });
    vi.mocked(db.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    vi.mocked(db.connect).mockRejectedValue(new Error("stop after market validation"));

    const results = await createMarketReconciliationDryRuns("ws", "owner", ["AE", "LB"], "en");

    expect(results).toEqual([
      expect.objectContaining({ country: "AE", ok: false }),
      { country: "LB", ok: false, error: "LB destination is invalid" },
    ]);
    expect(results[0].error).not.toContain("LB destination is invalid");
  });

  it("treats an equivalent already-queued market job as an idempotent rerun", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes("SELECT i.action")) {
          return Promise.resolve({
            rows: [{
              action: "CREATE",
              country: "LB",
              account_id: "5844806121",
              data_source_id: "10717818285",
              data_source_name: "accounts/5844806121/dataSources/10717818285",
            }],
            rowCount: 1,
          });
        }
        if (sql.includes("SELECT j.operation")) {
          return Promise.resolve({ rows: [{ operation: "CREATE_OR_UPDATE", status: "PENDING", action: "CREATE" }], rowCount: 1 });
        }
        if (sql.includes("INSERT INTO merchant_sync_jobs")) return Promise.resolve({ rows: [], rowCount: 0 });
        if (sql.includes("SELECT COUNT(*)::text count")) return Promise.resolve({ rows: [{ count: "0" }], rowCount: 1 });
        if (sql.includes("UPDATE merchant_reconciliation_runs")) return Promise.resolve({ rows: [{ id: 202 }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(client as never);
    vi.mocked(withTransaction).mockImplementation((async (_client: unknown, callback: (value: unknown) => Promise<unknown>) => callback(client)) as never);

    await expect(applyApprovedRun("ws", 202)).resolves.toBe(0);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("j.payload->'stateIdentity'=i.state_identity"),
      [202, "ws"],
    );
    expect(client.release).toHaveBeenCalled();
  });
});