import { afterEach, describe, expect, it } from "vitest";
import {
  LEBANON_ACCOUNT_ID,
  LEBANON_CREATE_AND_UPDATE_SCOPE,
  LEBANON_CREATE_ONLY_SCOPE,
  LEBANON_CREATE_UPDATE_DELETE_SCOPE,
  LEBANON_DATA_SOURCE_ID,
  LEBANON_DATA_SOURCE_NAME,
  UAE_ACCOUNT_ID,
  UAE_CREATE_AND_UPDATE_SCOPE,
  UAE_CREATE_ONLY_SCOPE,
  UAE_DATA_SOURCE_ID,
  UAE_DATA_SOURCE_NAME,
  merchantExecutionAllows,
  merchantExecutionScopeSql,
  merchantExecutionScopeStatus,
} from "./merchantExecutionScope";

const exactLebanonTarget = {
  country: "LB" as const,
  accountId: LEBANON_ACCOUNT_ID,
  dataSourceId: LEBANON_DATA_SOURCE_ID,
  dataSourceName: LEBANON_DATA_SOURCE_NAME,
};

const exactUaeTarget = {
  country: "AE" as const,
  accountId: UAE_ACCOUNT_ID,
  dataSourceId: UAE_DATA_SOURCE_ID,
  dataSourceName: UAE_DATA_SOURCE_NAME,
};

afterEach(() => {
  delete process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED;
  delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE;
  delete process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE;
});

describe("Merchant execution scopes", () => {
  it("keeps LB_CREATE_ONLY restricted to exact Lebanon creates", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = LEBANON_CREATE_ONLY_SCOPE;

    expect(merchantExecutionAllows({ action: "CREATE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactLebanonTarget })).toBe(false);
    expect(merchantExecutionAllows({ action: "DELETE", ...exactLebanonTarget })).toBe(false);

    const claim = merchantExecutionScopeSql();
    expect(claim.clause).toContain("scoped_item.action='CREATE'");
    expect(claim.clause).not.toContain("scoped_item.action IN ('CREATE','UPDATE')");
    expect(claim.params).toEqual([
      LEBANON_ACCOUNT_ID,
      LEBANON_DATA_SOURCE_ID,
      LEBANON_DATA_SOURCE_NAME,
    ]);
  });

  it("allows only exact Lebanon creates and updates in LB_CREATE_AND_UPDATE", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = LEBANON_CREATE_AND_UPDATE_SCOPE;

    expect(merchantExecutionAllows({ action: "CREATE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "DELETE", ...exactLebanonTarget })).toBe(false);
    expect(merchantExecutionAllows({
      action: "UPDATE",
      ...exactLebanonTarget,
      country: "AE",
    })).toBe(false);
    expect(merchantExecutionAllows({
      action: "UPDATE",
      ...exactLebanonTarget,
      accountId: "other-account",
    })).toBe(false);
    expect(merchantExecutionAllows({
      action: "UPDATE",
      ...exactLebanonTarget,
      dataSourceId: "other-source",
    })).toBe(false);
    expect(merchantExecutionAllows({
      action: "UPDATE",
      ...exactLebanonTarget,
      dataSourceName: "accounts/5844806121/dataSources/other-source",
    })).toBe(false);

    const claim = merchantExecutionScopeSql();
    expect(claim.clause).toContain("scoped_item.action IN ('CREATE','UPDATE')");
    expect(claim.clause).toContain("merchant_sync_jobs.payload->>'executionScope'=$5");
    expect(claim.params).toEqual([
      LEBANON_ACCOUNT_ID,
      LEBANON_DATA_SOURCE_ID,
      LEBANON_DATA_SOURCE_NAME,
      LEBANON_CREATE_AND_UPDATE_SCOPE,
    ]);
  });

  it("makes the delete scope a strict Lebanon create/update/delete superset", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = LEBANON_CREATE_UPDATE_DELETE_SCOPE;

    expect(merchantExecutionAllows({ action: "CREATE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "DELETE", ...exactLebanonTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "DELETE", ...exactUaeTarget })).toBe(false);

    const claim = merchantExecutionScopeSql();
    expect(claim.clause).toContain("merchant_sync_jobs.operation='DELETE'");
    expect(claim.clause).toContain("scoped_item.action='DELETE'");
    expect(claim.clause).toContain("scoped_item.action IN ('CREATE','UPDATE')");
    expect(claim.params).toEqual([
      LEBANON_ACCOUNT_ID,
      LEBANON_DATA_SOURCE_ID,
      LEBANON_DATA_SOURCE_NAME,
      LEBANON_CREATE_UPDATE_DELETE_SCOPE,
    ]);
  });

  it("allows exact UAE writes independently of the Lebanon scope", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = LEBANON_CREATE_ONLY_SCOPE;
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = UAE_CREATE_AND_UPDATE_SCOPE;

    expect(merchantExecutionAllows({ action: "CREATE", ...exactUaeTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactUaeTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "DELETE", ...exactUaeTarget })).toBe(false);
    expect(merchantExecutionAllows({
      action: "UPDATE",
      ...exactUaeTarget,
      accountId: "other-account",
    })).toBe(false);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactLebanonTarget })).toBe(false);

    const claim = merchantExecutionScopeSql();
    expect(claim.clause).toContain("merchant_sync_jobs.offer_country='LB'");
    expect(claim.clause).toContain("merchant_sync_jobs.offer_country='AE'");
    expect(claim.clause).toContain("merchant_sync_jobs.payload->>'executionScope'=$8");
    expect(claim.params).toEqual([
      LEBANON_ACCOUNT_ID,
      LEBANON_DATA_SOURCE_ID,
      LEBANON_DATA_SOURCE_NAME,
      UAE_ACCOUNT_ID,
      UAE_DATA_SOURCE_ID,
      UAE_DATA_SOURCE_NAME,
      UAE_CREATE_AND_UPDATE_SCOPE,
    ]);
  });

  it("keeps AE create-only independent when Lebanon is unset", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE = UAE_CREATE_ONLY_SCOPE;

    expect(merchantExecutionAllows({ action: "CREATE", ...exactUaeTarget })).toBe(true);
    expect(merchantExecutionAllows({ action: "UPDATE", ...exactUaeTarget })).toBe(false);
    expect(merchantExecutionAllows({ action: "CREATE", ...exactLebanonTarget })).toBe(false);
    const claim = merchantExecutionScopeSql();
    expect(claim.clause).toContain("scoped_item.action='CREATE'");
    expect(claim.clause).toContain("payload->>'executionScope'=$5");
    expect(claim.params).toEqual([
      UAE_ACCOUNT_ID,
      UAE_DATA_SOURCE_ID,
      UAE_DATA_SOURCE_NAME,
      UAE_CREATE_ONLY_SCOPE,
    ]);
  });

  it("fails closed for unknown scopes and reports the active scope name", () => {
    process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED = "true";
    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = LEBANON_CREATE_AND_UPDATE_SCOPE;

    expect(merchantExecutionScopeStatus()).toEqual({
      executionEnabled: true,
      scopeConfigured: true,
      scopeName: LEBANON_CREATE_AND_UPDATE_SCOPE,
      lbCreateOnlyEnforced: false,
      lbCreateAndUpdateEnforced: true,
      lbCreateUpdateDeleteEnforced: false,
      aeScopeConfigured: false,
      aeScopeName: null,
      aeCreateOnlyEnforced: false,
      aeCreateAndUpdateEnforced: false,
    });

    process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE = "UNKNOWN_SCOPE";
    expect(merchantExecutionAllows({ action: "CREATE", ...exactLebanonTarget })).toBe(false);
    expect(merchantExecutionScopeSql()).toEqual({ clause: "FALSE", params: [] });
  });
});