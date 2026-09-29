import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./db", () => ({ db: { query: vi.fn() } }));
vi.mock("./merchantCenterClient", () => ({
  insertProductInput: vi.fn(), insertProductInputForConfig: vi.fn(), deleteProductInputForConfig: vi.fn(),
  fetchProductStatus: vi.fn(), fetchProductStatusForConfig: vi.fn(), validateMerchantConfig: vi.fn(),
  getMerchantAccountConfig: vi.fn(),
}));
vi.mock("./merchantReconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./merchantReconciliation")>();
  return { ...actual, allDesiredOffersApproved: vi.fn() };
});
vi.mock("./objectStorage", () => ({ buildPublicObjectUrl: vi.fn() }));
vi.mock("./productPublicImages", () => ({ syncProductPublicImages: vi.fn() }));

import { db } from "./db";
import {
  deleteProductInputForConfig,
  fetchProductStatusForConfig,
  getMerchantAccountConfig,
  insertProductInput,
  insertProductInputForConfig,
} from "./merchantCenterClient";
import { allDesiredOffersApproved } from "./merchantReconciliation";
import {
  checkPendingOfferApprovals,
  parseGoogleOfferApproval,
  processPendingJobs,
} from "./merchantSyncJob";

const query = vi.mocked(db.query);
const insertLegacy = vi.mocked(insertProductInput);
const insertGuarded = vi.mocked(insertProductInputForConfig);
const deleteGuarded = vi.mocked(deleteProductInputForConfig);
const fetchGuardedStatus = vi.mocked(fetchProductStatusForConfig);
const approvalsReady = vi.mocked(allDesiredOffersApproved);
const accountConfig = vi.mocked(getMerchantAccountConfig);
const payload = {
  offerId: "SKU1-LB", contentLanguage: "en", feedLabel: "LB",
  productAttributes: {
    title: "Rose", description: "Rose", link: "https://presentail.com/en-lb/beirut/product/rose",
    imageLink: "https://cdn.example/rose.jpg", availability: "IN_STOCK",
    price: { amount: 10, amountMicros: "10000000", currencyCode: "USD" },
    identifierExists: false, condition: "NEW" as const,
  },
};

function install(jobPayload: Record<string, unknown>, attempts = 1, currentStateMatches = true): void {
  query.mockImplementation(async (statement: unknown) => {
    const sql = String(statement);
    if (sql.includes("WITH claimed")) return { rows: [{ id: "job-1", product_id: 1, operation: "CREATE_OR_UPDATE", payload: jobPayload }], rowCount: 1 } as never;
    if (sql.includes("FROM merchant_sync_jobs j JOIN merchant_reconciliation_items")) {
      const identity = jobPayload.stateIdentity as Record<string, unknown> | undefined;
      return identity && currentStateMatches ? { rows: [{ workspace_owner_id: "ws", action: jobPayload.action ?? "CREATE", country: jobPayload.country, content_language: jobPayload.contentLanguage, offer_id: jobPayload.offerId, payload: identity.payload, payload_hash: identity.payloadHash, account_id: identity.accountId, data_source_id: identity.dataSourceId, data_source_name: identity.dataSourceName }], rowCount: 1 } as never : { rows: [], rowCount: 0 } as never;
    }
    if (sql.includes("FROM products WHERE id = ANY")) return { rows: [], rowCount: 0 } as never;
    if (sql.includes("FROM delivery_settings") || sql.includes("FROM product_publications")) return { rows: [], rowCount: 0 } as never;
    if (sql.includes("SELECT attempts")) return { rows: [{ attempts }], rowCount: 1 } as never;
    return { rows: [], rowCount: 1 } as never;
  });
}

function installDelete(replacement: Record<string, unknown> | null): void {
  query.mockImplementation(async (statement: unknown) => {
    const sql = String(statement);
    if (sql.includes("WITH claimed")) {
      return {
        rows: [{
          id: "delete-job",
          product_id: 1,
          operation: "DELETE",
          payload: {
            reconciliationItemId: 20,
            offerId: "OLD-LB",
            country: "LB",
            contentLanguage: "en",
            executionScope: "LB_CREATE_UPDATE_DELETE",
            stateIdentity: {
              accountId: "5844806121",
              dataSourceId: "10717818285",
              dataSourceName: "accounts/5844806121/dataSources/10717818285",
              replacement,
            },
          },
        }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes("FROM products WHERE id = ANY")) return { rows: [], rowCount: 0 } as never;
    if (sql.includes("FROM merchant_reconciliation_items i")) {
      return {
        rows: [{
          merchant_resource_name: "accounts/5844806121/products/en~LB~OLD-LB",
          account_id: "5844806121",
          data_source_id: "10717818285",
          data_source_name: "accounts/5844806121/dataSources/10717818285",
          country: "LB",
          workspace_owner_id: "ws",
          product_id: 1,
        }],
        rowCount: 1,
      } as never;
    }
    if (sql.includes("SELECT merchant_resource_name,workspace_owner_id,product_id")) {
      return { rows: [{ merchant_resource_name: "accounts/new/products/en~LB~NEW-LB", workspace_owner_id: "ws", product_id: 1 }], rowCount: 1 } as never;
    }
    return { rows: [], rowCount: 1 } as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
  delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE;
  delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE;
  approvalsReady.mockResolvedValue(true);
  accountConfig.mockImplementation((country) => ({
    country,
    accountId: country === "LB" ? "123" : "ae-account",
    dataSourceId: country === "LB" ? "456" : "ae-source",
    dataSourceName: country === "LB"
      ? "accounts/123/dataSources/456"
      : "accounts/ae-account/dataSources/ae-source",
  }));
});

describe("merchant worker guarded reconciliation delete", () => {
  const replacement = {
    accountId: "new",
    dataSourceId: "new-ds",
    dataSourceName: "accounts/new/dataSources/new-ds",
    country: "LB",
    contentLanguage: "en",
    offerId: "NEW-LB",
    payloadHash: "replacement-hash",
  };

  it("makes zero Google delete calls when the global market gate regresses", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    installDelete(replacement);
    approvalsReady.mockResolvedValue(false);
    await processPendingJobs();
    expect(fetchGuardedStatus).not.toHaveBeenCalled();
    expect(deleteGuarded).not.toHaveBeenCalled();
  });

  it("makes zero Google delete calls when live Free Listings approval is revoked", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    installDelete(replacement);
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [{
          reportingContext: "FREE_LISTINGS",
          approvedCountries: [],
          disapprovedCountries: ["LB"],
        }],
      },
    });
    await processPendingJobs();
    expect(fetchGuardedStatus).toHaveBeenCalledOnce();
    expect(deleteGuarded).not.toHaveBeenCalled();
  });

  it("deletes only after both live approval contexts remain approved", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_UPDATE_DELETE";
    installDelete(replacement);
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: ["LB"] },
        ],
      },
    });

    await processPendingJobs();

    expect(fetchGuardedStatus).toHaveBeenCalledOnce();
    expect(deleteGuarded).toHaveBeenCalledOnce();
  });
});

describe("merchant worker guarded reconciliation create", () => {
  it("allows only the hard-bound Lebanon CREATE destination in scoped mode", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    const stateIdentity = {
      payload,
      payloadHash: "hash-1",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    };
    accountConfig.mockReturnValue({
      country: "LB",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    });
    install({
      reconciliationItemId: 9,
      offerId: "SKU1-LB",
      country: "LB",
      contentLanguage: "en",
      stateIdentity,
    });
    insertGuarded.mockResolvedValue({
      name: "accounts/5844806121/productInputs/online~en~LB~SKU1-LB",
    });

    await processPendingJobs();

    expect(insertGuarded).toHaveBeenCalledOnce();
    const claimSql = String(query.mock.calls[1]?.[0] ?? "");
    expect(claimSql).toContain("scoped_item.action='CREATE'");
    expect(claimSql).toContain("merchant_sync_jobs.offer_country='LB'");
  });

  it("rejects UAE and UPDATE writes in Lebanon create-only scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    const stateIdentity = {
      payload,
      payloadHash: "hash-1",
      accountId: "5689332635",
      dataSourceId: "10717818297",
      dataSourceName: "accounts/5689332635/dataSources/10717818297",
    };
    install({
      reconciliationItemId: 9,
      offerId: "SKU1-AE",
      country: "AE",
      contentLanguage: "en",
      stateIdentity,
    });

    await processPendingJobs();

    expect(insertGuarded).not.toHaveBeenCalled();
  });

  it("claims and submits an exact UAE UPDATE under the independent UAE scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = "AE_CREATE_AND_UPDATE";
    const stateIdentity = {
      payload: { ...payload, offerId: "SKU1-AE", feedLabel: "AE" },
      payloadHash: "ae-hash-2",
      predecessorPayloadHash: "ae-hash-1",
      accountId: "5689332635",
      dataSourceId: "10717818297",
      dataSourceName: "accounts/5689332635/dataSources/10717818297",
    };
    accountConfig.mockReturnValue({
      country: "AE",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    });
    install({
      action: "UPDATE",
      reconciliationItemId: 12,
      offerId: "SKU1-AE",
      country: "AE",
      contentLanguage: "en",
      executionScope: "AE_CREATE_AND_UPDATE",
      stateIdentity,
    });
    insertGuarded.mockResolvedValue({
      name: "accounts/5689332635/productInputs/online~en~AE~SKU1-AE",
    });

    await processPendingJobs();

    expect(insertGuarded).toHaveBeenCalledOnce();
    const claimSql = String(query.mock.calls[1]?.[0] ?? "");
    expect(claimSql).toContain("merchant_sync_jobs.offer_country='LB'");
    expect(claimSql).toContain("merchant_sync_jobs.offer_country='AE'");
  });

  it("claims and submits an exact Lebanon UPDATE in create-and-update scope", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    const stateIdentity = {
      payload,
      payloadHash: "hash-2",
      predecessorPayloadHash: "hash-1",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    };
    accountConfig.mockReturnValue({
      country: "LB",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    });
    install({
      action: "UPDATE",
      reconciliationItemId: 10,
      offerId: "SKU1-LB",
      country: "LB",
      contentLanguage: "en",
      executionScope: "LB_CREATE_AND_UPDATE",
      stateIdentity,
    });
    insertGuarded.mockResolvedValue({
      name: "accounts/5844806121/productInputs/online~en~LB~SKU1-LB",
    });

    await processPendingJobs();

    expect(insertGuarded).toHaveBeenCalledOnce();
    const claimSql = String(query.mock.calls[1]?.[0] ?? "");
    expect(claimSql).toContain("scoped_item.action IN ('CREATE','UPDATE')");
    expect(claimSql).toContain("payload->>'executionScope'=$5");
  });

  it("refuses a job bound to a different scope immediately before Google", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    const stateIdentity = {
      payload,
      payloadHash: "hash-2",
      predecessorPayloadHash: "hash-1",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    };
    accountConfig.mockReturnValue({
      country: "LB",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    });
    install({
      action: "UPDATE",
      reconciliationItemId: 11,
      offerId: "SKU1-LB",
      country: "LB",
      contentLanguage: "en",
      executionScope: "LB_CREATE_ONLY",
      stateIdentity,
    });

    await processPendingJobs();

    expect(insertGuarded).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("status = 'FAILED'"))).toBe(true);
  });

  it("refuses an unguarded legacy create without either Google operation", async () => {
    install({});
    await processPendingJobs();
    expect(insertLegacy).not.toHaveBeenCalled();
    expect(insertGuarded).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([s]) => String(s).includes("status = 'FAILED'"))).toBe(true);
  });

  it("inserts exactly the approved explicit payload/config and upserts offer state", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_ONLY";
    const stateIdentity = {
      payload,
      payloadHash: "hash-1",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    };
    accountConfig.mockReturnValue({
      country: "LB",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    });
    install({ reconciliationItemId: 9, offerId: "SKU1-LB", country: "LB", contentLanguage: "en", stateIdentity });
    insertGuarded.mockResolvedValue({ name: "accounts/5844806121/productInputs/online~en~LB~SKU1-LB" });
    await processPendingJobs();
    expect(insertGuarded).toHaveBeenCalledWith({
      country: "LB",
      accountId: stateIdentity.accountId,
      dataSourceId: stateIdentity.dataSourceId,
      dataSourceName: stateIdentity.dataSourceName,
    }, payload);
    expect(query.mock.calls.some(([s]) => String(s).includes("INSERT INTO merchant_offer_states"))).toBe(true);
    expect(query.mock.calls.some(([s]) => String(s).includes("status = 'COMPLETED'"))).toBe(true);
  });

  it("fails guarded transient and permanent errors without falling back to legacy Google", async () => {
    const stateIdentity = { payload, payloadHash: "h", accountId: "1", dataSourceId: "2", dataSourceName: "accounts/1/dataSources/2" };
    install({ reconciliationItemId: 9, offerId: "SKU1-LB", country: "LB", contentLanguage: "en", stateIdentity });
    insertGuarded.mockRejectedValue(new Error("socket reset"));
    await processPendingJobs();
    expect(insertLegacy).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([s]) => String(s).includes("status = 'FAILED'"))).toBe(true);
  });

  it("refuses UPDATE when the reviewed owned offer was deleted before execution", async () => {
    const stateIdentity = { payload, payloadHash: "new", predecessorPayloadHash: "old", accountId: "1", dataSourceId: "2", dataSourceName: "accounts/1/dataSources/2" };
    install({ reconciliationItemId: 9, offerId: "SKU1-LB", country: "LB", contentLanguage: "en", stateIdentity }, 1, false);
    await processPendingJobs();
    expect(insertGuarded).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([s]) => String(s).includes("status = 'FAILED'"))).toBe(true);
  });
});

describe("merchant approval polling scopes", () => {
  it("polls both hard-bound markets while preserving Lebanon parameter positions", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = "AE_CREATE_AND_UPDATE";
    query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await checkPendingOfferApprovals();

    const selectCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM merchant_offer_states")
      && String(sql).includes("ORDER BY COALESCE(approval_checked_at,last_synced_at)"));
    expect(String(selectCall?.[0])).toContain(
      "country='LB' AND account_id=$2 AND data_source_id=$3 AND data_source_name=$4",
    );
    expect(String(selectCall?.[0])).toContain(
      "country='AE' AND account_id=$5 AND data_source_id=$6 AND data_source_name=$7",
    );
    expect(selectCall?.[1]).toEqual([
      20,
      "5844806121",
      "10717818285",
      "accounts/5844806121/dataSources/10717818285",
      "5689332635",
      "10717818297",
      "accounts/5689332635/dataSources/10717818297",
    ]);
  });

  it("rechecks DISAPPROVED offers hourly without changing fast polling or timeout semantics", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await checkPendingOfferApprovals();

    const timeoutCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("SET approval_status='TIMED_OUT'"));
    expect(String(timeoutCall?.[0])).toContain(
      "approval_status IN ('PENDING','VERIFYING','ERROR')",
    );
    expect(String(timeoutCall?.[0])).not.toContain("approval_status='DISAPPROVED'");
    expect(String(timeoutCall?.[0])).not.toContain(
      "AND approval_status='TIMED_OUT'",
    );

    const selectCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT workspace_owner_id,product_id")
      && String(sql).includes("FROM merchant_offer_states"));
    expect(String(selectCall?.[0])).toContain(
      "(approval_status IN ('PENDING','VERIFYING','ERROR') AND approval_deadline_at > now())",
    );
    expect(String(selectCall?.[0])).toContain("approval_status='DISAPPROVED'");
    expect(String(selectCall?.[0])).toContain(
      "approval_checked_at <= now() - INTERVAL '1 hour'",
    );
    expect(String(selectCall?.[0])).toContain("approval_status='TIMED_OUT'");
    expect(String(selectCall?.[0])).toContain(
      "approval_checked_at <= now() - INTERVAL '6 hours'",
    );
    expect(String(selectCall?.[0])).toContain(
      "NULLIF(merchant_resource_name,'') IS NOT NULL",
    );
  });

  it("updates a rechecked DISAPPROVED offer when Google now approves it", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{
          workspace_owner_id: "ws",
          product_id: 283,
          country: "LB",
          content_language: "en",
          account_id: "5844806121",
          data_source_id: "10717818285",
          data_source_name: "accounts/5844806121/dataSources/10717818285",
          offer_id: "0053279-LB",
          merchant_resource_name: "accounts/5844806121/productInputs/en~LB~0053279-LB",
          approval_status: "DISAPPROVED",
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: ["LB"] },
        ],
        itemLevelIssues: [],
      },
    });

    await checkPendingOfferApprovals();

    expect(fetchGuardedStatus).toHaveBeenCalledWith(
      {
        country: "LB",
        accountId: "5844806121",
        dataSourceId: "10717818285",
        dataSourceName: "accounts/5844806121/dataSources/10717818285",
      },
      "accounts/5844806121/products/en~LB~0053279-LB",
    );
    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("approval_evidence=$2::jsonb,approval_checked_at=now()"));
    expect(updateCall?.[1]?.[0]).toBe("APPROVED");
    expect(String(updateCall?.[0])).toContain("approval_checked_at=now()");
    const updateParams = updateCall?.[1] as unknown[] | undefined;
    expect(updateParams?.slice(2)).toEqual([
      "ws", 283, "LB", "en", "5844806121", "10717818285", "0053279-LB",
    ]);
  });

  it("keeps a rechecked DISAPPROVED offer blocked when Google still disapproves it", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{
          workspace_owner_id: "ws",
          product_id: 453,
          country: "LB",
          content_language: "en",
          account_id: "5844806121",
          data_source_id: "10717818285",
          data_source_name: "accounts/5844806121/dataSources/10717818285",
          offer_id: "1850253-LB",
          merchant_resource_name: "accounts/5844806121/productInputs/en~LB~1850253-LB",
          approval_status: "DISAPPROVED",
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", disapprovedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", disapprovedCountries: ["LB"] },
        ],
        itemLevelIssues: [{
          code: "landing_page_error",
          reportingContext: "FREE_LISTINGS",
          affectedCountries: ["LB"],
          servability: "NOT_SERVABLE",
        }],
      },
    });

    await checkPendingOfferApprovals();

    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("approval_evidence=$2::jsonb,approval_checked_at=now()"));
    expect(updateCall?.[1]?.[0]).toBe("DISAPPROVED");
    expect(String(updateCall?.[1]?.[1])).toContain("landing_page_error");
    expect(String(updateCall?.[0])).toContain(
      "Google reports this offer as disapproved; deletion remains blocked",
    );
  });

  it("preserves DISAPPROVED evidence when an hourly Google recheck fails", async () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{
          workspace_owner_id: "ws",
          product_id: 453,
          country: "LB",
          content_language: "en",
          account_id: "5844806121",
          data_source_id: "10717818285",
          data_source_name: "accounts/5844806121/dataSources/10717818285",
          offer_id: "1850253-LB",
          merchant_resource_name: "accounts/5844806121/productInputs/en~LB~1850253-LB",
          approval_status: "DISAPPROVED",
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    fetchGuardedStatus.mockRejectedValue(new Error("temporary Google outage"));

    await checkPendingOfferApprovals();

    const errorUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("WHEN $1='DISAPPROVED' THEN 'DISAPPROVED'"));
    expect(errorUpdate?.[1]?.[0]).toBe("DISAPPROVED");
    expect(String(errorUpdate?.[0])).toContain(
      "WHEN $1 IN ('DISAPPROVED','TIMED_OUT') THEN approval_evidence",
    );
    expect(errorUpdate?.[1]?.[2]).toBe("temporary Google outage");
  });

  const timedOutOffer = {
    workspace_owner_id: "ws",
    product_id: 1017,
    country: "LB",
    content_language: "en",
    account_id: "5844806121",
    data_source_id: "10717818285",
    data_source_name: "accounts/5844806121/dataSources/10717818285",
    offer_id: "6679545-LB",
    merchant_resource_name: "accounts/5844806121/productInputs/en~LB~6679545-LB",
    approval_status: "TIMED_OUT",
  };

  function selectTimedOutOffer(): void {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "LB_CREATE_AND_UPDATE";
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [timedOutOffer], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
  }

  it("updates a TIMED_OUT offer and evidence when Google approves both required contexts", async () => {
    selectTimedOutOffer();
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: ["LB"] },
        ],
        itemLevelIssues: [],
      },
    });

    await checkPendingOfferApprovals();

    expect(fetchGuardedStatus).toHaveBeenCalledWith(
      {
        country: "LB", accountId: timedOutOffer.account_id,
        dataSourceId: timedOutOffer.data_source_id,
        dataSourceName: timedOutOffer.data_source_name,
      },
      "accounts/5844806121/products/en~LB~6679545-LB",
    );
    const update = query.mock.calls.find(([sql]) =>
      String(sql).includes("approval_evidence=$2::jsonb,approval_checked_at=now()"));
    expect(update?.[1]?.[0]).toBe("APPROVED");
    expect(JSON.parse(String(update?.[1]?.[1])).contexts).toMatchObject({
      FREE_LISTINGS: { approved: true },
      SHOPPING_ADS: { approved: true },
    });
    const updateParams = update?.[1] as unknown[] | undefined;
    expect(updateParams?.slice(2)).toEqual([
      "ws", 1017, "LB", "en", "5844806121", "10717818285", "6679545-LB",
    ]);
  });

  it("keeps TIMED_OUT when Google still reports pending, refreshing evidence without resetting the deadline", async () => {
    selectTimedOutOffer();
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", pendingCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", pendingCountries: ["LB"] },
        ],
        itemLevelIssues: [],
      },
    });

    await checkPendingOfferApprovals();

    const update = query.mock.calls.find(([sql]) =>
      String(sql).includes("approval_evidence=$2::jsonb,approval_checked_at=now()"));
    expect(update?.[1]?.[0]).toBe("VERIFYING");
    expect(String(update?.[0])).toContain(
      "WHEN $1='VERIFYING' AND approval_deadline_at <= now() THEN 'TIMED_OUT'",
    );
    expect(String(update?.[0])).not.toContain("SET approval_deadline_at=");
    expect(JSON.parse(String(update?.[1]?.[1])).contexts).toMatchObject({
      FREE_LISTINGS: { pending: true, approved: false },
      SHOPPING_ADS: { pending: true, approved: false },
    });
  });

  it("moves TIMED_OUT to DISAPPROVED only when Google actually disapproves", async () => {
    selectTimedOutOffer();
    fetchGuardedStatus.mockResolvedValue({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", disapprovedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", disapprovedCountries: ["LB"] },
        ],
        itemLevelIssues: [],
      },
    });

    await checkPendingOfferApprovals();

    const update = query.mock.calls.find(([sql]) =>
      String(sql).includes("approval_evidence=$2::jsonb,approval_checked_at=now()"));
    expect(update?.[1]?.[0]).toBe("DISAPPROVED");
    expect(JSON.parse(String(update?.[1]?.[1])).contexts.FREE_LISTINGS.disapproved).toBe(true);
  });

  it("retains TIMED_OUT and the last Google evidence when its recheck fails", async () => {
    selectTimedOutOffer();
    fetchGuardedStatus.mockRejectedValue(new Error("temporary Google outage"));

    await checkPendingOfferApprovals();

    const update = query.mock.calls.find(([sql]) =>
      String(sql).includes("WHEN $1='TIMED_OUT' THEN 'TIMED_OUT'"));
    expect(update?.[1]?.[0]).toBe("TIMED_OUT");
    expect(String(update?.[0])).toContain(
      "WHEN $1 IN ('DISAPPROVED','TIMED_OUT') THEN approval_evidence",
    );
    expect(update?.[1]?.[2]).toBe("temporary Google outage");
  });
});

describe("Google offer approval evidence", () => {
  it("requires the target country in approvedCountries", () => {
    expect(parseGoogleOfferApproval({
      productStatus: {
        destinationStatuses: [{
          reportingContext: "FREE_LISTINGS",
          approvedCountries: ["LB"],
          pendingCountries: [],
          disapprovedCountries: [],
        }],
      },
    }, "LB").status).toBe("VERIFYING");

    expect(parseGoogleOfferApproval({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["LB"], pendingCountries: [], disapprovedCountries: [] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: ["LB"], pendingCountries: [], disapprovedCountries: [] },
        ],
      },
    }, "LB").status).toBe("APPROVED");
  });

  it("never treats a target-country disapproval as approved", () => {
    expect(parseGoogleOfferApproval({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["AE"], pendingCountries: [], disapprovedCountries: [] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: [], pendingCountries: [], disapprovedCountries: ["AE"] },
        ],
      },
    }, "AE").status).toBe("DISAPPROVED");
  });

  it("does not let an unrelated non-blocking issue override explicit approval", () => {
    expect(parseGoogleOfferApproval({
      productStatus: {
        destinationStatuses: [
          { reportingContext: "FREE_LISTINGS", approvedCountries: ["LB"] },
          { reportingContext: "SHOPPING_ADS", approvedCountries: ["LB"] },
        ],
        itemLevelIssues: [{ affectedCountries: ["AE"], servability: "NOT_SERVABLE" }],
      },
    }, "LB").status).toBe("APPROVED");
  });
});