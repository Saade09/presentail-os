/**
 * Google Merchant Center API client.
 *
 * Wraps product input insert, account access verification, and product status
 * fetch. Never logs the access token.
 */

import { getMerchantAccessToken } from "./googleMerchantAuth";
import type { MerchantProductInput } from "./googleMerchant";
import { logger } from "./logger";

export interface MerchantAccountConfig {
  country: "LB" | "AE";
  accountId: string;
  dataSourceId: string;
  dataSourceName: string;
}

export const MERCHANT_MARKETS = ["AE", "LB"] as const;
export type MerchantMarketCountry = typeof MERCHANT_MARKETS[number];

function numericId(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a bare numeric ID.`);
  }
  return trimmed;
}

function dataSourceIdFromName(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\/dataSources\/(\d+)$/);
  if (!match) throw new Error(`${label} must end with /dataSources/<numeric ID>.`);
  return match[1];
}

function requiredMarketConfigValue(
  country: MerchantMarketCountry,
  suffix: "ACCOUNT_ID" | "DATA_SOURCE_ID" | "DATA_SOURCE_NAME",
): string {
  const key = `GOOGLE_MERCHANT_${country}_${suffix}`;
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

/**
 * Resolve a market only from its explicit per-country destination.
 *
 * Reconciliation must never fall back to the legacy generic account/data-source
 * variables because those identify the old mixed UAE source.
 */
export function getMerchantAccountConfig(country: "LB" | "AE"): MerchantAccountConfig {
  const accountId = numericId(
    requiredMarketConfigValue(country, "ACCOUNT_ID"),
    `GOOGLE_MERCHANT_${country}_ACCOUNT_ID`,
  );
  const configuredName = requiredMarketConfigValue(country, "DATA_SOURCE_NAME");
  const dataSourceId = numericId(
    requiredMarketConfigValue(country, "DATA_SOURCE_ID"),
    `GOOGLE_MERCHANT_${country}_DATA_SOURCE_ID`,
  );
  const nameDataSourceId = dataSourceIdFromName(
    configuredName,
    `GOOGLE_MERCHANT_${country}_DATA_SOURCE_NAME`,
  );
  if (nameDataSourceId !== dataSourceId) {
    throw new Error(
      `GOOGLE_MERCHANT_${country}_DATA_SOURCE_NAME does not match GOOGLE_MERCHANT_${country}_DATA_SOURCE_ID.`,
    );
  }
  const dataSourceName = configuredName;
  if (dataSourceName !== `accounts/${accountId}/dataSources/${dataSourceId}`) {
    throw new Error(`${country} Merchant data source name does not match account ${accountId} and data source ${dataSourceId}.`);
  }
  return { country, accountId, dataSourceId, dataSourceName };
}

function getAccountId(): string {
  const id = process.env.GOOGLE_MERCHANT_ACCOUNT_ID;
  if (!id) throw new Error("GOOGLE_MERCHANT_ACCOUNT_ID is not set.");
  return id;
}

/**
 * Resolve the bare numeric data-source ID from environment configuration.
 *
 * Supports two secret naming conventions used across different operator setups:
 *
 *   GOOGLE_MERCHANT_DATA_SOURCE_ID   — bare numeric ID, e.g. "1234567890"
 *   GOOGLE_MERCHANT_DATA_SOURCE_NAME — full resource name returned by Google's
 *     Data Sources API, e.g. "accounts/5689332635/dataSources/1234567890".
 *     The terminal numeric segment is extracted and used as the ID.
 *
 * Throws if neither variable provides a resolvable numeric ID.
 */
function getDataSourceId(): string {
  const bareId = process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID?.trim();
  if (bareId && /^\d+$/.test(bareId)) {
    return bareId;
  }

  // Fall back to the full resource name (GOOGLE_MERCHANT_DATA_SOURCE_NAME),
  // extracting the terminal numeric segment after the last "/".
  const resourceName = process.env.GOOGLE_MERCHANT_DATA_SOURCE_NAME?.trim();
  if (resourceName) {
    const segments = resourceName.split("/");
    const terminal = segments[segments.length - 1];
    if (terminal && /^\d+$/.test(terminal)) {
      return terminal;
    }
    throw new Error(
      `GOOGLE_MERCHANT_DATA_SOURCE_NAME is set but its terminal segment ("${terminal}") is not a numeric ID. ` +
        `Expected a value like "accounts/123/dataSources/456789", got "${resourceName}".`,
    );
  }

  // Neither variable is usable.
  if (bareId) {
    throw new Error(
      `GOOGLE_MERCHANT_DATA_SOURCE_ID is set to "${bareId}" but is not a bare numeric ID. ` +
        `Set it to the bare numeric ID (e.g. "1234567890") or set GOOGLE_MERCHANT_DATA_SOURCE_NAME ` +
        `to the full resource name (e.g. "accounts/123/dataSources/1234567890").`,
    );
  }
  throw new Error(
    "Neither GOOGLE_MERCHANT_DATA_SOURCE_ID nor GOOGLE_MERCHANT_DATA_SOURCE_NAME is set — merchant sync will fail.",
  );
}

export interface MerchantConfigStatus {
  ok: boolean;
  problems: string[];
  markets?: Record<MerchantMarketCountry, {
    ok: boolean;
    problems: string[];
    accountId?: string;
    dataSourceId?: string;
  }>;
}

/**
 * Non-throwing check of the Merchant Center configuration.
 * Returns { ok: true } when both the account ID and a resolvable data-source ID
 * are configured; otherwise { ok: false, problems } with human-readable
 * descriptions of each missing/invalid piece. Used by the merchant-sync-status
 * endpoint so the dashboard can surface configuration problems explicitly
 * instead of letting jobs queue forever.
 */
export function getMerchantConfigStatus(): MerchantConfigStatus {
  const markets = Object.fromEntries(MERCHANT_MARKETS.map((country) => {
    try {
      const config = getMerchantAccountConfig(country);
      return [country, { ok: true, problems: [], accountId: config.accountId, dataSourceId: config.dataSourceId }];
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return [country, { ok: false, problems: [`${country}: ${detail}`] }];
    }
  })) as NonNullable<MerchantConfigStatus["markets"]>;
  const problems = MERCHANT_MARKETS.flatMap((country) => markets[country].problems);
  return { ok: problems.length === 0, problems, markets };
}

/**
 * Validate the GMC configuration env vars on startup.
 * Logs a clear warning if the data-source configuration is missing or malformed.
 * Also logs the account ID and resolved data source ID so they appear in startup logs.
 */
export function validateMerchantConfig(): void {
  const status = getMerchantConfigStatus();
  if (!status.ok) {
    for (const problem of status.problems) {
      logger.warn({ problem }, "[GMC] WARNING: Merchant Center configuration problem — merchant sync will fail");
    }
    return;
  }
  for (const country of MERCHANT_MARKETS) {
    const config = getMerchantAccountConfig(country);
    logger.info(
      { country, accountId: config.accountId, dataSourceId: config.dataSourceId },
      "[GMC] Merchant Center destination configured",
    );
  }
}

/**
 * POST a product input to the Merchant Center productInputs:insert endpoint.
 *
 * Maps MerchantProductInput → Google API ProductInput body
 * (productAttributes object, amountMicros price).
 * Throws with the full raw Google JSON response string on non-2xx.
 */
export async function insertProductInput(input: MerchantProductInput): Promise<unknown> {
  const accountId = getAccountId();
  const dataSourceId = getDataSourceId();
  const token = await getMerchantAccessToken();
  const body = buildInsertBody(input);

  const url = `https://merchantapi.googleapis.com/products/v1/accounts/${accountId}/productInputs:insert?dataSource=accounts/${accountId}/dataSources/${dataSourceId}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(rawText);
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

/** Explicit market/config API used by reconciliation and all new offer code. */
export async function insertProductInputForConfig(config: MerchantAccountConfig, input: MerchantProductInput): Promise<unknown> {
  const token = await getMerchantAccessToken();
  const dataSource = `accounts/${config.accountId}/dataSources/${config.dataSourceId}`;
  const res = await fetch(`https://merchantapi.googleapis.com/products/v1/accounts/${config.accountId}/productInputs:insert?dataSource=${encodeURIComponent(dataSource)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(buildInsertBody(input)),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(raw);
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

export interface GoogleProductPage { products: unknown[]; nextPageToken?: string; }
/** Read-only listing, suitable only as existence evidence during reconciliation. */
export async function listGoogleProducts(config: MerchantAccountConfig, pageToken?: string, pageSize = 250): Promise<GoogleProductPage> {
  const token = await getMerchantAccessToken();
  const params = new URLSearchParams({ pageSize: String(Math.min(Math.max(pageSize, 1), 250)) });
  if (pageToken) params.set("pageToken", pageToken);
  const res = await fetch(`https://merchantapi.googleapis.com/products/v1/accounts/${config.accountId}/products?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`listGoogleProducts HTTP ${res.status}: ${raw}`);
  const body = JSON.parse(raw) as { products?: unknown[]; nextPageToken?: string };
  return { products: Array.isArray(body.products) ? body.products : [], nextPageToken: body.nextPageToken };
}

/**
 * Build the exact JSON body that insertProductInput would send.
 * Used by the test endpoint for payload validation before sending.
 */
export function buildInsertBody(input: MerchantProductInput): Record<string, unknown> {
  const { productAttributes } = input;
  return {
    offerId: input.offerId,
    contentLanguage: input.contentLanguage,
    feedLabel: input.feedLabel,
    productAttributes: {
      title: productAttributes.title,
      description: productAttributes.description,
      link: productAttributes.link,
      imageLink: productAttributes.imageLink,
      ...(productAttributes.additionalImageLinks
        ? { additionalImageLinks: productAttributes.additionalImageLinks }
        : {}),
      availability: productAttributes.availability,
      condition: productAttributes.condition,
      price: {
        amountMicros: productAttributes.price.amountMicros,
        currencyCode: productAttributes.price.currencyCode,
      },
      identifierExists: productAttributes.identifierExists,
      ...(productAttributes.brand ? { brand: productAttributes.brand } : {}),
      ...(productAttributes.googleProductCategory
        ? { googleProductCategory: productAttributes.googleProductCategory }
        : {}),
      ...(productAttributes.shipping && productAttributes.shipping.length > 0
        ? { shipping: productAttributes.shipping }
        : {}),
    },
  };
}

/**
 * Verify effective read access to the exact Merchant account and data source.
 *
 * User-list membership is not reliable for sub-accounts because an aggregator
 * user's access is inherited without duplicating that user on the sub-account.
 * Reading both target resources validates Google's effective authorization and
 * the configured destination without making any Merchant mutations.
 */
export async function verifyMerchantAccountAccess(): Promise<{ ok: boolean; detail: unknown }> {
  const accountId = getAccountId();
  return verifyMerchantAccountAccessForConfig({
    country: "AE",
    accountId,
    dataSourceId: getDataSourceId(),
    dataSourceName: `accounts/${accountId}/dataSources/${getDataSourceId()}`,
  });
}

export async function verifyMerchantAccountAccessForConfig(
  config: MerchantAccountConfig,
): Promise<{ ok: boolean; detail: unknown }> {
  const accountId = config.accountId;
  let token: string;
  try {
    token = await getMerchantAccessToken();
  } catch (err) {
    return { ok: false, detail: { error: String(err) } };
  }

  const resources = [
    {
      kind: "account",
      url: `https://merchantapi.googleapis.com/accounts/v1/accounts/${accountId}`,
    },
    {
      kind: "dataSource",
      url: `https://merchantapi.googleapis.com/datasources/v1/${config.dataSourceName}`,
    },
  ] as const;

  const detail: Record<string, unknown> = {};
  for (const resource of resources) {
    let res: Response;
    try {
      res = await fetch(resource.url, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      return { ok: false, detail: { ...detail, [resource.kind]: { error: String(err) } } };
    }

    let parsed: unknown;
    try {
      parsed = (await res.json()) as unknown;
    } catch {
      parsed = { rawStatus: res.status };
    }
    detail[resource.kind] = parsed;

    if (!res.ok) {
      logger.warn(
        { accountId, dataSourceId: config.dataSourceId, resource: resource.kind, status: res.status, detail: parsed },
        "merchantCenterClient: effective account access check failed",
      );
      return { ok: false, detail };
    }
  }

  logger.info(
    { accountId, dataSourceId: config.dataSourceId },
    "merchantCenterClient: effective account and data-source access confirmed",
  );
  return { ok: true, detail };
}

/**
 * Fetch the live product status from the Merchant Center products endpoint.
 * `productName` is the `name` field from the productInputs:insert response,
 * e.g. "accounts/5689332635/products/online~en~LB~SKU123-LB".
 *
 * Returns the parsed response body.
 */
export async function fetchProductStatus(productName: string): Promise<unknown> {
  const token = await getMerchantAccessToken();
  // The name already encodes the full resource path
  const url = `https://merchantapi.googleapis.com/products/v1/${productName}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`fetchProductStatus HTTP ${res.status}: ${rawText}`);
  }

  try {
    return JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
}

/** Fetch status using the exact account that owns an offer. */
export async function fetchProductStatusForConfig(config: MerchantAccountConfig, productName: string): Promise<unknown> {
  const token = await getMerchantAccessToken();
  const res = await fetch(`https://merchantapi.googleapis.com/products/v1/${productName}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`fetchProductStatus HTTP ${res.status}: ${raw}`);
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

/**
 * Delete a product input from the Merchant Center data source.
 *
 * The Merchant API returns a `products` resource name after an insert, while
 * deletion is performed against the corresponding `productInputs` resource.
 * Keeping that conversion here means callers can use the stored resource name
 * without ever needing to handle an access token or construct an API URL.
 */
export async function deleteProductInput(productResourceName: string): Promise<void> {
  const accountId = getAccountId();
  const dataSourceId = getDataSourceId();
  const token = await getMerchantAccessToken();
  const productInputName = productResourceName.replace("/products/", "/productInputs/");
  const url = `https://merchantapi.googleapis.com/products/v1/${productInputName}?dataSource=accounts/${accountId}/dataSources/${dataSourceId}`;

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`deleteProductInput HTTP ${res.status}: ${rawText}`);
  }
}

export async function deleteProductInputForConfig(config: MerchantAccountConfig, productResourceName: string): Promise<void> {
  const token = await getMerchantAccessToken();
  const name = productResourceName.replace("/products/", "/productInputs/");
  const dataSource = `accounts/${config.accountId}/dataSources/${config.dataSourceId}`;
  const res = await fetch(`https://merchantapi.googleapis.com/products/v1/${name}?dataSource=${encodeURIComponent(dataSource)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  const raw = await res.text();
  if (!res.ok) throw new Error(`deleteProductInput HTTP ${res.status}: ${raw}`);
}
