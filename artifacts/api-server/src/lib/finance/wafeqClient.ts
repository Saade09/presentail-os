import { createHash } from "node:crypto";

export const WAFEQ_API_BASE_URL = "https://api.wafeq.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 100;

export type WafeqAccount = {
  id: string;
  external_id?: string;
  account_code?: string;
  name_en?: string;
  classification?: string;
  is_locked?: boolean;
  is_posting?: boolean;
  is_payment_enabled?: boolean;
};

export type WafeqContact = {
  id: string;
  external_id?: string;
  name?: string;
  relationship?: string | string[];
  tax_registration_number?: string;
};

export type WafeqTaxRate = {
  id: string;
  external_id?: string;
  name?: string;
  friendly_name?: string;
  rate?: number | string;
  tax_type?: string;
};

export type WafeqBill = {
  id: string;
  external_id?: string;
  status?: string;
  bill_number?: string;
  [key: string]: unknown;
};

export class WafeqApiError extends Error {
  readonly status: number;
  readonly rateLimited: boolean;

  constructor(status: number, message = "Wafeq request failed") {
    super(message);
    this.name = "WafeqApiError";
    this.status = status;
    this.rateLimited = status === 429;
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPage(value: unknown): value is { count: number; next?: string | null; previous?: string | null; results: unknown[] } {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    Array.isArray(value.results) &&
    (value.next === undefined || value.next === null || typeof value.next === "string") &&
    (value.previous === undefined || value.previous === null || typeof value.previous === "string")
  );
}

/**
 * A UUID-shaped, deterministic idempotency key. The hash is not a secret and
 * contains no invoice contents; it is only derived from the import identity.
 */
export function deterministicImportUuid(entityId: number | string, importId: number | string): string {
  const bytes = createHash("sha256").update(`presentail:wafeq:import:${entityId}:${importId}`).digest();
  const hex = Buffer.from(bytes).toString("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][bytes[16] & 3];
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const idempotencyKeyForImport = deterministicImportUuid;

export class WafeqClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImpl?: FetchLike;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? WAFEQ_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<unknown> {
    const target = pathOrUrl.startsWith("http") ? pathOrUrl : this.url(pathOrUrl);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Api-Key ${this.apiKey}`);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const signal = init.signal ?? AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(target, { ...init, headers, signal, redirect: "error" });
    } catch {
      throw new WafeqApiError(0, "Unable to connect to Wafeq");
    }
    if (!response.ok) {
      // Deliberately do not include the upstream response body: providers
      // occasionally echo request data (and this client handles secrets).
      throw new WafeqApiError(response.status, response.status === 429 ? "Wafeq rate limit exceeded" : `Wafeq returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new WafeqApiError(response.status, "Wafeq returned malformed JSON");
    }
  }

  private assertSafeNext(next: string): string {
    let parsed: URL;
    try {
      parsed = new URL(next, this.baseUrl);
    } catch {
      throw new WafeqApiError(0, "Wafeq returned an invalid pagination URL");
    }
    // Pagination URLs are server supplied. Never follow a URL to another
    // origin, even if it is returned by a compromised proxy.
    if (parsed.origin !== new URL(this.baseUrl).origin || parsed.protocol !== "https:") {
      throw new WafeqApiError(0, "Wafeq returned an unsafe pagination URL");
    }
    return parsed.toString();
  }

  private async list<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T[]> {
    let next: string | null = `${this.url(path)}${queryString(params)}`;
    const all: T[] = [];
    for (let page = 0; next && page < MAX_PAGES; page += 1) {
      const payload = await this.request(next);
      if (!isPage(payload)) throw new WafeqApiError(200, "Wafeq returned an invalid paginated response");
      all.push(...(payload.results as T[]));
      next = payload.next ? this.assertSafeNext(payload.next) : null;
    }
    if (next) throw new WafeqApiError(0, "Wafeq pagination exceeded the safety limit");
    return all;
  }

  async verifyOrganization(): Promise<Record<string, unknown>> {
    const result = await this.request("organization/");
    if (!isRecord(result)) throw new WafeqApiError(200, "Wafeq returned an invalid organization");
    return result;
  }

  async getOrganization(): Promise<Record<string, unknown>> {
    return this.verifyOrganization();
  }

  async searchContacts(params: { keyword?: string; externalId?: string; suppliersOnly?: boolean } = {}): Promise<WafeqContact[]> {
    return this.list<WafeqContact>("contacts/", {
      keyword: params.keyword,
      external_id: params.externalId,
      relationship: params.suppliersOnly ? "SUPPLIER" : undefined,
    });
  }

  async listContacts(params: { keyword?: string; externalId?: string; suppliersOnly?: boolean } = {}): Promise<WafeqContact[]> {
    return this.searchContacts(params);
  }

  async searchSuppliers(params: { keyword?: string; externalId?: string } = {}): Promise<WafeqContact[]> {
    return this.searchContacts({ ...params, suppliersOnly: true });
  }

  async listSuppliers(params: { keyword?: string; externalId?: string } = {}): Promise<WafeqContact[]> {
    return this.searchSuppliers(params);
  }

  async listEligibleAccounts(options: { externalId?: string; accountCode?: string } = {}): Promise<WafeqAccount[]> {
    return this.list<WafeqAccount>("accounts/", {
      classification: "EXPENSE",
      external_id: options.externalId,
    }).then((accounts) =>
      accounts.filter((account) => !account.is_locked && account.is_posting !== false &&
        (!options.accountCode || account.account_code === options.accountCode || account.external_id === options.accountCode)),
    );
  }

  async listAccounts(options: { externalId?: string; accountCode?: string } = {}): Promise<WafeqAccount[]> {
    return this.listEligibleAccounts(options);
  }

  async listTaxRates(options: { externalId?: string } = {}): Promise<WafeqTaxRate[]> {
    return this.list<WafeqTaxRate>("tax-rates/", { external_id: options.externalId, tax_type: "PURCHASES" });
  }

  async createDraftBill(payload: Record<string, unknown>, idempotencyKey: string): Promise<WafeqBill> {
    const result = await this.request("bills/", {
      method: "POST",
      headers: { "X-Wafeq-Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    if (!isRecord(result) || typeof result.id !== "string") throw new WafeqApiError(200, "Wafeq returned an invalid bill");
    return result as WafeqBill;
  }

  async createBill(payload: Record<string, unknown>, idempotencyKey: string): Promise<WafeqBill> {
    return this.createDraftBill(payload, idempotencyKey);
  }

  async retrieveBill(id: string): Promise<WafeqBill> {
    const result = await this.request(`bills/${encodeURIComponent(id)}/`);
    if (!isRecord(result) || typeof result.id !== "string") throw new WafeqApiError(200, "Wafeq returned an invalid bill");
    return result as WafeqBill;
  }
}