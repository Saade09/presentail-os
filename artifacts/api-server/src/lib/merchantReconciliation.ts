import { db, withTransaction } from "./db";
import { evaluateMerchantEligibility } from "./merchantEligibility";
import {
  getMerchantAccountConfig,
  listGoogleProducts,
  verifyMerchantAccountAccessForConfig,
  type MerchantMarketCountry,
} from "./merchantCenterClient";
import {
  buildMerchantProductInputForMarket,
  slugifyProductName,
  type MerchantProductInput,
} from "./googleMerchant";
import { createHash } from "crypto";
import {
  LEBANON_CREATE_AND_UPDATE_SCOPE,
  LEBANON_CREATE_UPDATE_DELETE_SCOPE,
  UAE_CREATE_AND_UPDATE_SCOPE,
  UAE_CREATE_ONLY_SCOPE,
  merchantExecutionAllows,
  merchantExecutionScope,
  merchantExecutionScopeAe,
  merchantReconciliationExecutionEnabled,
} from "./merchantExecutionScope";
import { buildPublicObjectUrl } from "./objectStorage";
import { preflightMerchantImages } from "./merchantImagePreflight";

export type ReconciliationAction = "CREATE" | "UPDATE" | "DELETE" | "NOOP" | "ACTION_REQUIRED";
export interface ReplacementIdentity {
  accountId: string;
  dataSourceId: string;
  dataSourceName: string;
  country: "LB" | "AE";
  contentLanguage: string;
  offerId: string;
  payloadHash: string;
}
export interface DesiredOffer {
  productId: number;
  offerId: string;
  action: ReconciliationAction;
  reason?: string;
  payload?: MerchantProductInput;
  payloadHash?: string;
  replacement?: ReplacementIdentity;
}
export function merchantPayloadHash(payload: MerchantProductInput): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

interface Candidate {
  id: number; sku: string | null; name: string; is_archived: boolean; merchant_sync_disabled: boolean | null;
  has_publication: boolean; country_excluded: boolean; default_city_excluded: boolean;
  price_usd: string; price_aed: string; main_image_url: string | null; image_public_path: string | null; additional_image_urls: string[]; additional_image_public_paths: string[];
  description: string | null; description_ar: string | null; brand: string | null; google_product_category: string | null; public_slug: string | null; status: string;
}

function offerId(row: Candidate, country: string): string {
  return `${row.sku?.trim() || `PRESENTAIL-${row.id}`}-${country}`;
}

export function deleteCircuitBreaker(deleteCount: number, locallyOwnedCount: number): string | null {
  if (deleteCount >= 100) return "Delete circuit breaker: 100 or more deletes";
  if (locallyOwnedCount > 0 && deleteCount / locallyOwnedCount > 0.1) return "Delete circuit breaker: deletes exceed 10% of locally-owned offers";
  return null;
}

export { merchantReconciliationExecutionEnabled };

/** The data query returns exactly one candidate per product; markets are supplied explicitly. */
export async function getDesiredOffers(workspaceId: string, country: string, contentLanguage: string): Promise<DesiredOffer[]> {
  const rows = await db.query<Candidate>(
    `SELECT p.id, p.sku, p.name, p.is_archived, p.merchant_sync_disabled, p.price_usd, p.price_aed,
            p.main_image_url, p.image_public_path, p.additional_image_urls, p.additional_image_public_paths, p.description, p.description_ar, p.brand, p.google_product_category, p.status,
       (SELECT pp.public_slug FROM product_publications pp JOIN publishing_channels pc ON pc.id=pp.channel_id
          WHERE pp.product_id=p.id AND pp.publication_status='published' AND pp.is_visible IS TRUE AND pc.status='active'
            AND (pp.scheduled_unpublish_at IS NULL OR pp.scheduled_unpublish_at > now())
            AND (pp.scheduled_publish_at IS NULL OR pp.scheduled_publish_at <= now())
          ORDER BY pp.updated_at DESC LIMIT 1) AS public_slug,
       EXISTS (SELECT 1 FROM product_publications pp JOIN publishing_channels pc ON pc.id=pp.channel_id WHERE pp.product_id=p.id AND pp.publication_status='published' AND pp.is_visible IS TRUE AND pc.status='active'
                 AND (pp.scheduled_unpublish_at IS NULL OR pp.scheduled_unpublish_at > now())
                 AND (pp.scheduled_publish_at IS NULL OR pp.scheduled_publish_at <= now())) AS has_publication,
       EXISTS (SELECT 1 FROM product_country_availability ca WHERE ca.product_id=p.id AND upper(ca.country_code)=upper($2) AND ca.is_available IS FALSE) AS country_excluded,
       EXISTS (SELECT 1 FROM product_city_availability cva JOIN delivery_cities dc ON dc.id=cva.city_id
                WHERE cva.product_id=p.id AND cva.is_available IS FALSE AND upper(dc.country_code)=upper($2)
                  AND lower(dc.slug)=CASE upper($2) WHEN 'LB' THEN 'beirut' WHEN 'AE' THEN 'dubai' ELSE '' END) AS default_city_excluded
       FROM products p WHERE p.workspace_owner_id=$1`,
    [workspaceId, country],
  );
  return rows.rows.flatMap((row): DesiredOffer[] => {
    const eligibility = evaluateMerchantEligibility(
      { isArchived: row.is_archived, merchantSyncDisabled: row.merchant_sync_disabled },
      { country, contentLanguage, hasActiveVisiblePublishedPublication: row.has_publication, countryExcluded: row.country_excluded, defaultCityExcluded: row.default_city_excluded },
    );
    if (!eligibility.eligible) return [];
    // The promoted copy is the canonical Merchant image. Legacy HTTPS values
    // can point at a storefront host that neither routes nor permits /api.
    const image = buildPublicObjectUrl(row.image_public_path)
      ?? (row.main_image_url?.startsWith("https://") ? row.main_image_url : null);
    const additional = (row.additional_image_urls ?? [])
      .map((v, i) => buildPublicObjectUrl(row.additional_image_public_paths?.[i])
        ?? (v.startsWith("https://") ? v : null))
      .filter((url): url is string => Boolean(url));
    try {
      const effectiveSlug = row.public_slug?.trim() || slugifyProductName(row.name);
      const payload = buildMerchantProductInputForMarket({ id: row.id, name: row.name, sku: row.sku, priceUsd: row.price_usd, priceAed: row.price_aed, mainImageUrl: image, additionalImageUrls: additional, description: row.description, descriptionAr: row.description_ar, status: row.status, isArchived: row.is_archived, brand: row.brand, googleProductCategory: row.google_product_category }, { country: country as "LB" | "AE", contentLanguage: "en", city: country === "AE" ? "dubai" : "beirut" }, effectiveSlug);
      return [{ productId: row.id, offerId: payload.offerId, action: "CREATE", payload, payloadHash: merchantPayloadHash(payload) }];
    } catch (error) {
      return [{ productId: row.id, offerId: offerId(row, country), action: "ACTION_REQUIRED", reason: error instanceof Error ? error.message : String(error) }];
    }
  });
}

export async function createReconciliationDryRun(workspaceId: string, createdBy: string, country: "LB" | "AE", contentLanguage: string, includeGoogle = false): Promise<{ runId: number; summary: Record<string, number>; blocked: string | null }> {
  if (contentLanguage !== "en") throw new Error("Only English is supported in Merchant Phase 1");
  const config = getMerchantAccountConfig(country);
  const desired = await getDesiredOffers(workspaceId, country, contentLanguage);
  const owned = await db.query<{ product_id: number; offer_id: string; payload_hash: string | null; account_id: string; data_source_id: string; data_source_name: string; country: string }>(
    `SELECT product_id, offer_id, payload_hash, account_id, data_source_id, data_source_name, country FROM merchant_offer_states WHERE workspace_owner_id=$1 AND country=$2 AND content_language=$3 AND is_owned IS TRUE AND deleted_at IS NULL`,
    [workspaceId, country, contentLanguage],
  );
  const desiredByProduct = new Map(desired.map((x) => [x.productId, x]));
  const googleOffersByAccount = new Map<string, Set<string>>();
  if (includeGoogle) {
    const configs = new Map<string, typeof config>([[config.accountId, config]]);
    for (const state of owned.rows) {
      if (!configs.has(state.account_id)) {
        configs.set(state.account_id, {
          country: state.country as "LB" | "AE",
          accountId: state.account_id,
          dataSourceId: state.data_source_id,
          dataSourceName: state.data_source_name,
        });
      }
    }
    for (const sourceConfig of configs.values()) {
      const offers = new Set<string>();
      for (let token: string | undefined; ;) {
        const page = await listGoogleProducts(sourceConfig, token);
        for (const product of page.products) {
          const record = product as Record<string, unknown>;
          if (typeof record.offerId === "string") offers.add(record.offerId);
        }
        if (!page.nextPageToken) break;
        token = page.nextPageToken;
      }
      googleOffersByAccount.set(sourceConfig.accountId, offers);
    }
  }
  const statesByProduct = new Map<number, typeof owned.rows>();
  for (const state of owned.rows) statesByProduct.set(state.product_id, [...(statesByProduct.get(state.product_id) ?? []), state]);
   const stateByProduct = new Map([...statesByProduct].map(([id, states]) => [id, states.find((s) => s.offer_id === desiredByProduct.get(id)?.offerId && s.account_id === config.accountId && s.data_source_id === config.dataSourceId) ?? states[0]]));
  const items: Array<DesiredOffer> = desired.flatMap((d) => {
    if (d.action === "ACTION_REQUIRED") return d;
    const states = statesByProduct.get(d.productId) ?? [];
    const exact = states.find((s) => s.offer_id === d.offerId && s.account_id === config.accountId && s.data_source_id === config.dataSourceId);
    const sourceStates = states.filter(
      (state) => state.account_id !== config.accountId || state.data_source_id !== config.dataSourceId || state.offer_id !== d.offerId,
    );
    const desiredAction: DesiredOffer = {
      ...d,
      action: exact
        ? (exact.payload_hash !== d.payloadHash || (includeGoogle && !(googleOffersByAccount.get(config.accountId)?.has(d.offerId) ?? false)) ? "UPDATE" : "NOOP")
        : "CREATE",
    };
    // Same-country offers owned by an old account/data source are a migration,
    // never an UPDATE: retain the source identity for its guarded DELETE.
    if (sourceStates.length && d.payloadHash) {
      const replacement: ReplacementIdentity = {
        accountId: config.accountId,
        dataSourceId: config.dataSourceId,
        dataSourceName: config.dataSourceName,
        country,
        contentLanguage,
        offerId: d.offerId,
        payloadHash: d.payloadHash,
      };
      return [
        ...sourceStates.map((old) => ({
          productId: d.productId,
          offerId: old.offer_id,
          action: "DELETE" as const,
          reason: "account_or_offer_migration",
          replacement,
        })),
        desiredAction,
      ];
    }
    return desiredAction;
  });
  for (const state of owned.rows) {
    if (desiredByProduct.has(state.product_id)) continue;
    items.push({
      productId: state.product_id,
      offerId: state.offer_id,
      action: "DELETE",
      reason: "no_longer_desired_in_market",
    });
  }
  const deletes = items.filter((x) => x.action === "DELETE").length;
  const verifiedDeletes = items.filter((item) => {
    if (item.action !== "DELETE") return false;
    const source = owned.rows.find((state) => state.product_id === item.productId && state.offer_id === item.offerId);
    return !!source && googleOffersByAccount.get(source.account_id)?.has(item.offerId);
  }).length;
  const breakerDeleteCount = includeGoogle ? verifiedDeletes : deletes;
  const blocked = deleteCircuitBreaker(breakerDeleteCount, owned.rows.length);
  const summary = items.reduce<Record<string, number>>(
    (acc, item) => ({ ...acc, [item.action]: (acc[item.action] ?? 0) + 1 }),
    { locallyOwned: owned.rows.length, deletes, verifiedDeletes, externallyAbsentDeletes: includeGoogle ? deletes - verifiedDeletes : 0 },
  );
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const run = await client.query<{ id: number }>(
        `INSERT INTO merchant_reconciliation_runs(workspace_owner_id,country,content_language,status,summary,created_by)
         VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
        [workspaceId, country, contentLanguage, blocked ? "BLOCKED" : "DRAFT", JSON.stringify({ ...summary, blocked: Boolean(blocked), blockedReason: blocked }), createdBy],
      );
      for (const item of items) {
        const previous = item.action === "DELETE"
          ? owned.rows.find((s) => s.product_id === item.productId && s.offer_id === item.offerId)
          : stateByProduct.get(item.productId);
        const sourceAccountId = item.action === "DELETE" ? previous?.account_id : config.accountId;
        const identity = {
          accountId: sourceAccountId,
          dataSourceId: item.action === "DELETE" ? previous?.data_source_id : config.dataSourceId,
          dataSourceName: item.action === "DELETE" ? previous?.data_source_name : config.dataSourceName,
          localOwned: item.action === "DELETE" || !!previous,
          externalExists: includeGoogle && !!sourceAccountId
            ? googleOffersByAccount.get(sourceAccountId)?.has(item.offerId) ?? false
            : null,
          isLastOffer: item.action === "DELETE" && !item.replacement,
          payload: item.payload ?? null,
          payloadHash: item.payloadHash ?? null,
          predecessorPayloadHash: previous?.payload_hash ?? null,
          replacement: item.replacement ?? null,
        };
        await client.query(`INSERT INTO merchant_reconciliation_items(run_id,product_id,country,content_language,offer_id,action,reason,state_identity)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [run.rows[0].id, item.productId, country, contentLanguage, item.offerId, item.action, item.reason ?? null, JSON.stringify(identity)]);
      }
      return { runId: run.rows[0].id, summary, blocked };
    });
  } finally { client.release(); }
}

export interface MarketReconciliationResult {
  country: MerchantMarketCountry;
  ok: boolean;
  runId?: number;
  summary?: Record<string, number>;
  blocked?: string | null;
  error?: string;
}

/**
 * Validate and create each selected market independently. A problem in one
 * destination is returned beside that market and never suppresses the other.
 */
export async function createMarketReconciliationDryRuns(
  workspaceId: string,
  createdBy: string,
  countries: MerchantMarketCountry[],
  contentLanguage: "en",
  includeGoogle = false,
): Promise<MarketReconciliationResult[]> {
  return Promise.all(countries.map(async (country): Promise<MarketReconciliationResult> => {
    try {
      const config = getMerchantAccountConfig(country);
      const access = await verifyMerchantAccountAccessForConfig(config);
      if (!access.ok) {
        throw new Error(`${country} Merchant account ${config.accountId} is not accessible to the service account`);
      }
      const result = await createReconciliationDryRun(
        workspaceId,
        createdBy,
        country,
        contentLanguage,
        includeGoogle,
      );
      return { country, ok: true, ...result };
    } catch (error) {
      return { country, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
}

export async function approveReconciliationRun(workspaceId: string, runId: number, approvedBy: string): Promise<boolean> {
  const pending = await db.query<{ payload: MerchantProductInput | null }>(
    `SELECT i.state_identity->'payload' AS payload
       FROM merchant_reconciliation_items i
       JOIN merchant_reconciliation_runs r ON r.id=i.run_id
      WHERE r.id=$1 AND r.workspace_owner_id=$2 AND r.status='DRAFT'
        AND i.action IN ('CREATE','UPDATE')`,
    [runId, workspaceId],
  );
  const payloads = pending.rows.map((row) => row.payload).filter((payload): payload is MerchantProductInput => Boolean(payload));
  if (payloads.length > 0) {
    const preflight = await preflightMerchantImages(payloads);
    if (!preflight.ok) {
      const detail = preflight.failures.slice(0, 5).map((failure) => `${failure.url}: ${failure.reason}`).join("; ");
      throw new Error(`Merchant image preflight failed (${preflight.failures.length}/${preflight.checked} URLs): ${detail}`);
    }
  }
  const result = await db.query(`UPDATE merchant_reconciliation_runs SET status='APPROVED', approved_at=now(), approved_by=$3
    WHERE id=$1 AND workspace_owner_id=$2 AND status='DRAFT'
      AND NOT EXISTS (SELECT 1 FROM merchant_reconciliation_items i WHERE i.run_id=$1 AND i.action='DELETE' AND (i.delete_approved IS NOT TRUE OR ((i.state_identity->>'isLastOffer')::boolean IS TRUE AND i.last_offer_approved IS NOT TRUE)))`, [runId, workspaceId, approvedBy]);
  return (result.rowCount ?? 0) === 1;
}

export async function approveDeletionItems(workspaceId: string, runId: number, itemIds: number[], approveLastOffer: boolean): Promise<number> {
  const result = await db.query(
    `UPDATE merchant_reconciliation_items i SET delete_approved=TRUE, last_offer_approved=$4
       FROM merchant_reconciliation_runs r WHERE i.run_id=r.id AND r.id=$2 AND r.workspace_owner_id=$1
         AND i.id=ANY($3::bigint[]) AND i.action='DELETE'`,
    [workspaceId, runId, itemIds, approveLastOffer],
  );
  return result.rowCount ?? 0;
}

export async function applyApprovedRun(workspaceId: string, runId: number): Promise<number> {
  if (!merchantReconciliationExecutionEnabled()) {
    throw new Error("Merchant reconciliation execution is disabled");
  }
  const client = await db.connect();
  try { return await withTransaction(client, async () => {
    const scopedItems = await client.query<{
      action: "CREATE" | "UPDATE" | "DELETE";
      country: "LB" | "AE";
      account_id: string;
      data_source_id: string;
      data_source_name: string;
    }>(
      `SELECT i.action,i.country,
              i.state_identity->>'accountId' AS account_id,
              i.state_identity->>'dataSourceId' AS data_source_id,
              i.state_identity->>'dataSourceName' AS data_source_name
         FROM merchant_reconciliation_items i
         JOIN merchant_reconciliation_runs r ON r.id=i.run_id
        WHERE r.id=$1 AND r.workspace_owner_id=$2
          AND i.action IN ('CREATE','UPDATE','DELETE')`,
      [runId, workspaceId],
    );
    const queueScope = scopedItems.rows[0]?.country === "AE"
      ? merchantExecutionScopeAe()
      : merchantExecutionScope();
    const jobScopeBinding = (
      queueScope === LEBANON_CREATE_AND_UPDATE_SCOPE
      || queueScope === LEBANON_CREATE_UPDATE_DELETE_SCOPE
      || queueScope === UAE_CREATE_ONLY_SCOPE
      || queueScope === UAE_CREATE_AND_UPDATE_SCOPE
    ) ? queueScope : null;
    if (
      scopedItems.rows.length === 0
      || scopedItems.rows.some((item) => !merchantExecutionAllows({
        action: item.action,
        country: item.country,
        accountId: item.account_id,
        dataSourceId: item.data_source_id,
        dataSourceName: item.data_source_name,
      }))
    ) {
      throw new Error("Run is outside the configured Merchant execution scope");
    }
    const conflicts = await client.query<{ operation: string; status: string; action: string; execution_scope: string | null }>(
      `SELECT j.operation,j.status,i.action,j.payload->>'executionScope' AS execution_scope FROM merchant_reconciliation_items i
       JOIN merchant_sync_jobs j ON j.product_id=i.product_id AND j.offer_country=i.country AND j.offer_content_language=i.content_language
       WHERE i.run_id=$1 AND j.status IN ('PENDING','RUNNING','RETRY_WAITING') FOR UPDATE OF j`,
      [runId],
    );
    if (
      jobScopeBinding
      && conflicts.rows.some((job) => job.execution_scope !== jobScopeBinding)
    ) {
      throw new Error("An active Merchant job was queued under a different execution scope");
    }
    if (conflicts.rows.some((x) => x.action === "DELETE" && x.operation === "CREATE_OR_UPDATE" && x.status === "RUNNING")) throw new Error("A create/update is currently running for an offer; retry deletion later");
    if (conflicts.rows.some((x) => ["CREATE", "UPDATE"].includes(x.action) && x.operation === "DELETE")) throw new Error("An active delete already exists for an offer; create/update cannot be queued");
    await client.query(
      `UPDATE merchant_sync_jobs j SET status='CANCELLED',last_error='Superseded by approved reconciliation DELETE',updated_at=now()
       FROM merchant_reconciliation_items i WHERE i.run_id=$1 AND i.action='DELETE'
         AND j.product_id=i.product_id AND j.offer_country=i.country AND j.offer_content_language=i.content_language
         AND j.operation='CREATE_OR_UPDATE' AND j.status IN ('PENDING','RETRY_WAITING')`,
      [runId],
    );
    // Phase two is deliberately create/update first.  Replacement deletes are
    // not even queued until their exact new account/data-source offer has
    // persisted Google APPROVED evidence; timeout and error are never releases.
    const queuedPayloadSql = jobScopeBinding
      ? `jsonb_build_object('reconciliationItemId',i.id,'offerId',i.offer_id,'country',i.country,'contentLanguage',i.content_language,'stateIdentity',i.state_identity,'executionScope',$3::text)`
      : `jsonb_build_object('reconciliationItemId',i.id,'offerId',i.offer_id,'country',i.country,'contentLanguage',i.content_language,'stateIdentity',i.state_identity)`;
    const queueParams = jobScopeBinding
      ? [runId, workspaceId, jobScopeBinding]
      : [runId, workspaceId];
    const inserted = await client.query(
    `INSERT INTO merchant_sync_jobs(product_id,operation,status,payload,offer_country,offer_content_language,reconciliation_item_id,created_at,updated_at)
     SELECT i.product_id,CASE WHEN i.action='DELETE' THEN 'DELETE' ELSE 'CREATE_OR_UPDATE' END,'PENDING',
            ${queuedPayloadSql},
            i.country,i.content_language,i.id,now(),now() FROM merchant_reconciliation_items i JOIN merchant_reconciliation_runs r ON r.id=i.run_id
       WHERE r.id=$1 AND r.workspace_owner_id=$2 AND r.status IN ('APPROVED','APPLIED')
         AND i.action IN ('CREATE','UPDATE')
     ON CONFLICT DO NOTHING`,
    queueParams,
    );
    const scopeJobMatchSql = jobScopeBinding
      ? `AND j.payload->>'executionScope'=$3`
      : "";
    const missing = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text count FROM merchant_reconciliation_items i JOIN merchant_reconciliation_runs r ON r.id=i.run_id
       WHERE r.id=$1 AND r.workspace_owner_id=$2 AND
          i.action IN ('CREATE','UPDATE')
          AND NOT EXISTS (SELECT 1 FROM merchant_sync_jobs j
            WHERE j.status IN ('PENDING','RUNNING','RETRY_WAITING','WAITING_DEPENDENCY','COMPLETED')
              ${scopeJobMatchSql}
              AND (
                j.reconciliation_item_id=i.id
                OR (
                  j.product_id=i.product_id
                  AND j.operation='CREATE_OR_UPDATE'
                  AND j.offer_country=i.country
                  AND j.offer_content_language=i.content_language
                  AND j.payload->>'offerId'=i.offer_id
                  AND j.payload->'stateIdentity'=i.state_identity
                )
              ))`,
      queueParams,
    );
    if (Number(missing.rows[0]?.count ?? 0) > 0) throw new Error("Not every actionable reconciliation item received its exact durable job");
    const transitioned = await client.query(`UPDATE merchant_reconciliation_runs SET status='APPLIED', applied_at=COALESCE(applied_at,now()) WHERE id=$1 AND workspace_owner_id=$2 AND status='APPROVED' RETURNING id`, [runId, workspaceId]);
    if ((transitioned.rowCount ?? 0) !== 1) {
      const alreadyApplied = await client.query(`SELECT 1 FROM merchant_reconciliation_runs WHERE id=$1 AND workspace_owner_id=$2 AND status='APPLIED'`, [runId, workspaceId]);
      if ((alreadyApplied.rowCount ?? 0) !== 1) throw new Error("Run is not approved or is blocked");
    }
    return inserted.rowCount ?? 0;
  }); } finally { client.release(); }
}

export async function allDesiredOffersApproved(
  workspaceId: string,
  countries: ReadonlyArray<"LB" | "AE"> = ["LB", "AE"],
): Promise<boolean> {
  for (const country of countries) {
    const config = getMerchantAccountConfig(country);
    const desired = await getDesiredOffers(workspaceId, country, "en");
    const valid = desired.filter((item) => item.action !== "ACTION_REQUIRED" && item.payloadHash);
    const approved = await db.query<{ offer_id: string; payload_hash: string | null }>(
      `SELECT offer_id,payload_hash FROM merchant_offer_states
        WHERE workspace_owner_id=$1 AND account_id=$2 AND data_source_id=$3
          AND country=$4 AND content_language='en' AND is_owned IS TRUE
          AND deleted_at IS NULL AND approval_status='APPROVED'`,
      [workspaceId, config.accountId, config.dataSourceId, country],
    );
    const approvedHashes = new Map(approved.rows.map((row) => [row.offer_id, row.payload_hash]));
    if (valid.some((item) => approvedHashes.get(item.offerId) !== item.payloadHash)) return false;
  }
  return true;
}

export async function applyApprovedDeleteBatch(workspaceId: string, runId: number, batchSize: number): Promise<number> {
  if (!merchantReconciliationExecutionEnabled()) {
    throw new Error("Merchant reconciliation execution is disabled");
  }
  if (merchantExecutionScope() !== LEBANON_CREATE_UPDATE_DELETE_SCOPE) {
    throw new Error("Merchant DELETE is forbidden by the configured execution scope");
  }
  if (!Number.isInteger(batchSize) || batchSize < 25 || batchSize > 50) {
    throw new Error("Delete batch size must be between 25 and 50");
  }
  const market = await db.query<{
    country: "LB" | "AE";
    account_id: string;
    data_source_id: string;
    data_source_name: string;
  }>(
    `SELECT r.country,
            i.state_identity->>'accountId' AS account_id,
            i.state_identity->>'dataSourceId' AS data_source_id,
            i.state_identity->>'dataSourceName' AS data_source_name
       FROM merchant_reconciliation_runs r
       JOIN merchant_reconciliation_items i ON i.run_id=r.id AND i.action='DELETE'
      WHERE r.id=$1 AND r.workspace_owner_id=$2`,
    [runId, workspaceId],
  );
  const country = market.rows[0]?.country;
  if (!country) throw new Error("Run not found");
  if (market.rows.some((item) => !merchantExecutionAllows({
    action: "DELETE",
    country: item.country,
    accountId: item.account_id,
    dataSourceId: item.data_source_id,
    dataSourceName: item.data_source_name,
  }))) {
    throw new Error("Merchant DELETE is forbidden by the configured execution scope");
  }
  if (!(await allDesiredOffersApproved(workspaceId, [country]))) {
    throw new Error(`Delete phase blocked: every desired ${country} offer must have current Google APPROVED evidence`);
  }
  const result = await db.query(
    `INSERT INTO merchant_sync_jobs(product_id,operation,status,payload,offer_country,offer_content_language,reconciliation_item_id,created_at,updated_at)
     SELECT i.product_id,'DELETE','PENDING',
       jsonb_build_object('reconciliationItemId',i.id,'offerId',i.offer_id,'country',i.country,'contentLanguage',i.content_language,'stateIdentity',i.state_identity,'executionScope',$4::text),
       i.country,i.content_language,i.id,now(),now()
     FROM merchant_reconciliation_items i
     JOIN merchant_reconciliation_runs r ON r.id=i.run_id
     WHERE r.id=$1 AND r.workspace_owner_id=$2 AND r.status='APPLIED'
       AND COALESCE((r.summary->>'blocked')::boolean,FALSE) IS FALSE
       AND i.action='DELETE' AND i.delete_approved IS TRUE
       AND (COALESCE((i.state_identity->>'isLastOffer')::boolean,FALSE) IS FALSE OR i.last_offer_approved IS TRUE)
       AND (
         i.state_identity->'replacement'='null'::jsonb OR EXISTS (
           SELECT 1 FROM merchant_offer_states replacement
            WHERE replacement.workspace_owner_id=r.workspace_owner_id
              AND replacement.product_id=i.product_id
              AND replacement.account_id=i.state_identity->'replacement'->>'accountId'
              AND replacement.data_source_id=i.state_identity->'replacement'->>'dataSourceId'
              AND replacement.country=i.state_identity->'replacement'->>'country'
              AND replacement.content_language=i.state_identity->'replacement'->>'contentLanguage'
              AND replacement.offer_id=i.state_identity->'replacement'->>'offerId'
              AND replacement.payload_hash=i.state_identity->'replacement'->>'payloadHash'
              AND replacement.approval_status='APPROVED'
              AND replacement.is_owned IS TRUE AND replacement.deleted_at IS NULL
         )
       )
       AND NOT EXISTS (SELECT 1 FROM merchant_sync_jobs j WHERE j.reconciliation_item_id=i.id)
     ORDER BY i.id
     LIMIT $3
     ON CONFLICT DO NOTHING`,
    [runId, workspaceId, batchSize, LEBANON_CREATE_UPDATE_DELETE_SCOPE],
  );
  return result.rowCount ?? 0;
}