export const LEBANON_CREATE_ONLY_SCOPE = "LB_CREATE_ONLY";
export const LEBANON_CREATE_AND_UPDATE_SCOPE = "LB_CREATE_AND_UPDATE";
export const LEBANON_CREATE_UPDATE_DELETE_SCOPE = "LB_CREATE_UPDATE_DELETE";
export const UAE_CREATE_ONLY_SCOPE = "AE_CREATE_ONLY";
export const UAE_CREATE_AND_UPDATE_SCOPE = "AE_CREATE_AND_UPDATE";

export const LEBANON_ACCOUNT_ID = "5844806121";
export const LEBANON_DATA_SOURCE_ID = "10717818285";
export const LEBANON_DATA_SOURCE_NAME =
  "accounts/5844806121/dataSources/10717818285";
export const UAE_ACCOUNT_ID = "5689332635";
export const UAE_DATA_SOURCE_ID = "10717818297";
export const UAE_DATA_SOURCE_NAME =
  "accounts/5689332635/dataSources/10717818297";

export type MerchantExecutionAction = "CREATE" | "UPDATE" | "DELETE";

export interface MerchantExecutionTarget {
  action: MerchantExecutionAction;
  country: "LB" | "AE";
  accountId: string;
  dataSourceId: string;
  dataSourceName: string;
}

export function merchantReconciliationExecutionEnabled(): boolean {
  return process.env.MERCHANT_RECONCILIATION_EXECUTION_ENABLED === "true";
}

export function merchantExecutionScope(): string | null {
  return process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE?.trim() || null;
}

export function merchantExecutionScopeAe(): string | null {
  return process.env.MERCHANT_RECONCILIATION_EXECUTION_SCOPE_AE?.trim() || null;
}

export function merchantExecutionScopeStatus(): {
  executionEnabled: boolean;
  scopeConfigured: boolean;
  scopeName: string | null;
  lbCreateOnlyEnforced: boolean;
  lbCreateAndUpdateEnforced: boolean;
  lbCreateUpdateDeleteEnforced: boolean;
  aeScopeConfigured: boolean;
  aeScopeName: string | null;
  aeCreateOnlyEnforced: boolean;
  aeCreateAndUpdateEnforced: boolean;
} {
  const executionEnabled = merchantReconciliationExecutionEnabled();
  const scopeName = merchantExecutionScope();
  const aeScopeName = merchantExecutionScopeAe();
  return {
    executionEnabled,
    scopeConfigured: scopeName !== null,
    scopeName,
    lbCreateOnlyEnforced:
      executionEnabled && scopeName === LEBANON_CREATE_ONLY_SCOPE,
    lbCreateAndUpdateEnforced:
      executionEnabled && scopeName === LEBANON_CREATE_AND_UPDATE_SCOPE,
    lbCreateUpdateDeleteEnforced:
      executionEnabled && scopeName === LEBANON_CREATE_UPDATE_DELETE_SCOPE,
    aeScopeConfigured: aeScopeName !== null,
    aeScopeName,
    aeCreateOnlyEnforced:
      executionEnabled && aeScopeName === UAE_CREATE_ONLY_SCOPE,
    aeCreateAndUpdateEnforced:
      executionEnabled && aeScopeName === UAE_CREATE_AND_UPDATE_SCOPE,
  };
}

/**
 * Fail closed whenever an explicit scope is configured. The first production
 * scope is deliberately hard-bound to the empty Lebanon account and its
 * dedicated data source; configuration drift cannot silently redirect writes.
 */
export function merchantExecutionAllows(target: MerchantExecutionTarget): boolean {
  if (!merchantReconciliationExecutionEnabled()) return false;
  if (target.country === "LB") {
    const scope = merchantExecutionScope();
    const actionAllowed =
      (scope === LEBANON_CREATE_ONLY_SCOPE && target.action === "CREATE")
      || (scope === LEBANON_CREATE_AND_UPDATE_SCOPE
        && (target.action === "CREATE" || target.action === "UPDATE"))
      || (scope === LEBANON_CREATE_UPDATE_DELETE_SCOPE
        && (target.action === "CREATE" || target.action === "UPDATE" || target.action === "DELETE"));
    return actionAllowed
      && target.accountId === LEBANON_ACCOUNT_ID
      && target.dataSourceId === LEBANON_DATA_SOURCE_ID
      && target.dataSourceName === LEBANON_DATA_SOURCE_NAME;
  }
  const scope = merchantExecutionScopeAe();
  const actionAllowed =
    (scope === UAE_CREATE_ONLY_SCOPE && target.action === "CREATE")
    || (scope === UAE_CREATE_AND_UPDATE_SCOPE
      && (target.action === "CREATE" || target.action === "UPDATE"));
  return actionAllowed
    && target.accountId === UAE_ACCOUNT_ID
    && target.dataSourceId === UAE_DATA_SOURCE_ID
    && target.dataSourceName === UAE_DATA_SOURCE_NAME;
}

export function merchantExecutionScopeSql(): {
  clause: string;
  params: string[];
} {
  if (!merchantReconciliationExecutionEnabled()) {
    return { clause: "FALSE", params: [] };
  }
  const clauses: string[] = [];
  const params: string[] = [];
  const parameter = (value: string): string => {
    params.push(value);
    return `$${params.length + 1}`;
  };

  const lbScope = merchantExecutionScope();
  if (lbScope === LEBANON_CREATE_ONLY_SCOPE) {
    const account = parameter(LEBANON_ACCOUNT_ID);
    const dataSource = parameter(LEBANON_DATA_SOURCE_ID);
    const dataSourceName = parameter(LEBANON_DATA_SOURCE_NAME);
    clauses.push(`merchant_sync_jobs.operation='CREATE_OR_UPDATE'
      AND merchant_sync_jobs.offer_country='LB'
      AND merchant_sync_jobs.payload->'stateIdentity'->>'accountId'=${account}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceId'=${dataSource}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceName'=${dataSourceName}
      AND EXISTS (
        SELECT 1 FROM merchant_reconciliation_items scoped_item
        WHERE scoped_item.id=merchant_sync_jobs.reconciliation_item_id
          AND scoped_item.action='CREATE'
          AND scoped_item.country='LB'
      )`);
  } else if (
    lbScope === LEBANON_CREATE_AND_UPDATE_SCOPE
    || lbScope === LEBANON_CREATE_UPDATE_DELETE_SCOPE
  ) {
    const account = parameter(LEBANON_ACCOUNT_ID);
    const dataSource = parameter(LEBANON_DATA_SOURCE_ID);
    const dataSourceName = parameter(LEBANON_DATA_SOURCE_NAME);
    const scope = parameter(lbScope);
    const operationClause = lbScope === LEBANON_CREATE_UPDATE_DELETE_SCOPE
      ? `((merchant_sync_jobs.operation='CREATE_OR_UPDATE' AND scoped_item.action IN ('CREATE','UPDATE'))
            OR (merchant_sync_jobs.operation='DELETE' AND scoped_item.action='DELETE'))`
      : `merchant_sync_jobs.operation='CREATE_OR_UPDATE'
          AND scoped_item.action IN ('CREATE','UPDATE')`;
    clauses.push(`merchant_sync_jobs.offer_country='LB'
      AND merchant_sync_jobs.payload->>'executionScope'=${scope}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'accountId'=${account}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceId'=${dataSource}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceName'=${dataSourceName}
      AND EXISTS (
        SELECT 1 FROM merchant_reconciliation_items scoped_item
        WHERE scoped_item.id=merchant_sync_jobs.reconciliation_item_id
          AND ${operationClause}
          AND scoped_item.country='LB'
      )`);
  }

  const aeScope = merchantExecutionScopeAe();
  if (aeScope === UAE_CREATE_ONLY_SCOPE || aeScope === UAE_CREATE_AND_UPDATE_SCOPE) {
    const account = parameter(UAE_ACCOUNT_ID);
    const dataSource = parameter(UAE_DATA_SOURCE_ID);
    const dataSourceName = parameter(UAE_DATA_SOURCE_NAME);
    const scope = parameter(aeScope);
    const actionClause = aeScope === UAE_CREATE_ONLY_SCOPE
      ? "scoped_item.action='CREATE'"
      : "scoped_item.action IN ('CREATE','UPDATE')";
    clauses.push(`merchant_sync_jobs.operation='CREATE_OR_UPDATE'
      AND merchant_sync_jobs.offer_country='AE'
      AND merchant_sync_jobs.payload->>'executionScope'=${scope}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'accountId'=${account}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceId'=${dataSource}
      AND merchant_sync_jobs.payload->'stateIdentity'->>'dataSourceName'=${dataSourceName}
      AND EXISTS (
        SELECT 1 FROM merchant_reconciliation_items scoped_item
        WHERE scoped_item.id=merchant_sync_jobs.reconciliation_item_id
          AND ${actionClause}
          AND scoped_item.country='AE'
      )`);
  }

  if (clauses.length === 0) return { clause: "FALSE", params: [] };
  return {
    clause: clauses.map((clause) => `(${clause})`).join("\nOR "),
    params,
  };
}