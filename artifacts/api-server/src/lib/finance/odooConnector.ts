import type { AccountingConnector, AccountingSystem, BankStatementLine, DraftBillOptions, DraftBillResult, ExtractedInvoiceData, PerLineSyncResult, SettingsSyncResult } from "./accountingConnector.js";
import { createHash } from "node:crypto";
import { logger } from "../logger.js";
import { db } from "../db.js";
import { objectStorageService } from "../objectStorage.js";
import { normaliseOdooBaseUrl, safeOdooFetch } from "./odooUrl.js";
import { OdooJson2Client, OdooJson2Error, statementLineMarker } from "./odooJson2Client.js";
import { matchSupplierByName, normalizeSupplierName, rankSupplierCandidates, type SupplierCandidate } from "../supplierMatcher.js";
import { linkImportedInvoiceToVerifiedOdooSupplier } from "./linkImportedInvoiceSupplier.js";
import { buildOdooInvoiceAttachmentName } from "./odooInvoiceAttachmentName.js";
import {
  currenciesCompatible,
  LEBANON_ODOO_COMPANY_ID,
  LEBANON_ODOO_COMPANY_NAME,
  normaliseCurrencyCode,
  parseBankAmounts,
} from "./bankReconValidation.js";

function getOdooConfig(entity: { odoo_base_url: string | null; odoo_database: string | null; odoo_integration_token: string | null }) {
  const baseUrl = entity.odoo_base_url || process.env.ODOO_BASE_URL;
  const database = entity.odoo_database || process.env.ODOO_DATABASE;
  const token = entity.odoo_integration_token || process.env.ODOO_INTEGRATION_TOKEN;
  return { baseUrl, database, token };
}

function sanitiseOdooErrorText(text: string, token: string, maxLength = 200): string {
  const redacted = token ? text.split(token).join("[redacted]") : text;
  return redacted.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

type OdooPartner = {
  id: number;
  name: string;
  display_name?: string | null;
  vat?: string | null;
  parent_id?: unknown;
  commercial_partner_id?: unknown;
  company_id?: unknown;
};

type OdooTax = {
  id: number;
  name: string;
  amount: number;
  amount_type: string;
  price_include: boolean;
};

type OdooProduct = {
  id: number;
  name: string;
  default_code?: string | null;
};

type OdooAccount = {
  id: number;
  code: string;
  name: string;
  account_type: string;
};

type OdooInvoiceEnrichment = {
  partner: {
    id: number;
    name: string;
    score: number;
    taxNumber: string | null;
    commercialPartnerId: number;
  };
  journal: { id: number; name: string };
  currency: { id: number; name: string };
  taxes: Array<OdooTax | null>;
  lines: Array<{ product: OdooProduct | null; account: OdooAccount }>;
};

export type OdooSupplierCreateInput = {
  name: string;
  address?: string | null;
  countryCode?: string | null;
  taxNumber?: string | null;
};

export type OdooSupplierCreateResult = {
  id: number;
  name: string;
  taxNumber: string | null;
  created: boolean;
};

export type OdooSupplierCandidate = {
  id: number;
  name: string;
  display_name?: string | null;
  tax_number?: string | null;
  score: number;
};

export class OdooSupplierAmbiguityError extends OdooJson2Error {
  readonly candidates: OdooSupplierCandidate[];

  constructor(message: string, candidates: OdooSupplierCandidate[]) {
    super(message);
    this.name = "OdooSupplierAmbiguityError";
    this.candidates = candidates;
  }
}

class OdooAccountResolutionError extends OdooJson2Error {
  constructor(message: string) {
    super(message);
    this.name = "OdooAccountResolutionError";
  }
}

function relationId(value: unknown): number | null {
  const candidate = Array.isArray(value)
    ? value[0]
    : value && typeof value === "object" && "id" in value
      ? (value as { id: unknown }).id
      : value;
  const id = Number(candidate);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalisedCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function normalisedTaxNumber(value: unknown): string {
  return String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

const ODOO_LEBANESE_POUND_ID = 96;

function isLebanesePound(value: unknown): boolean {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "LBP" || normalized === "LEBANESE POUND" || String(value ?? "").trim() === "ل.ل";
}

function safeOdooSupplierTaxNumber(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 64 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return normalisedTaxNumber(raw).length >= 2 ? raw : null;
}

/**
 * Create or reuse one Odoo supplier after an explicit reviewer decision.
 * This is intentionally separate from invoice enrichment: weak name matches
 * must never silently turn into a new accounting partner.
 */
export async function ensureOdooSupplier(
  entity: {
    odoo_base_url: string | null;
    odoo_database: string | null;
    odoo_company_id: number | null;
  },
  input: OdooSupplierCreateInput,
  options: { createOnAmbiguousExactMatch?: boolean } = {},
): Promise<OdooSupplierCreateResult> {
  const base = normaliseOdooBaseUrl(entity.odoo_base_url);
  const database = entity.odoo_database?.trim();
  const companyId = Number(entity.odoo_company_id);
  const apiKey = process.env.ODOO_API_KEY?.trim();
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 255);
  if (!base.ok || !database || !Number.isInteger(companyId) || companyId <= 0 || !apiKey) {
    throw new OdooJson2Error("Odoo integration is not configured on this entity");
  }
  if (!name) throw new OdooJson2Error("A supplier name is required");

  const client = new OdooJson2Client({
    baseUrl: base.url,
    database,
    companyId,
    apiKey,
  });
  const taxNumber = safeOdooSupplierTaxNumber(input.taxNumber);
  const partners = await client.searchRead<Record<string, unknown>>(
    "res.partner",
    [["active", "=", true], ["supplier_rank", ">", 0]],
    ["id", "name", "display_name", "vat", "commercial_partner_id", "parent_id"],
    2000,
  );
  const exactName = normalisedCode(name);
  const nameMatches = partners.filter((partner) =>
    [partner.name, partner.display_name].some((value) => normalisedCode(value) === exactName),
  );
  const taxMatches = taxNumber
    ? partners.filter((partner) => normalisedTaxNumber(partner.vat) === normalisedTaxNumber(taxNumber))
    : [];
  // Do not reuse an exact-name partner whose non-empty VAT/TRN contradicts
  // the reviewed invoice. An empty partner VAT remains compatible and can be
  // enriched by the explicit supplier-link flow.
  const compatibleNameMatches = taxNumber
    ? nameMatches.filter((partner) => {
      const partnerTax = normalisedTaxNumber(partner.vat);
      return !partnerTax || partnerTax === normalisedTaxNumber(taxNumber);
    })
    : nameMatches;
  const exactMatches = [...new Map([...compatibleNameMatches, ...taxMatches]
    .map((partner) => [Number(partner.id), partner] as const)).values()];
  if (exactMatches.length > 1 && !options.createOnAmbiguousExactMatch) {
    throw new OdooJson2Error("Multiple exact Odoo suppliers already match the reviewed name or VAT/TRN");
  }
  if (exactMatches.length === 1) {
    const partner = exactMatches[0];
    const canonicalId = relationId(partner.commercial_partner_id) ?? Number(partner.id);
    const canonicalRows = canonicalId === Number(partner.id)
      ? [partner]
      : await client.searchRead<Record<string, unknown>>(
        "res.partner",
        [["id", "=", canonicalId], ["active", "=", true]],
        ["id", "name", "display_name", "vat", "commercial_partner_id"],
        1,
      );
    const canonical = canonicalRows[0] ?? partner;
    return {
      id: canonicalId,
      name: String(canonical.display_name ?? canonical.name ?? partner.display_name ?? partner.name ?? name).trim(),
      taxNumber: String(canonical.vat ?? partner.vat ?? "").trim() || null,
      created: false,
    };
  }

  const countryCode = String(input.countryCode ?? "").trim().toUpperCase();
  const countryRows = /^[A-Z]{2}$/.test(countryCode)
    ? await client.searchRead<Record<string, unknown>>(
      "res.country",
      [["code", "=", countryCode]],
      ["id", "code"],
      2,
    )
    : [];
  const values: Record<string, unknown> = {
    name,
    company_type: "company",
    is_company: true,
    supplier_rank: 1,
    customer_rank: 0,
    company_id: companyId,
  };
  const address = String(input.address ?? "").trim().replace(/\s+/g, " ").slice(0, 255);
  if (address) values.street = address;
  if (taxNumber) values.vat = taxNumber;
  if (countryRows.length === 1 && Number(countryRows[0].id) > 0) values.country_id = Number(countryRows[0].id);

  const id = await client.createOne("res.partner", values);
  const createdRows = await client.searchRead<Record<string, unknown>>(
    "res.partner",
    [["id", "=", id], ["active", "=", true]],
    ["id", "name", "display_name", "vat", "commercial_partner_id"],
    1,
  );
  const created = createdRows[0];
  if (!created || Number(created.id) !== id) {
    throw new OdooJson2Error("Created Odoo supplier could not be verified");
  }
  if (taxNumber && normalisedTaxNumber(created.vat) !== normalisedTaxNumber(taxNumber)) {
    throw new OdooJson2Error("Created Odoo supplier VAT/TRN could not be verified");
  }
  const canonicalId = relationId(created.commercial_partner_id) ?? id;
  const canonicalRows = canonicalId === id
    ? [created]
    : await client.searchRead<Record<string, unknown>>(
      "res.partner",
      [["id", "=", canonicalId], ["active", "=", true]],
      ["id", "name", "display_name", "vat"],
      1,
    );
  const canonical = canonicalRows[0] ?? created;
  return {
    id: canonicalId,
    name: String(canonical.display_name ?? canonical.name ?? created.display_name ?? created.name ?? name).trim(),
    taxNumber: String(canonical.vat ?? created.vat ?? "").trim() || taxNumber,
    created: true,
  };
}

function commercialPartnerId(partner: OdooPartner): number {
  return relationId(partner.commercial_partner_id)
    ?? relationId(partner.parent_id)
    ?? Number(partner.id);
}

function resolvedSupplier(partner: OdooPartner, score: number): {
  id: number;
  name: string;
  score: number;
  taxNumber: string | null;
  commercialPartnerId: number;
} {
  return {
    id: Number(partner.id),
    name: String(partner.name ?? "").trim(),
    score,
    taxNumber: partner.vat == null ? null : String(partner.vat),
    commercialPartnerId: commercialPartnerId(partner),
  };
}

type LocalSupplierHistoryRow = {
  supplier_id: number;
  supplier_name: string;
  supplier_display_name: string | null;
  supplier_tax_number: string | null;
  odoo_partner_id: number | null;
  historical_vendor_name: string | null;
};

async function resolveOdooSupplier(
  data: ExtractedInvoiceData,
  partners: OdooPartner[],
  workspaceOwnerId?: string,
  entityId?: number,
  approvedValuesAuthoritative = false,
): Promise<{
  id: number;
  name: string;
  score: number;
  taxNumber: string | null;
  commercialPartnerId: number;
}> {
  const validPartners = partners
    .map((partner) => ({
      ...partner,
      id: Number(partner.id),
      name: String(partner.name ?? "").trim(),
    }))
    .filter((partner) => Number.isInteger(partner.id) && partner.id > 0 && partner.name);
  if (!data.vendor_name && data.supplier_id == null && !data.vendor_tax_number) {
    throw new OdooJson2Error("An extracted supplier name, tax number, or selected supplier is required");
  }

  const partnerById = new Map(validPartners.map((partner) => [partner.id, partner]));
  // An explicit reviewer selection is authoritative for this retry.  Do not
  // run the extracted name through fuzzy matching again.
  const explicitPartnerId = Number(data.odoo_partner_id ?? data.partner_id);
  if (Number.isInteger(explicitPartnerId) && explicitPartnerId > 0) {
    const selected = partnerById.get(explicitPartnerId);
    if (!selected) throw new OdooJson2Error(`Selected Odoo supplier ${explicitPartnerId} was not found in this company`);
    // An approved explicit supplier selection is authoritative.  The
    // extracted VAT/TRN remains on the invoice as source evidence, but must
    // not override or contradict the selected provider identity.
    return resolvedSupplier(selected, 100);
  }
  let history: LocalSupplierHistoryRow[] = [];
  if (workspaceOwnerId) {
    const result = await db.query<LocalSupplierHistoryRow>(
      `SELECT s.id AS supplier_id,
              s.name AS supplier_name,
              s.display_name AS supplier_display_name,
              s.tax_number AS supplier_tax_number,
              s.odoo_partner_id,
              i.vendor_name AS historical_vendor_name
         FROM suppliers s
         LEFT JOIN ai_invoice_imports i
           ON i.workspace_owner_id=s.workspace_owner_id
          AND i.supplier_id=s.id
          AND ($2::integer IS NULL OR i.entity_id=$2)
          AND (
            i.provider_sync_status='succeeded'
            OR (i.sync_status='succeeded' AND i.odoo_bill_id IS NOT NULL)
          )
         WHERE s.workspace_owner_id=$1
          AND s.is_archived=false`,
       [workspaceOwnerId, entityId ?? null],
    );
    history = result.rows;
  }

  const localById = new Map<number, LocalSupplierHistoryRow>();
  for (const row of history) {
    if (!localById.has(Number(row.supplier_id))) localById.set(Number(row.supplier_id), row);
  }

  // A reviewer-selected OS supplier with a saved provider mapping is the
  // strongest possible signal. Do not replace it with a similar name.
  if (data.supplier_id != null) {
    const selected = localById.get(Number(data.supplier_id));
    const mapped = selected?.odoo_partner_id == null
      ? null
      : partnerById.get(Number(selected.odoo_partner_id));
    if (mapped) {
      return resolvedSupplier(mapped, 100);
    }
  }

  // A reviewer-selected local supplier outranks stale OCR VAT/TRN. Keep tax
  // matching for unselected imports, but never let OCR redirect an approved
  // supplier to another legal partner.
  const extractedTax = approvedValuesAuthoritative && data.supplier_id != null
    ? ""
    : normalisedTaxNumber(data.vendor_tax_number);
  if (extractedTax) {
    const taxMatches = validPartners.filter((partner) => normalisedTaxNumber(partner.vat) === extractedTax);
    if (taxMatches.length === 1) {
      return resolvedSupplier(taxMatches[0], 100);
    }
    if (taxMatches.length > 1) {
      throw new OdooSupplierAmbiguityError(
        `Multiple Odoo suppliers match tax number "${data.vendor_tax_number}"`,
        taxMatches.map((partner) => ({
          id: partner.id,
          name: partner.name,
          display_name: partner.display_name,
          tax_number: partner.vat,
          score: 100,
        })),
      );
    }
  }

  const aliasesByPartner = new Map<number, Set<string>>();
  const addAlias = (partnerId: number | null, value: string | null | undefined) => {
    if (!partnerId || !value?.trim() || !partnerById.has(partnerId)) return;
    const aliases = aliasesByPartner.get(partnerId) ?? new Set<string>();
    aliases.add(value.trim());
    aliasesByPartner.set(partnerId, aliases);
  };

  for (const row of history) {
    addAlias(row.odoo_partner_id, row.supplier_name);
    addAlias(row.odoo_partner_id, row.supplier_display_name);
    addAlias(row.odoo_partner_id, row.historical_vendor_name);
    if (
      extractedTax &&
      normalisedTaxNumber(row.supplier_tax_number) === extractedTax &&
      row.odoo_partner_id != null &&
      partnerById.has(Number(row.odoo_partner_id))
    ) {
      const mapped = partnerById.get(Number(row.odoo_partner_id))!;
        return resolvedSupplier(mapped, 100);
    }
  }

  const candidates: SupplierCandidate[] = validPartners.map((partner) => ({
    id: partner.id,
    name: partner.name,
    display_name: partner.display_name == null ? null : String(partner.display_name),
    aliases: [...(aliasesByPartner.get(partner.id) ?? [])],
  }));
  const nameMatch = data.vendor_name ? matchSupplierByName(data.vendor_name, candidates) : null;
  if (!nameMatch) {
    const ranked = data.vendor_name ? rankSupplierCandidates(data.vendor_name, candidates, 5) : [];
    const suggestions = ranked.map((candidate) => `${candidate.name} (${candidate.score})`).join(", ");
    throw new OdooSupplierAmbiguityError(
      `${suggestions
        ? "No unambiguous Odoo supplier match found"
        : "No close Odoo supplier match found"} for "${data.vendor_name ?? "(missing name)"}"${suggestions ? `; candidates: ${suggestions}` : ""}`,
      ranked.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        display_name: candidate.display_name,
        tax_number: validPartners.find((partner) => partner.id === candidate.id)?.vat ?? null,
        score: candidate.score,
      })),
    );
  }
  const matchedPartner = partnerById.get(nameMatch.id);
  const matchedTax = normalisedTaxNumber(matchedPartner?.vat);
  if (nameMatch.matchedBy === "exact" && extractedTax && matchedTax && matchedTax !== extractedTax) {
    // An exact legal name with contradictory VAT/TRN evidence is a different
    // legal supplier.  Leave this as a createable no-match rather than
    // silently linking the invoice to the existing partner.
    throw new OdooSupplierAmbiguityError(
      `Existing Odoo supplier "${matchedPartner?.name ?? nameMatch.name}" has a conflicting VAT/TRN`,
      [],
    );
  }
  if (extractedTax && nameMatch.matchedBy !== "exact") {
    throw new OdooSupplierAmbiguityError(
      `No close Odoo supplier match found for "${data.vendor_name ?? "(missing name)"}": supplied tax number does not match the inferred supplier`,
      rankSupplierCandidates(data.vendor_name ?? "", candidates, 5).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        display_name: candidate.display_name,
        tax_number: validPartners.find((partner) => partner.id === candidate.id)?.vat ?? null,
        score: candidate.score,
      })),
    );
  }
  const partner = partnerById.get(nameMatch.id)!;
  return resolvedSupplier(partner, nameMatch.score);
}

export function invoiceMarker(entityId: number, importId: number): string {
  return `[PRESENTAIL-INV:${entityId}:${importId}]`;
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Odoo stores quantities using the configured UoM decimal precision. The
// default product quantity precision is two decimals, so a read-back of
// 22.349 as 22.35 is a representation change, not coding drift.
function odooQuantityCompatible(actual: unknown, expected: number): boolean {
  const actualNumber = Number(actual);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expected)) return false;
  if (Math.abs(actualNumber - expected) <= 0.0001) return true;
  return Math.round(actualNumber * 100) === Math.round(expected * 100);
}

function extractedRateAsPercent(value: unknown): number | null {
  const rate = asFiniteNumber(value);
  if (rate === null || rate < 0) return null;
  // Invoice extraction stores 5% as 0.05, while Odoo stores it as 5.
  return rate <= 1 ? rate * 100 : rate;
}

/**
 * Supplier invoice dates are date-only values. Odoo may serialize the
 * invoice_date field as a timestamp, so compare its date portion and never
 * compare against account.move.date (the posting date).
 */
function dateOnly(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  return String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

async function searchReadAll<T extends Record<string, unknown>>(
  client: OdooJson2Client,
  model: string,
  domain: unknown[][],
  fields: string[],
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let lastId = 0;
  for (let page = 0; page < 100; page += 1) {
    const pageRows = await client.searchRead<T>(
      model,
      [...domain, ...(lastId ? [["id", ">", lastId]] : [])],
      fields,
      pageSize,
      "id asc",
    );
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    if (page === 99) {
      throw new OdooJson2Error(`Odoo ${model} search exceeded the safe pagination limit`);
    }
    const nextId = Math.max(...pageRows.map((row) => Number(row.id)).filter(Number.isFinite));
    if (!Number.isFinite(nextId) || nextId <= lastId) break;
    lastId = nextId;
  }
  return rows;
}

async function enrichInvoiceForOdoo(
  data: ExtractedInvoiceData,
  config: {
    baseUrl: string;
    database: string;
    companyId: number;
    token: string;
    workspaceOwnerId?: string;
    entityId?: number;
    allowSupplierCreation?: boolean;
    defaultExpenseAccountId?: number | null;
    approvedValuesAuthoritative?: boolean;
  },
): Promise<OdooInvoiceEnrichment> {
  const client = new OdooJson2Client({
    baseUrl: config.baseUrl,
    database: config.database,
    companyId: config.companyId,
    apiKey: config.token,
  });

  const productCodes = [...new Set(data.line_items.map((line) => normalisedCode(line.product_code)).filter(Boolean))];
  const accountCodes = [...new Set(data.line_items.map((line) => normalisedCode(line.account_code)).filter(Boolean))];
  const [partners, taxes, currencies, journals, products, explicitAccounts] = await Promise.all([
    client.searchRead<OdooPartner>(
      "res.partner",
      [["active", "=", true], ["supplier_rank", ">", 0]],
        ["id", "name", "display_name", "vat", "parent_id", "commercial_partner_id", "company_id"],
      2000,
    ),
    client.searchRead<OdooTax>(
      "account.tax",
      [
        ["active", "=", true],
        ["company_id", "=", config.companyId],
        ["type_tax_use", "in", ["purchase", "all"]],
        ["amount_type", "=", "percent"],
      ],
      ["id", "name", "amount", "amount_type", "price_include"],
      500,
    ),
    client.searchRead<Record<string, unknown>>(
      "res.currency",
      isLebanesePound(data.currency)
        ? [["id", "=", ODOO_LEBANESE_POUND_ID], ["active", "=", true]]
        : [["active", "=", true], ["name", "=", normaliseCurrencyCode(data.currency)]],
      ["id", "name"],
      2,
    ),
    client.searchRead<Record<string, unknown>>(
      "account.journal",
      [["type", "=", "purchase"], ["company_id", "=", config.companyId], ["active", "=", true]],
      ["id", "name", "code", "company_id", "currency_id", "sequence"],
      20,
      "sequence,id",
    ),
    productCodes.length
      ? client.searchRead<Record<string, unknown>>(
        "product.product",
        [["default_code", "in", productCodes], ["active", "=", true]],
        ["id", "name", "default_code", "company_id", "product_tmpl_id", "categ_id", "property_account_expense_id"],
        productCodes.length * 2,
      )
      : Promise.resolve([]),
    accountCodes.length
      ? client.searchRead<Record<string, unknown>>(
        "account.account",
        [
          ["code", "in", accountCodes],
          ["company_ids", "in", [config.companyId]],
          ["active", "=", true],
        ],
        ["id", "code", "name", "account_type", "company_ids"],
        accountCodes.length * 2,
      )
      : Promise.resolve([]),
  ]);

  let supplier: Awaited<ReturnType<typeof resolveOdooSupplier>>;
  try {
    supplier = await resolveOdooSupplier(
      data,
      partners,
      config.workspaceOwnerId,
      config.entityId,
      !!config.approvedValuesAuthoritative,
    );
  } catch (error) {
    if (
      config.allowSupplierCreation &&
      error instanceof OdooSupplierAmbiguityError &&
      String(data.vendor_name ?? "").trim()
    ) {
      const created = await ensureOdooSupplier(
        {
          odoo_base_url: config.baseUrl,
          odoo_database: config.database,
          odoo_company_id: config.companyId,
        },
        {
          name: String(data.vendor_name).trim(),
          address: data.vendor_address ?? null,
          countryCode: data.billing_country ?? null,
          taxNumber: data.vendor_tax_number ?? null,
        },
      );
      supplier = {
        id: created.id,
        name: created.name,
        score: 100,
        taxNumber: created.taxNumber,
        commercialPartnerId: created.id,
      };
    } else {
      throw error;
    }
  }

  const usableTaxes = taxes
    .map((tax) => ({
      ...tax,
      id: Number(tax.id),
      name: String(tax.name ?? ""),
      amount: Number(tax.amount),
      amount_type: String(tax.amount_type ?? ""),
      price_include: Boolean(tax.price_include),
    }))
    .filter((tax) =>
      Number.isInteger(tax.id) &&
      tax.id > 0 &&
      Number.isFinite(tax.amount) &&
      tax.amount_type === "percent",
    );
  const ambiguousTaxTargets = new Set(
    data.line_items
      .map((line) => extractedRateAsPercent(line.tax_rate))
      .filter((target): target is number =>
        target !== null &&
        usableTaxes.filter((tax) => Math.abs(tax.amount - target) <= 0.01).length > 1,
      ),
  );

  if (!data.vendor_name || !supplier) {
    throw new OdooJson2Error(`No close Odoo supplier match found for "${data.vendor_name}"`);
  }
  // The initial supplier lookup intentionally uses supplier_rank, but ordinary
  // delivery/billing contacts often have supplier_rank=0. Once the selected
  // supplier is known, load its complete active company-visible partner family
  // independently so posted bills entered against a child contact contribute
  // to recurring-supplier account history.
  const supplierFamily = await client.searchRead<OdooPartner>(
    "res.partner",
    [
      ["active", "=", true],
      "|",
      "|",
      ["id", "=", supplier.commercialPartnerId],
      ["commercial_partner_id", "=", supplier.commercialPartnerId],
      ["parent_id", "=", supplier.commercialPartnerId],
      "|",
      ["company_id", "=", false],
      ["company_id", "=", config.companyId],
    ] as unknown as unknown[][],
    ["id", "name", "display_name", "vat", "parent_id", "commercial_partner_id", "company_id"],
    2000,
  );
  const allSupplierPartners = [...new Map(
    [...partners, ...supplierFamily].map((partner) => [Number(partner.id), partner] as const),
  ).values()];
  if (currencies.length !== 1) {
    throw new OdooJson2Error(`Exactly one active Odoo currency must match ${normalisedCode(data.currency)}`);
  }
  const currencyId = Number(currencies[0].id);
  if (!Number.isInteger(currencyId) || currencyId <= 0) {
    throw new OdooJson2Error(`Odoo currency ${normalisedCode(data.currency)} has an invalid ID`);
  }

  const purchaseJournals = journals.filter((journal) =>
    relationId(journal.company_id) === config.companyId &&
    Number.isInteger(Number(journal.id)) &&
    Number(journal.id) > 0,
  );
  const journal = purchaseJournals[0];
  if (!journal) throw new OdooJson2Error("No active Odoo purchase journal exists for this company");

  const productsByCode = new Map<string, Record<string, unknown>[]>();
  for (const product of products) {
    const code = normalisedCode(product.default_code);
    const companyId = relationId(product.company_id);
    if (!code || (companyId !== null && companyId !== config.companyId)) continue;
    productsByCode.set(code, [...(productsByCode.get(code) ?? []), product]);
  }

  const productIds = products.map((product) => Number(product.id)).filter((id) => Number.isInteger(id) && id > 0);
  const productTemplateIds = [...new Set(products.map((product) => relationId(product.product_tmpl_id)).filter((id): id is number => id !== null))];
  const productCategoryIds = [...new Set(products.map((product) => relationId(product.categ_id)).filter((id): id is number => id !== null))];
  const [productTemplates, productCategories] = await Promise.all([
    productTemplateIds.length
      ? client.searchRead<Record<string, unknown>>(
        "product.template",
        [["id", "in", productTemplateIds], ["active", "=", true]],
        ["id", "property_account_expense_id", "categ_id"],
        productTemplateIds.length,
      )
      : Promise.resolve([]),
    productCategoryIds.length
      ? client.searchRead<Record<string, unknown>>(
        "product.category",
        [["id", "in", productCategoryIds]],
        ["id", "property_account_expense_categ_id"],
        productCategoryIds.length,
      )
      : Promise.resolve([]),
  ]);
  const inheritedCategoryIds = [...new Set(
    productTemplates.map((template) => relationId(template.categ_id)).filter((id): id is number => id !== null),
  )].filter((id) => !productCategoryIds.includes(id));
  const inheritedCategories = inheritedCategoryIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "product.category",
      [["id", "in", inheritedCategoryIds]],
      ["id", "property_account_expense_categ_id"],
      inheritedCategoryIds.length,
    )
    : [];
  const allProductCategories = [...productCategories, ...inheritedCategories];
  const historicalLines = (productIds.length || ambiguousTaxTargets.size > 0)
    ? await searchReadAll<Record<string, unknown>>(
      client,
      "account.move.line",
      [
        ...(ambiguousTaxTargets.size > 0 ? [] : [["product_id", "in", productIds]]),
        ["company_id", "=", config.companyId],
        ["move_id.move_type", "=", "in_invoice"],
        ["display_type", "=", "product"],
        ["parent_state", "=", "posted"],
      ],
      ["id", "date", "product_id", "account_id", "tax_ids", "parent_state"],
      1000,
    )
    : [];

  const historicalAccountIdsByProduct = new Map<number, Set<number>>();
  for (const line of historicalLines) {
    const productId = relationId(line.product_id);
    const accountId = relationId(line.account_id);
    if (productId && accountId) {
      const accountIds = historicalAccountIdsByProduct.get(productId) ?? new Set<number>();
      accountIds.add(accountId);
      historicalAccountIdsByProduct.set(productId, accountIds);
    }
  }

  const matchedTaxes = data.line_items.map((line, index) => {
    const target = extractedRateAsPercent(line.tax_rate);
    if (target === null) return null;
    const matches = usableTaxes.filter((tax) => Math.abs(tax.amount - target) <= 0.01);
    const excludedMatches = matches.filter((tax) => !tax.price_include);
    const preferred = excludedMatches.length ? excludedMatches : matches;
    if (preferred.length === 1) return preferred[0];
    if (preferred.length === 0) {
      throw new OdooJson2Error(`No active Odoo purchase tax matches ${target}%`);
    }
    const productCode = normalisedCode(line.product_code);
    const productMatches = productCode ? productsByCode.get(productCode) ?? [] : [];
    const productId = productMatches.length === 1 ? Number(productMatches[0].id) : null;
    const accountCode = normalisedCode(line.account_code);
    const accountMatches = accountCode
      ? explicitAccounts.filter((account) => normalisedCode(account.code) === accountCode)
      : [];
    const accountId = accountMatches.length === 1 ? Number(accountMatches[0].id) : null;
    const historyScores = preferred.map((tax) => {
      let count = 0;
      let productMatches = 0;
      let accountMatches = 0;
      for (const historicalLine of historicalLines) {
        const historicalTaxIds = Array.isArray(historicalLine.tax_ids)
          ? historicalLine.tax_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
          : [];
        if (!historicalTaxIds.includes(tax.id)) continue;
        count += 1;
        if (productId && relationId(historicalLine.product_id) === productId) productMatches += 1;
        if (accountId && relationId(historicalLine.account_id) === accountId) accountMatches += 1;
      }
      return { tax, count, productMatches, accountMatches };
    });
    const rankedHistory = historyScores
      .filter((entry) => entry.count > 0)
      .sort((left, right) =>
        (right.productMatches - left.productMatches) ||
        (right.accountMatches - left.accountMatches) ||
        (right.count - left.count),
      );
    const bestHistory = rankedHistory[0];
    const secondHistory = rankedHistory[1];
    if (bestHistory && (!secondHistory ||
      bestHistory.productMatches !== secondHistory.productMatches ||
      bestHistory.accountMatches !== secondHistory.accountMatches ||
      bestHistory.count !== secondHistory.count)) {
      return bestHistory.tax;
    }
    throw new OdooJson2Error(`Multiple active Odoo purchase taxes match ${target}% for line ${index + 1}`);
  });

  const historicalAccountIds = [...new Set([...historicalAccountIdsByProduct.values()].flatMap((ids) => [...ids]))];
  const configuredAccountIds = [
    ...products.map((product) => relationId(product.property_account_expense_id)),
    ...productTemplates.map((template) => relationId(template.property_account_expense_id)),
    ...allProductCategories.map((category) => relationId(category.property_account_expense_categ_id)),
  ].filter((id): id is number => id !== null);
  const historicalAccounts = historicalAccountIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.account",
      [
        ["id", "in", historicalAccountIds],
        ["company_ids", "in", [config.companyId]],
        ["active", "=", true],
      ],
      ["id", "code", "name", "account_type", "company_ids"],
      historicalAccountIds.length,
    )
    : [];
  const configuredAccounts = configuredAccountIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.account",
      [
        ["id", "in", [...new Set(configuredAccountIds)]],
        ["company_ids", "in", [config.companyId]],
        ["active", "=", true],
      ],
      ["id", "code", "name", "account_type", "company_ids"],
      [...new Set(configuredAccountIds)].length,
    )
    : [];
  // The entity default is an explicit Odoo record selection, not another
  // account-code/name hint. Read that exact ID independently so a broad
  // product/category query, its ordering, or duplicate codes cannot hide the
  // guaranteed final fallback.
  const entityDefaultAccounts = Number.isInteger(config.defaultExpenseAccountId)
    && Number(config.defaultExpenseAccountId) > 0
    ? await client.searchRead<Record<string, unknown>>(
      "account.account",
      [
        ["id", "=", Number(config.defaultExpenseAccountId)],
        ["company_ids", "in", [config.companyId]],
        ["active", "=", true],
      ],
      ["id", "code", "name", "account_type", "company_ids"],
      1,
    )
    : [];
  // Odoo may post the bill against a child contact even when the reviewed
  // invoice is linked to its commercial partner (or the reverse).  Resolve
  // the complete partner family before querying history; restricting this to
  // supplier.id is the reason recurring suppliers often appeared to have no
  // usable account history.
  const supplierPartnerIds = supplier
    ? [...new Set(
      allSupplierPartners
        .filter((partner) => commercialPartnerId(partner) === supplier.commercialPartnerId)
        .map((partner) => Number(partner.id))
        .filter((id) => Number.isInteger(id) && id > 0)
        .concat(supplier.id),
    )]
    : [];
  const supplierHistory = supplier
    ? await searchReadAll<Record<string, unknown>>(
      client,
      "account.move.line",
      [
        ["move_id.partner_id", "in", supplierPartnerIds],
        ["company_id", "=", config.companyId],
        ["move_id.move_type", "=", "in_invoice"],
        ["display_type", "=", "product"],
        ["parent_state", "=", "posted"],
      ],
      ["id", "product_id", "account_id", "parent_state"],
      1000,
    )
    : [];
  const supplierHistoryAccountIds = [...new Set(
    supplierHistory.map((line) => relationId(line.account_id)).filter((id): id is number => id !== null),
  )];
  // Always load the lower-priority entity history. A supplier-family history
  // can contain one raw account ID that later proves inactive, wrong-company,
  // or non-expense; that invalid evidence must not prevent the next tier.
  const sameEntityHistory = await searchReadAll<Record<string, unknown>>(
    client,
    "account.move.line",
    [
      ["company_id", "=", config.companyId],
      ["move_id.move_type", "=", "in_invoice"],
      ["display_type", "=", "product"],
      ["parent_state", "=", "posted"],
    ],
    ["id", "product_id", "account_id", "parent_state"],
    1000,
  );
  const sameEntityHistoryAccountIds = [...new Set(
    sameEntityHistory.map((line) => relationId(line.account_id)).filter((id): id is number => id !== null),
  )];
  const supplierHistoryAccounts = supplierHistoryAccountIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.account",
      [
        ["id", "in", supplierHistoryAccountIds],
        ["company_ids", "in", [config.companyId]],
        ["active", "=", true],
      ],
      ["id", "code", "name", "account_type", "company_ids"],
      supplierHistoryAccountIds.length,
    )
    : [];
  const sameEntityHistoryAccounts = sameEntityHistoryAccountIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.account",
      [
        ["id", "in", sameEntityHistoryAccountIds],
        ["company_ids", "in", [config.companyId]],
        ["active", "=", true],
      ],
      ["id", "code", "name", "account_type", "company_ids"],
      sameEntityHistoryAccountIds.length,
    )
    : [];

  const usableAccounts = [...new Map(
    [...explicitAccounts, ...configuredAccounts, ...entityDefaultAccounts, ...historicalAccounts, ...supplierHistoryAccounts, ...sameEntityHistoryAccounts]
      .map((account) => [Number(account.id), {
        id: Number(account.id),
        code: String(account.code ?? ""),
        name: String(account.name ?? ""),
        account_type: String(account.account_type ?? ""),
      }] as const),
  ).values()]
    .filter((account) =>
      Number.isInteger(account.id) &&
      account.id > 0 &&
      account.code &&
      account.account_type.startsWith("expense"),
    );
  const accountById = new Map(usableAccounts.map((account) => [account.id, account]));
  const accountsByCode = new Map<string, OdooAccount[]>();
  for (const account of usableAccounts) {
    const code = normalisedCode(account.code);
    accountsByCode.set(code, [...(accountsByCode.get(code) ?? []), account]);
  }

  const templateById = new Map(productTemplates.map((template) => [Number(template.id), template]));
  const categoryById = new Map(allProductCategories.map((category) => [Number(category.id), category]));
  const accountForProduct = (product: Record<string, unknown> | undefined): OdooAccount | undefined => {
    if (!product) return undefined;
    const template = templateById.get(relationId(product.product_tmpl_id) ?? -1);
    const category = categoryById.get(relationId(template?.categ_id ?? product.categ_id) ?? -1);
    const resolveConfigured = (ids: number[]) => {
      const matches = [...new Set(ids)]
        .map((id) => accountById.get(id))
        .filter((account): account is OdooAccount => !!account);
      return matches.length === 1 ? matches[0] : undefined;
    };
    // These are ordered tiers, not one ambiguous pool: a product property
    // intentionally overrides a template/category property.
    const productAccount = resolveConfigured(
      [relationId(product.property_account_expense_id)].filter((id): id is number => id !== null),
    );
    if (productAccount) return productAccount;
    const templateAccount = resolveConfigured(
      [relationId(template?.property_account_expense_id)].filter((id): id is number => id !== null),
    );
    if (templateAccount) return templateAccount;
    return resolveConfigured(
      [relationId(category?.property_account_expense_categ_id)].filter((id): id is number => id !== null),
    );
  };

  const historicalAccountForProduct = (productId: number, lineIndex: number): OdooAccount | undefined => {
    const accountIds = historicalAccountIdsByProduct.get(productId);
    if (!accountIds?.size) return undefined;
    const matches = [...accountIds]
      .map((id) => accountById.get(id))
      .filter((account): account is OdooAccount => !!account);
    // History is only authoritative when it identifies one account. Multiple
    // previously used accounts are unresolved at this tier, so lower-priority
    // supplier history or the explicit entity default must decide.
    return matches.length === 1 ? matches[0] : undefined;
  };

  const uniqueValidatedHistoryAccount = (accountIds: number[]): OdooAccount | undefined => {
    const matches = [...new Map(
      accountIds
        .map((id) => accountById.get(id))
        .filter((account): account is OdooAccount => !!account)
        .map((account) => [account.id, account] as const),
    ).values()];
    return matches.length === 1 ? matches[0] : undefined;
  };
  const supplierHistoryAccount = uniqueValidatedHistoryAccount(supplierHistoryAccountIds);
  const sameEntityHistoryAccount = uniqueValidatedHistoryAccount(sameEntityHistoryAccountIds);
  const entityDefaultAccount = entityDefaultAccounts.length === 1
    ? accountById.get(Number(config.defaultExpenseAccountId))
    : undefined;

  const resolvedLines = data.line_items.map((line, index) => {
    const productCode = normalisedCode(line.product_code);
    const accountCode = normalisedCode(line.account_code);
    const productMatches = productCode ? productsByCode.get(productCode) ?? [] : [];
    // Product codes are useful enrichment, but they are not authoritative
    // enough to fail a financially complete invoice. Never choose one from an
    // ambiguous result; omit product_id and continue with the verified account.
    const productMatch = productMatches.length === 1 ? productMatches[0] : undefined;
    const product = productMatch
      ? {
        id: Number(productMatch.id),
        name: String(productMatch.name ?? ""),
        default_code: String(productMatch.default_code ?? ""),
      }
      : null;
    const explicitMatches = accountCode ? accountsByCode.get(accountCode) ?? [] : [];
    // Extracted/local account codes are hints, not provider authority. A stale
    // code may be absent from Odoo or duplicated across account records. Only
    // use it when it resolves uniquely; otherwise continue through the normal
    // product/history/entity-default derivation chain.
    const explicitAccount = explicitMatches.length === 1 ? explicitMatches[0] : undefined;
    const configuredAccount = accountForProduct(productMatch);
    const historicalAccount = !configuredAccount && product
      ? historicalAccountForProduct(product.id, index)
      : undefined;
    const account = explicitAccount
      ?? configuredAccount
      ?? historicalAccount
      ?? supplierHistoryAccount
      ?? sameEntityHistoryAccount
      ?? entityDefaultAccount;
    if (!account) {
      const defaultSetting = Number.isInteger(config.defaultExpenseAccountId)
        && Number(config.defaultExpenseAccountId) > 0
        ? `Entity Settings > Default Expense Account ID ${config.defaultExpenseAccountId} is inactive, belongs to another Odoo company, or is not an expense/direct-cost account`
        : "Configure Entity Settings > Default Expense Account ID";
      throw new OdooAccountResolutionError(
        `No valid Odoo expense account could be derived after all Odoo fallbacks. ${defaultSetting}`,
      );
    }
    return { product, account };
  });

  return {
    partner: {
      id: supplier.id,
      name: supplier.name,
      score: supplier.score,
        taxNumber: supplier.taxNumber
        ?? (String(allSupplierPartners.find((row) => Number(row.id) === supplier.id)?.vat ?? "").trim() || null),
      commercialPartnerId: relationId(allSupplierPartners.find((row) => Number(row.id) === supplier.id)?.commercial_partner_id)
        ?? relationId(allSupplierPartners.find((row) => Number(row.id) === supplier.id)?.parent_id)
        ?? supplier.id,
    },
    journal: { id: Number(journal.id), name: String(journal.name ?? "") },
    currency: { id: currencyId, name: String(currencies[0].name ?? "") },
    taxes: matchedTaxes,
    lines: resolvedLines,
  };
}

type OdooInvoiceMove = {
  id: number;
  name?: string | null;
  state: string;
  move_type: string;
  company_id: unknown;
  journal_id: unknown;
  partner_id: unknown;
  currency_id: unknown;
  message_main_attachment_id?: unknown;
  ref: string;
  invoice_date?: string | null;
  invoice_line_ids: unknown;
  amount_untaxed: number;
  amount_tax: number;
  amount_total: number;
};

const ODOO_INVOICE_MOVE_FIELDS = [
  "id", "name", "state", "move_type", "company_id", "journal_id", "partner_id",
  "currency_id", "ref", "invoice_date", "invoice_line_ids", "amount_untaxed", "amount_tax", "amount_total",
  "message_main_attachment_id",
];

type OdooInvoiceAttachment = {
  id: number;
  name: string;
  res_model: string;
  res_id: number;
  checksum: string;
  mimetype: string;
  description: string;
};

const ODOO_INVOICE_ATTACHMENT_FIELDS = [
  "id", "name", "res_model", "res_id", "checksum", "mimetype", "description", "type",
];

function asInvoiceAttachment(row: Record<string, unknown>): OdooInvoiceAttachment {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    res_model: String(row.res_model ?? ""),
    res_id: Number(row.res_id),
    checksum: String(row.checksum ?? "").trim().toLowerCase(),
    mimetype: String(row.mimetype ?? "").trim().toLowerCase(),
    description: String(row.description ?? ""),
  };
}

async function readInvoiceAttachments(client: OdooJson2Client, moveId: number): Promise<OdooInvoiceAttachment[]> {
  const rows = await client.searchRead<Record<string, unknown>>(
    "ir.attachment",
    [["res_model", "=", "account.move"], ["res_id", "=", moveId]],
    ODOO_INVOICE_ATTACHMENT_FIELDS,
    100,
    "id",
  );
  return rows
    .map(asInvoiceAttachment)
    .filter((attachment) => attachment.id > 0 && attachment.res_model === "account.move" && attachment.res_id === moveId);
}

async function findInvoiceMoveByAttachmentMarker(
  client: OdooJson2Client,
  marker: string,
  invoiceNumber?: string | null,
): Promise<OdooInvoiceMove | null> {
  const rows = await client.searchRead<Record<string, unknown>>(
    "ir.attachment",
    [
      ["res_model", "=", "account.move"],
      ["description", "ilike", marker],
    ],
    ["id", "res_model", "res_id", "description"],
    100,
  );
  const matches = rows.filter((row) =>
    String(row.res_model ?? "") === "account.move" &&
    String(row.description ?? "").includes(marker) &&
    Number(row.res_id) > 0,
  );
  if (matches.length > 1) throw new OdooJson2Error(`Multiple Odoo attachments use idempotency marker ${marker}`);
  if (!matches[0]) return null;
  const move = await readInvoiceMoveById(client, String(Number(matches[0].res_id)));
  if (!move) throw new OdooJson2Error(`Odoo attachment idempotency marker ${marker} does not reference a valid vendor bill`);
  // An attachment marker is an idempotency hint, not permission to select one
  // bill when Odoo contains duplicate posted references. Check the visible
  // reference too when available, and fail closed on multiple posted bills.
  const reference = normaliseInvoiceReference(invoiceNumber);
  if (reference) {
    const referenceRows = await client.searchRead<Record<string, unknown>>(
      "account.move",
      [
        ["move_type", "=", "in_invoice"],
        ["company_id", "=", client.company],
        ["ref", "ilike", reference],
        ["state", "=", "posted"],
      ],
      ODOO_INVOICE_MOVE_FIELDS,
      10,
    );
    const postedMatches = referenceRows.filter((row) =>
      String(row.state ?? "") === "posted" &&
      normaliseInvoiceReference(row.ref) === reference,
    );
    if (postedMatches.length > 1) {
      throw new OdooJson2Error(`Multiple posted Odoo vendor bills match invoice reference ${invoiceNumber}`);
    }
  }
  return move;
}

function normaliseInvoiceReference(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function visibleInvoiceReference(value: string | null | undefined): string {
  const reference = String(value ?? "").trim();
  if (!reference) throw new OdooJson2Error("Supplier invoice number is required for an Odoo vendor bill");
  if (reference.length > 255) throw new OdooJson2Error("Supplier invoice number exceeds Odoo's visible reference limit");
  return reference;
}

async function normaliseVisibleInvoiceReference(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  invoiceNumber: string,
  readOnly: boolean,
): Promise<OdooInvoiceMove> {
  const reference = visibleInvoiceReference(invoiceNumber);
  if (move.ref === reference) return move;
  if (readOnly || move.state === "posted") {
    throw new OdooJson2Error(move.state === "posted"
      ? "Posted Odoo vendor bill cannot be modified during invoice reconciliation"
      : "Odoo vendor bill has a legacy or mismatched visible invoice reference; read-only audit cannot repair it");
  }
  await client.writeOne("account.move", move.id, { ref: reference });
  const updated = await readInvoiceMoveById(client, String(move.id));
  if (!updated || updated.ref !== reference) {
    throw new OdooJson2Error("Odoo vendor bill reference update could not be verified");
  }
  return updated;
}

function asInvoiceMove(row: Record<string, unknown>): OdooInvoiceMove {
  return {
    ...row,
    id: Number(row.id),
    state: String(row.state ?? ""),
    move_type: String(row.move_type ?? ""),
    ref: String(row.ref ?? ""),
    amount_untaxed: Number(row.amount_untaxed),
    amount_tax: Number(row.amount_tax),
    amount_total: Number(row.amount_total),
  } as OdooInvoiceMove;
}

async function readInvoiceMoveById(client: OdooJson2Client, id: string | null | undefined): Promise<OdooInvoiceMove | null> {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const rows = await searchReadAll<Record<string, unknown>>(
    client,
    "account.move",
    [["id", "=", numericId], ["move_type", "=", "in_invoice"], ["company_id", "=", client.company]],
    ODOO_INVOICE_MOVE_FIELDS,
    2,
  );
  return rows[0] ? asInvoiceMove(rows[0]) : null;
}

async function postVerifiedInvoiceMove(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
): Promise<OdooInvoiceMove> {
  if (move.state === "posted") return move;
  if (move.state !== "draft") {
    throw new OdooJson2Error(`Odoo vendor bill ${move.id} is in unsupported state "${move.state || "unknown"}"`);
  }
  await client.postInvoice(move.id);
  const posted = await readInvoiceMoveById(client, String(move.id));
  if (!posted || posted.state !== "posted") {
    throw new OdooJson2Error(
      `Odoo vendor bill ${move.id} was not verified as posted after posting${posted?.state ? ` (state: ${posted.state})` : ""}`,
    );
  }
  return posted;
}

async function readOdooSupplierIdentity(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
): Promise<{
  id: number;
  name: string;
  taxNumber: string | null;
  commercialPartnerId: number;
  commercialName: string;
  commercialTaxNumber: string | null;
}> {
  const partnerId = relationId(move.partner_id);
  if (!partnerId) throw new OdooJson2Error("Verified Odoo bill has no supplier identity");
  const rows = await client.searchRead<Record<string, unknown>>(
    "res.partner",
    [["id", "=", partnerId]],
    ["id", "name", "display_name", "vat", "parent_id", "commercial_partner_id", "company_id"],
    2,
  );
  const partner = rows.find((row) => Number(row.id) === partnerId);
  const name = String(partner?.display_name ?? partner?.name ?? "").trim();
  if (!partner || !name) throw new OdooJson2Error("Verified Odoo bill supplier could not be read");
  const canonicalId = relationId(partner.commercial_partner_id)
    ?? relationId(partner.parent_id)
    ?? partnerId;
  let canonical = partner;
  if (canonicalId !== partnerId) {
    const canonicalRows = await client.searchRead<Record<string, unknown>>(
      "res.partner",
      [["id", "=", canonicalId]],
      ["id", "name", "display_name", "vat", "commercial_partner_id", "company_id"],
      2,
    );
    canonical = canonicalRows.find((row) => Number(row.id) === canonicalId) ?? partner;
  }
  return {
    id: partnerId,
    name,
    taxNumber: String(partner.vat ?? "").trim() || null,
    commercialPartnerId: canonicalId,
    commercialName: String(canonical.display_name ?? canonical.name ?? "").trim() || name,
    commercialTaxNumber: String(canonical.vat ?? "").trim() || null,
  };
}

/**
 * A posted bill is immutable.  For an approved invoice, exact supplier
 * reference plus canonical supplier and accounting identity is sufficient to
 * recover it without comparing mutable OCR/line-coding representation.
 */
async function isConfidentPostedInvoiceMatch(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  data: ExtractedInvoiceData,
  marker?: string,
): Promise<boolean> {
  if (move.state !== "posted" || !data.invoice_number) return false;
  const visibleReferenceMatches = normaliseInvoiceReference(move.ref)
    === normaliseInvoiceReference(visibleInvoiceReference(data.invoice_number));
  if (!visibleReferenceMatches) return false;
  const expectedPartnerId = relationId(data.odoo_partner_id ?? data.partner_id);
  const actualPartnerId = relationId(move.partner_id);
  // Approved recovery is an identity reconciliation, not a re-verification of
  // mutable OCR/accounting representation.  Always resolve both sides to
  // their commercial partner, including when the direct IDs happen to match:
  // Odoo can store a child contact on a bill while the review selected its
  // parent (and vice versa).
  if (!actualPartnerId) return false;
  const actualIdentity = await readOdooSupplierIdentity(client, move);
  const storedPointerMatches = relationId(data.provider_bill_id) === move.id;
  const normalizedApprovedNames = [data.vendor_name, ...(data.vendor_aliases ?? [])]
    .map((name) => normalizeSupplierName(String(name ?? "")))
    .filter(Boolean);
  const exactStoredSupplierAlias = storedPointerMatches
    && normalizedApprovedNames.length > 0
    && [actualIdentity.name, actualIdentity.commercialName].some((name) =>
      normalizedApprovedNames.includes(normalizeSupplierName(name)));
  if (!expectedPartnerId) return exactStoredSupplierAlias;
  const selectedRows = await client.searchRead<Record<string, unknown>>(
    "res.partner",
    [["id", "=", expectedPartnerId], ["active", "=", true], ["company_id", "in", [false, client.company]]],
    ["id", "name", "display_name", "vat", "parent_id", "commercial_partner_id", "company_id"],
    1,
  );
  const selected = selectedRows[0];
  const selectedCommercial = selected
    ? relationId(selected.commercial_partner_id) ?? relationId(selected.parent_id) ?? expectedPartnerId
    : null;
  return (selectedCommercial !== null && selectedCommercial === actualIdentity.commercialPartnerId)
    || exactStoredSupplierAlias;
}

async function findUniquePostedInvoiceBySupplierReference(
  client: OdooJson2Client,
  data: ExtractedInvoiceData,
): Promise<OdooInvoiceMove | null> {
  const reference = normaliseInvoiceReference(data.invoice_number);
  if (!reference) return null;
  const rows = await searchReadAll<Record<string, unknown>>(
    client,
    "account.move",
    [
      ["move_type", "=", "in_invoice"],
      ["company_id", "=", client.company],
      ["ref", "ilike", reference],
      ["state", "=", "posted"],
    ],
    ODOO_INVOICE_MOVE_FIELDS,
    100,
  );
  const exact = rows
    .filter((row) => String(row.state ?? "") === "posted")
    .filter((row) => normaliseInvoiceReference(row.ref) === reference)
    .map(asInvoiceMove);
  if (exact.length > 1) {
    throw new OdooJson2Error(`Multiple posted Odoo vendor bills match supplier invoice reference ${data.invoice_number}`);
  }
  const matching: OdooInvoiceMove[] = [];
  for (const move of exact) {
    if (await isConfidentPostedInvoiceMatch(client, move, data)) matching.push(move);
  }
  return matching[0] ?? null;
}

function postedRecoveryWarnings(): string[] {
  return [
    "posted_bill_recovered_by_supplier_reference",
    "posted_provider_representation_preserved",
  ];
}

async function resolveApprovedSupplierForRecovery(
  client: OdooJson2Client,
  data: ExtractedInvoiceData,
  workspaceOwnerId?: string,
  entityId?: number,
): Promise<ExtractedInvoiceData> {
  const explicitPartnerId = relationId(data.odoo_partner_id ?? data.partner_id);
  if (explicitPartnerId) return data;
  try {
    const [partners, history] = await Promise.all([
      client.searchRead<OdooPartner>(
        "res.partner",
        [["active", "=", true], ["supplier_rank", ">", 0]],
        ["id", "name", "display_name", "vat", "parent_id", "commercial_partner_id", "company_id"],
        2000,
      ),
      workspaceOwnerId
        ? db.query<LocalSupplierHistoryRow>(
          `SELECT s.id AS supplier_id,
                  s.name AS supplier_name,
                  s.display_name AS supplier_display_name,
                  s.tax_number AS supplier_tax_number,
                  s.odoo_partner_id,
                  i.vendor_name AS historical_vendor_name
             FROM suppliers s
             LEFT JOIN ai_invoice_imports i
               ON i.workspace_owner_id=s.workspace_owner_id
              AND i.supplier_id=s.id
              AND ($2::integer IS NULL OR i.entity_id=$2)
               AND EXISTS (
                 SELECT 1
                   FROM ai_invoice_import_sync_attempts a
                  WHERE a.import_id=i.id
                    AND a.destination='odoo'
                    AND a.status='succeeded'
                    AND a.verified_at IS NOT NULL
                    AND a.external_reference=i.odoo_bill_id
                    AND i.provider_bill_id=i.odoo_bill_id
              )
            WHERE s.workspace_owner_id=$1
              AND s.is_archived=false`,
          [workspaceOwnerId, entityId ?? null],
        )
        : Promise.resolve({ rows: [] as LocalSupplierHistoryRow[] }),
    ]);
    const normalizedVendor = normalizeSupplierName(String(data.vendor_name ?? ""));
    const mappedIds = new Set<number>();
    for (const row of history.rows) {
      if (!row.odoo_partner_id) continue;
      const selectedSupplier = data.supplier_id != null
        && Number(row.supplier_id) === Number(data.supplier_id);
      const exactAlias = !!normalizedVendor && [
        row.supplier_name,
        row.supplier_display_name,
        row.historical_vendor_name,
      ].some((alias) => normalizeSupplierName(String(alias ?? "")) === normalizedVendor);
      if (selectedSupplier || exactAlias) mappedIds.add(Number(row.odoo_partner_id));
    }
    if (mappedIds.size > 1) return data;
    let resolved = mappedIds.size === 1
      ? partners.find((partner) => Number(partner.id) === [...mappedIds][0])
      : undefined;
    if (!resolved && normalizedVendor) {
      const exactPartners = partners.filter((partner) =>
        [partner.name, partner.display_name].some((name) =>
          normalizeSupplierName(String(name ?? "")) === normalizedVendor));
      const commercialIds = new Set(exactPartners.map(commercialPartnerId));
      if (commercialIds.size === 1) resolved = exactPartners[0];
    }
    if (!resolved) return data;
    return {
      ...data,
      odoo_partner_id: Number(resolved.id),
      partner_id: Number(resolved.id),
    };
  } catch {
    // Failure to pre-resolve must never create or mutate a supplier during
    // immutable posted-bill recovery.
    return data;
  }
}

function supplierNameMatches(value: string | null | undefined, names: string[]): boolean {
  const candidates = [...new Set(names.map((name) => String(name ?? "").trim()).filter(Boolean))]
    .map((name) => String(name ?? "").trim())
    .map((name, id) => ({
      id,
      name,
      display_name: null,
    }));
  return !!value && !!matchSupplierByName(value, candidates);
}

function supplierTaxMatches(
  expectedTax: string | null | undefined,
  identity: { taxNumber: string | null; commercialTaxNumber: string | null },
): boolean {
  const expected = normalisedTaxNumber(expectedTax);
  const observed = [identity.taxNumber, identity.commercialTaxNumber]
    .map(normalisedTaxNumber)
    .filter(Boolean);
  if (new Set(observed).size > 1) return false;
  return !expected || observed.length === 0 || observed.includes(expected);
}

async function findInvoiceMoveByMarker(
  client: OdooJson2Client,
  marker: string,
  invoiceNumber?: string | null,
): Promise<OdooInvoiceMove | null> {
  const rows = await client.searchRead<Record<string, unknown>>(
    "account.move",
    [
      ["move_type", "=", "in_invoice"],
      ["company_id", "=", client.company],
      ["ref", "ilike", marker],
    ],
    ODOO_INVOICE_MOVE_FIELDS,
    3,
  );
  const exact = rows.filter((row) => String(row.ref ?? "").includes(marker));
  if (exact.length > 1) throw new OdooJson2Error(`Multiple Odoo vendor bills use idempotency marker ${marker}`);
  if (exact[0]) return asInvoiceMove(exact[0]);

  // Historical bills may predate the Presentail marker. A reference search is
  // only a recovery hint; the complete supplier/company/currency/amount/line
  // verification below still has to pass, and ambiguity fails closed.
  const reference = normaliseInvoiceReference(invoiceNumber);
  if (!reference) return null;
  const referenceRows = await client.searchRead<Record<string, unknown>>(
    "account.move",
    [
      ["move_type", "=", "in_invoice"],
      ["company_id", "=", client.company],
      ["ref", "ilike", reference],
    ],
    ODOO_INVOICE_MOVE_FIELDS,
    10,
  );
  const referenceMatches = referenceRows.filter((row) => normaliseInvoiceReference(row.ref) === reference);
  if (referenceMatches.length > 1) throw new OdooJson2Error(`Multiple Odoo vendor bills match invoice reference ${invoiceNumber}`);
  return referenceMatches[0] ? asInvoiceMove(referenceMatches[0]) : null;
}

async function verifyInvoiceMove(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  expected: {
    invoiceNumber?: string | null;
    requireVisibleReference?: boolean;
    companyId: number;
    journalId: number;
    partnerId: number;
    invoiceDate?: string | null;
    currencyId: number;
    lineCount: number;
    partnerCommercialPartnerId?: number;
    partnerTaxNumber?: string | null;
    subtotal: number | null;
    taxAmount: number | null;
    totalAmount: number | null;
    lines: Array<{
      productId: number | null;
      accountId: number;
      taxIds: number[];
      quantity: number;
      priceUnit: number;
    }>;
    verifyAmounts?: boolean;
  },
): Promise<void> {
  const failures: string[] = [];
  if (!Number.isInteger(move.id) || move.id <= 0) failures.push("record ID");
  if (move.move_type !== "in_invoice") failures.push("move type");
  if (!["draft", "posted"].includes(move.state)) failures.push("state");
  const hasInvoiceReference = !!expected.invoiceNumber
    && move.ref === visibleInvoiceReference(expected.invoiceNumber);
  if (expected.requireVisibleReference !== false && !hasInvoiceReference) failures.push("visible invoice reference");
  if (relationId(move.company_id) !== expected.companyId) failures.push("company");
  if (relationId(move.journal_id) !== expected.journalId) failures.push("journal");
  if (relationId(move.partner_id) !== expected.partnerId) {
    failures.push("supplier");
  } else if (expected.partnerCommercialPartnerId || expected.partnerTaxNumber) {
    try {
      const actualSupplier = await readOdooSupplierIdentity(client, move);
      if (
        (expected.partnerCommercialPartnerId
          && actualSupplier.commercialPartnerId !== expected.partnerCommercialPartnerId)
        || !supplierTaxMatches(expected.partnerTaxNumber, actualSupplier)
      ) {
        const actualLabel = actualSupplier.commercialName && actualSupplier.commercialName !== actualSupplier.name
          ? `${actualSupplier.name} (commercial partner: ${actualSupplier.commercialName})`
          : actualSupplier.name;
        failures.push(`supplier (Odoo partner: ${actualLabel}${actualSupplier.taxNumber ? `; VAT/TRN: ${actualSupplier.taxNumber}` : ""})`);
      }
     } catch {
       failures.push("supplier");
     }
  }
  const expectedInvoiceDate = dateOnly(expected.invoiceDate);
  if (expected.invoiceDate && (!expectedInvoiceDate || dateOnly(move.invoice_date) !== expectedInvoiceDate)) {
    failures.push("invoice date");
  }
  if (relationId(move.currency_id) !== expected.currencyId) failures.push("currency");
  const invoiceLineIds = Array.isArray(move.invoice_line_ids) ? move.invoice_line_ids : [];
  const withinTolerance = (actual: number, value: number | null) =>
    value === null || (Number.isFinite(actual) && Math.abs(actual - value) <= 0.02);
  if (expected.verifyAmounts !== false) {
    if (!withinTolerance(move.amount_untaxed, expected.subtotal)) failures.push("subtotal");
    if (!withinTolerance(move.amount_tax, expected.taxAmount)) failures.push("tax total");
    if (!withinTolerance(move.amount_total, expected.totalAmount)) failures.push("total");
  }
  const lineIds = invoiceLineIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const actualLines = lineIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.move.line",
      [["id", "in", lineIds], ["move_id", "=", move.id], ["company_id", "=", expected.companyId]],
       ["id", "product_id", "account_id", "tax_ids", "quantity", "price_unit", "display_type"],
      lineIds.length,
      "id",
    )
     : [];
   const productLines = actualLines.filter((line) =>
     !line.display_type || line.display_type === "product",
   );
   if (productLines.length !== expected.lines.length) {
    failures.push("invoice line details");
  } else {
     const unmatched = [...productLines];
    for (const expectedLine of expected.lines) {
       const matchIndex = unmatched.findIndex((line) => {
        const actualTaxIds = Array.isArray(line.tax_ids)
           ? line.tax_ids.map((id) => relationId(id)).filter((id): id is number => id !== null).sort((a, b) => a - b)
          : [];
        const expectedTaxIds = [...expectedLine.taxIds].sort((a, b) => a - b);
         return (expectedLine.productId === null || relationId(line.product_id) === null || relationId(line.product_id) === expectedLine.productId) &&
          relationId(line.account_id) === expectedLine.accountId &&
          odooQuantityCompatible(line.quantity, expectedLine.quantity) &&
          Math.abs(Number(line.price_unit) - expectedLine.priceUnit) <= 0.0001 &&
          actualTaxIds.length === expectedTaxIds.length &&
          actualTaxIds.every((id, index) => id === expectedTaxIds[index]);
      });
      if (matchIndex < 0) {
        failures.push("invoice line coding");
        break;
      }
      unmatched.splice(matchIndex, 1);
    }
  }
  if (failures.length) {
    throw new OdooJson2Error(`Odoo vendor bill verification failed for: ${failures.join(", ")}`);
  }
}

async function verifyExistingInvoiceMove(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  data: ExtractedInvoiceData,
  companyId: number,
  marker: string,
  requireVisibleReference: boolean,
  verifyAmounts = true,
  resolvedLineCoding?: Array<{ accountId: number; taxIds: number[] }>,
  approvedValuesAuthoritative = false,
): Promise<void> {
  const failures: string[] = [];
  if (!Number.isInteger(move.id) || move.id <= 0) failures.push("record ID");
  if (move.move_type !== "in_invoice") failures.push("move type");
  if (!["draft", "posted"].includes(move.state)) failures.push("state");
  if (relationId(move.company_id) !== companyId) failures.push("company");
  const cleanReference = visibleInvoiceReference(data.invoice_number);
  if (requireVisibleReference) {
    if (move.ref !== cleanReference) failures.push("visible invoice reference");
  } else if (move.ref !== cleanReference && !move.ref.includes(marker)) {
    failures.push("invoice identity");
  }
  const expectedInvoiceDate = dateOnly(data.invoice_date);
  if (data.invoice_date && (!expectedInvoiceDate || dateOnly(move.invoice_date) !== expectedInvoiceDate)) {
    failures.push("invoice date");
  }
  const moveCurrency = Array.isArray(move.currency_id) ? move.currency_id[1] : null;
  if (normaliseCurrencyCode(moveCurrency) !== normaliseCurrencyCode(data.currency)) failures.push("currency");

  const withinTolerance = (actual: number, expected: number | null) =>
    expected === null || (Number.isFinite(actual) && Math.abs(actual - expected) <= 0.02);
  if (verifyAmounts) {
    if (!withinTolerance(move.amount_untaxed, data.subtotal)) failures.push("subtotal");
    if (!withinTolerance(move.amount_tax, data.tax_amount)) failures.push("tax total");
    if (!withinTolerance(move.amount_total, data.total_amount)) failures.push("total");
  }

  const partnerId = relationId(move.partner_id);
  if (!partnerId) {
    failures.push("supplier");
  } else {
    try {
      const identity = await readOdooSupplierIdentity(client, move);
      const explicitPartnerId = Number(data.odoo_partner_id ?? data.partner_id);
      if (Number.isInteger(explicitPartnerId) && explicitPartnerId > 0) {
        const selectedRows = await client.searchRead<Record<string, unknown>>(
          "res.partner",
          [["id", "=", explicitPartnerId], ["active", "=", true]],
          ["id", "name", "display_name", "vat", "commercial_partner_id"],
          1,
        );
        const selected = selectedRows[0];
        const selectedCommercial = relationId(selected?.commercial_partner_id) ?? explicitPartnerId;
        const actualTax = normalisedTaxNumber(identity.taxNumber || identity.commercialTaxNumber);
        const selectedTax = normalisedTaxNumber(selected?.vat);
        if (
          !selected
          || (identity.id !== explicitPartnerId && identity.commercialPartnerId !== selectedCommercial)
          || (!approvedValuesAuthoritative && selectedTax && actualTax && selectedTax !== actualTax)
        ) {
          failures.push("supplier");
        }
      }
      const nameMatches = data.vendor_name
        ? supplierNameMatches(data.vendor_name, [identity.name, identity.commercialName])
        : false;
        if (!Number.isInteger(explicitPartnerId) && ((!nameMatches && !normalisedTaxNumber(data.vendor_tax_number))
          || (!approvedValuesAuthoritative && !supplierTaxMatches(data.vendor_tax_number, identity)))) {
         const actualLabel = identity.commercialName && identity.commercialName !== identity.name
           ? `${identity.name} (commercial partner: ${identity.commercialName})`
           : identity.name;
          failures.push(`supplier (Odoo partner: ${actualLabel}${identity.taxNumber ? `; VAT/TRN: ${identity.taxNumber}` : ""})`);
        }
    } catch {
      failures.push("supplier");
    }
  }

  const invoiceLineIds = Array.isArray(move.invoice_line_ids)
    ? move.invoice_line_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const actualLines = invoiceLineIds.length
    ? await client.searchRead<Record<string, unknown>>(
      "account.move.line",
      [["id", "in", invoiceLineIds], ["move_id", "=", move.id], ["company_id", "=", companyId]],
      ["id", "display_type", "product_id", "account_id", "tax_ids", "quantity", "price_unit"],
      invoiceLineIds.length,
      "id",
    )
    : [];
  const productLines = actualLines.filter((line) => !line.display_type || line.display_type === "product");
  if (productLines.length !== data.line_items.length) {
    failures.push("invoice lines");
  } else {
    const accountIds = [...new Set(productLines.map((line) => relationId(line.account_id)).filter((id): id is number => id !== null))];
    const taxIds = [...new Set(productLines.flatMap((line) =>
      Array.isArray(line.tax_ids)
        ? line.tax_ids.map((id) => relationId(id)).filter((id): id is number => id !== null)
        : [],
    ))];
    const [accounts, taxes] = await Promise.all([
      accountIds.length
        ? client.searchRead<Record<string, unknown>>(
          "account.account",
          [["id", "in", accountIds], ["company_ids", "in", [companyId]], ["active", "=", true]],
          ["id", "code", "account_type", "company_ids"],
          accountIds.length,
        )
        : Promise.resolve([]),
      taxIds.length
        ? client.searchRead<Record<string, unknown>>(
          "account.tax",
          [["id", "in", taxIds], ["company_id", "=", companyId], ["active", "=", true]],
          ["id", "amount", "amount_type", "price_include"],
          taxIds.length,
        )
        : Promise.resolve([]),
    ]);
    const accountById = new Map(accounts.map((account) => [Number(account.id), account]));
    const taxById = new Map(taxes.map((tax) => [Number(tax.id), tax]));
    const unmatched = [...productLines];
    for (const [expectedIndex, expected] of data.line_items.entries()) {
      const expectedTax = extractedRateAsPercent(expected.tax_rate);
      const expectedAccountCode = normalisedCode(expected.account_code);
      const resolvedCoding = resolvedLineCoding?.[expectedIndex];
      const matchIndex = unmatched.findIndex((line) => {
        const actualAccountId = relationId(line.account_id);
        const actualAccount = actualAccountId ? accountById.get(actualAccountId) : undefined;
        const actualTaxIds = Array.isArray(line.tax_ids)
          ? line.tax_ids.map((id) => relationId(id)).filter((id): id is number => id !== null).sort((a, b) => a - b)
          : [];
        const accountMatches = !!actualAccountId && (resolvedCoding
          ? actualAccountId === resolvedCoding.accountId
          : expectedAccountCode
          ? normalisedCode(actualAccount?.code) === expectedAccountCode
          : String(actualAccount?.account_type ?? "").startsWith("expense"));
        const expectedResolvedTaxIds = resolvedCoding
          ? [...resolvedCoding.taxIds].sort((a, b) => a - b)
          : null;
        const resolvedTaxMatches = expectedResolvedTaxIds
          ? actualTaxIds.length === expectedResolvedTaxIds.length
            && actualTaxIds.every((id, index) => id === expectedResolvedTaxIds[index])
          : true;
        // Connector-selected coding is authoritative after draft repair.
        // Approved OCR tax fields may be stale or absent, so do not compare
        // them again when resolved tax IDs are available.
        const taxMatches = resolvedCoding
          ? true
          : expectedTax === null
            ? actualTaxIds.length === 0
            : actualTaxIds.length === 1
              && Math.abs(Number(taxById.get(actualTaxIds[0])?.amount) - expectedTax) <= 0.01
              && String(taxById.get(actualTaxIds[0])?.amount_type ?? "") === "percent";
        return accountMatches
          && resolvedTaxMatches
          && taxMatches
          && odooQuantityCompatible(line.quantity, Number(expected.quantity))
          && Math.abs(Number(line.price_unit) - Number(expected.unit_price)) <= 0.0001;
      });
      if (matchIndex < 0) {
        failures.push("invoice line financial coding");
        break;
      }
      unmatched.splice(matchIndex, 1);
    }
  }
  if (failures.length) {
    throw new OdooJson2Error(`Odoo vendor bill verification failed for: ${failures.join(", ")}`);
  }
}

async function repairDraftInvoiceMove(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  data: ExtractedInvoiceData,
  companyId: number,
  marker: string,
  source: { bytes: Buffer; checksum: string; mimetype: string },
  config: {
    baseUrl: string;
    database: string;
    token: string;
    workspaceOwnerId?: string;
    entityId?: number;
    defaultExpenseAccountId?: number | null;
    approvedValuesAuthoritative?: boolean;
  },
  verifyAmounts = true,
  approvedValuesAuthoritative = false,
): Promise<OdooInvoiceMove> {
  if (move.state === "posted") {
    throw new OdooJson2Error("Posted Odoo vendor bill cannot be modified during invoice reconciliation");
  }
  const enrichment = await enrichInvoiceForOdoo(data, {
    baseUrl: config.baseUrl,
    database: config.database,
    companyId,
    token: config.token,
    workspaceOwnerId: config.workspaceOwnerId,
    entityId: config.entityId,
    defaultExpenseAccountId: config.defaultExpenseAccountId,
    allowSupplierCreation: !!config.workspaceOwnerId,
    approvedValuesAuthoritative: config.approvedValuesAuthoritative,
  });
  const lines = data.line_items.map((line, index) => ({
    name: line.description || `Invoice line ${index + 1}`,
    quantity: line.quantity,
    price_unit: line.unit_price,
    account_id: enrichment.lines[index].account.id,
    ...(enrichment.lines[index].product ? { product_id: enrichment.lines[index].product!.id } : {}),
    tax_ids: [[6, 0, enrichment.taxes[index] ? [enrichment.taxes[index]!.id] : []]],
  }));
  await client.writeOne("account.move", move.id, {
    partner_id: enrichment.partner.id,
    journal_id: enrichment.journal.id,
    currency_id: enrichment.currency.id,
    invoice_date: data.invoice_date,
    invoice_date_due: data.due_date ?? false,
    ref: visibleInvoiceReference(data.invoice_number),
    invoice_line_ids: [[5, 0, 0], ...lines.map((line) => [0, 0, line])],
  });
  const updated = await readInvoiceMoveById(client, String(move.id));
  if (!updated) throw new OdooJson2Error("Repaired Odoo vendor bill could not be read back");
  await verifyExistingInvoiceMove(
    client,
    updated,
    data,
    companyId,
    marker,
    true,
    verifyAmounts,
    lines.map((line) => ({
      accountId: Number(line.account_id),
      taxIds: ((line.tax_ids[0] as [number, number, number[]])[2] ?? []).map(Number),
    })),
    approvedValuesAuthoritative,
  );
  return updated;
}

async function loadSourceDocument(
  pdfStoragePath: string,
  data: ExtractedInvoiceData,
): Promise<{ bytes: Buffer; checksum: string; mimetype: string }> {
  if (!pdfStoragePath || !pdfStoragePath.startsWith("/objects/")) {
    throw new OdooJson2Error("Original invoice source path is required for Odoo sync");
  }
  const file = await objectStorageService.getObjectEntityFile(pdfStoragePath);
  const [bytes] = await file.download();
  if (!bytes?.length) throw new OdooJson2Error("Original invoice source is empty");
  const mimetype = String(data.source_content_type ?? "application/pdf").split(";")[0].trim().toLowerCase() || "application/pdf";
  return {
    bytes,
    checksum: createHash("sha1").update(bytes).digest("hex"),
    mimetype,
  };
}

function invoiceAttachmentValues(
  marker: string,
  source: { bytes: Buffer; mimetype: string },
  filename: string,
): Record<string, unknown> {
  return {
    name: filename,
    type: "binary",
    datas: source.bytes.toString("base64"),
    res_model: "account.move",
    mimetype: source.mimetype,
    description: `Presentail internal idempotency marker ${marker}`,
  };
}

async function ensureInvoiceAttachment(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  marker: string,
  source: { bytes: Buffer; checksum: string; mimetype: string },
  supplierName: string,
  invoiceReference: string | null | undefined,
  readOnly: boolean,
): Promise<number> {
  const filename = buildOdooInvoiceAttachmentName(supplierName, invoiceReference, move.name);
  const attachments = await readInvoiceAttachments(client, move.id);
  const markerMatches = attachments.filter((attachment) => attachment.description.includes(marker));
  const checksumMatches = attachments.filter((attachment) => attachment.checksum === source.checksum);
  const conflictingNameMatches = attachments.filter((attachment) =>
    attachment.name === filename && attachment.checksum !== source.checksum,
  );
  if (markerMatches.length > 1) throw new OdooJson2Error(`Multiple supporting attachments use idempotency marker ${marker}`);
  if (checksumMatches.length > 1) throw new OdooJson2Error(`Multiple supporting attachments match source checksum ${source.checksum}`);
  if (conflictingNameMatches.length) throw new OdooJson2Error("Odoo has a supporting attachment with the same filename but different source bytes");
  if (markerMatches[0] && markerMatches[0].checksum !== source.checksum) {
    throw new OdooJson2Error("Odoo supporting attachment marker points to different source bytes");
  }
  if (markerMatches[0] && checksumMatches[0] && markerMatches[0].id !== checksumMatches[0].id) {
    throw new OdooJson2Error("Odoo has contradictory supporting attachments for this invoice");
  }
  const exact = markerMatches[0] ?? checksumMatches[0];
  const description = `Presentail internal idempotency marker ${marker}`;
  if (exact) {
    if (exact.name !== filename || exact.mimetype !== source.mimetype) {
      if (readOnly) throw new OdooJson2Error("Odoo supporting attachment filename or MIME type does not match the original source");
      await client.writeOne("ir.attachment", exact.id, { name: filename, mimetype: source.mimetype, description });
    } else if (!exact.description.includes(marker)) {
      if (readOnly) throw new OdooJson2Error("Odoo supporting attachment is missing internal idempotency metadata");
      await client.writeOne("ir.attachment", exact.id, { description });
    }
  } else {
    if (readOnly) throw new OdooJson2Error("Odoo vendor bill is missing its original supporting attachment");
    await client.createOne("ir.attachment", {
      ...invoiceAttachmentValues(marker, source, filename),
      res_id: move.id,
    });
  }
  const verified = (await readInvoiceAttachments(client, move.id))
    .filter((attachment) => attachment.checksum === source.checksum);
  if (verified.length !== 1 || verified[0].name !== filename || verified[0].mimetype !== source.mimetype || !verified[0].description.includes(marker)) {
    throw new OdooJson2Error("Odoo supporting attachment could not be verified against the original source");
  }
  return verified[0].id;
}

async function ensureInvoiceMainAttachment(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  attachmentId: number,
  readOnly: boolean,
): Promise<void> {
  const currentMove = await readInvoiceMoveById(client, String(move.id));
  if (!currentMove) throw new OdooJson2Error("Odoo vendor bill could not be read before setting its main invoice attachment");
  const currentMainAttachmentId = relationId(currentMove.message_main_attachment_id);
  if (currentMainAttachmentId) return;
  if (readOnly) return;

  // Keep this write separate from account.move line/reference repairs. Odoo
  // allows this chatter field update on posted bills as well.
  await client.writeOne("account.move", move.id, { message_main_attachment_id: attachmentId });
  const verified = await readInvoiceMoveById(client, String(move.id));
  if (relationId(verified?.message_main_attachment_id) !== attachmentId) {
    throw new OdooJson2Error("Odoo vendor bill main invoice attachment could not be verified");
  }
}

async function ensureInvoiceAttachmentAndMain(
  client: OdooJson2Client,
  move: OdooInvoiceMove,
  marker: string,
  source: { bytes: Buffer; checksum: string; mimetype: string },
  supplierName: string,
  invoiceReference: string | null | undefined,
  readOnly: boolean,
): Promise<void> {
  const attachmentId = await ensureInvoiceAttachment(
    client,
    move,
    marker,
    source,
    supplierName,
    invoiceReference,
    readOnly,
  );
  await ensureInvoiceMainAttachment(client, move, attachmentId, readOnly);
}

export class OdooAccountingConnector implements AccountingConnector {
  readonly system: AccountingSystem = "odoo";

  private entity: {
    odoo_base_url: string | null;
    odoo_database: string | null;
    odoo_integration_token: string | null;
    odoo_company_id: number | null;
    odoo_company_name: string | null;
    odoo_default_expense_account_id?: number | null;
  };

  constructor(entity: {
    odoo_base_url: string | null;
    odoo_database: string | null;
    odoo_integration_token: string | null;
    odoo_company_id: number | null;
    odoo_company_name: string | null;
    odoo_default_expense_account_id?: number | null;
  }) {
    this.entity = entity;
  }

  async createDraftVendorBill(
    entityId: number,
    importId: number,
    data: ExtractedInvoiceData,
    pdfStoragePath: string,
    options?: DraftBillOptions,
  ): Promise<DraftBillResult> {
    const base = normaliseOdooBaseUrl(this.entity.odoo_base_url);
    const database = this.entity.odoo_database;
    const companyId = this.entity.odoo_company_id;
    const apiKey = process.env.ODOO_API_KEY?.trim();
    if (!base.ok || !database || !companyId || !apiKey) {
      logger.warn({ importId }, "OdooConnector: JSON-2 invoice configuration is incomplete");
      return { success: false, error: "Odoo integration not configured on this entity" };
    }
    if (!data.invoice_date || data.line_items.length === 0) {
      return { success: false, error: "Odoo vendor bill requires an invoice date and at least one line" };
    }
  let source: { bytes: Buffer; checksum: string; mimetype: string };
    let moveIdForError: number | undefined;
    let moveStatusForError: string | undefined;
    try {
      source = await loadSourceDocument(pdfStoragePath, data);
    } catch (error) {
      const message = error instanceof Error ? sanitiseOdooErrorText(error.message, apiKey) : "Original invoice source could not be loaded";
      return { success: false, error: message };
    }

    const marker = invoiceMarker(entityId, importId);
    let ref: string;
    try {
      ref = visibleInvoiceReference(data.invoice_number);
    } catch (error) {
      return { success: false, error: error instanceof Error ? sanitiseOdooErrorText(error.message, apiKey) : "Supplier invoice number is required for an Odoo vendor bill" };
    }
    const client = new OdooJson2Client({
      baseUrl: base.url,
      database,
      companyId,
      apiKey,
    });
    if (options?.approvedValuesAuthoritative) {
      data = await resolveApprovedSupplierForRecovery(
        client,
        data,
        options.workspaceOwnerId,
        entityId,
      );
    }

    // Discover and verify existing bills before enrichment. Existing Odoo
    // coding is authoritative; stale or absent local supplier/account/tax
    // mappings must not hide a recoverable bill.
    let storedIdentityVerified = false;
    try {
      const stored = await readInvoiceMoveById(client, data.provider_bill_id);
      if (stored) {
        moveIdForError = stored.id;
        moveStatusForError = stored.state;
        storedIdentityVerified = true;
        const uniquePostedMatch = options?.approvedValuesAuthoritative && stored.state === "posted"
          ? await findUniquePostedInvoiceBySupplierReference(client, data)
          : null;
        if (uniquePostedMatch?.id === stored.id) {
          const supplier = await readOdooSupplierIdentity(client, stored);
          await ensureInvoiceAttachmentAndMain(
            client,
            stored,
            marker,
            source,
            supplier.name,
            data.invoice_number,
            !!options?.readOnly,
          );
          return {
            success: true,
            provider_bill_id: String(stored.id),
            provider_bill_url: `${base.url}/web#id=${stored.id}&model=account.move&view_type=form`,
            provider_bill_status: stored.state,
            provider_supplier_id: supplier.commercialPartnerId,
            provider_supplier_name: supplier.commercialName,
            provider_supplier_tax_number: supplier.commercialTaxNumber,
            outcome: "recovered",
            warnings: postedRecoveryWarnings(),
          };
        }
        await verifyExistingInvoiceMove(client, stored, data, companyId, marker, false, !options?.approvedValuesAuthoritative, undefined, !!options?.approvedValuesAuthoritative);
        const normalized = await normaliseVisibleInvoiceReference(client, stored, ref, !!options?.readOnly);
        await verifyExistingInvoiceMove(client, normalized, data, companyId, marker, true, !options?.approvedValuesAuthoritative, undefined, !!options?.approvedValuesAuthoritative);
        const supplier = await readOdooSupplierIdentity(client, normalized);
        await ensureInvoiceAttachmentAndMain(
          client,
          normalized,
          marker,
          source,
          supplier.name,
          data.invoice_number,
          !!options?.readOnly,
        );
        const posted = options?.readOnly ? normalized : await postVerifiedInvoiceMove(client, normalized);
        moveStatusForError = posted.state;
        return {
          success: true,
          provider_bill_id: String(posted.id),
          provider_bill_url: `${base.url}/web#id=${posted.id}&model=account.move&view_type=form`,
          provider_bill_status: posted.state,
          provider_supplier_id: supplier.commercialPartnerId,
          provider_supplier_name: supplier.commercialName,
          provider_supplier_tax_number: supplier.commercialTaxNumber,
          outcome: "verified_existing",
        };
      }
    } catch (error) {
      if (storedIdentityVerified && typeof moveIdForError === "number") {
        if (moveStatusForError === "posted" && !options?.approvedValuesAuthoritative) {
          return {
            success: false,
            provider_bill_id: String(moveIdForError),
            provider_bill_url: `${base.url}/web#id=${moveIdForError}&model=account.move&view_type=form`,
            provider_bill_status: moveStatusForError,
            reason_code: "posted_bill_conflict",
            error: "Posted Odoo vendor bill conflicts with the approved Presentail invoice and cannot be modified",
          };
        }
        if (moveStatusForError === "posted") {
          // A stale local provider ID may point at a different posted bill.
          // Continue to the canonical supplier/reference search below rather
          // than treating that stale pointer as authoritative.
          storedIdentityVerified = false;
          moveIdForError = undefined;
          moveStatusForError = undefined;
        }
        const message = error instanceof Error ? error.message : "";
        if (moveStatusForError === "draft" && !options?.readOnly) {
          try {
            const repaired = await repairDraftInvoiceMove(
              client,
              (await readInvoiceMoveById(client, String(moveIdForError)))!,
              data,
              companyId,
              marker,
              source,
               {
                 baseUrl: base.url,
                 database,
                 token: apiKey,
                 workspaceOwnerId: options?.workspaceOwnerId,
                 entityId,
                 defaultExpenseAccountId: this.entity.odoo_default_expense_account_id,
                 approvedValuesAuthoritative: !!options?.approvedValuesAuthoritative,
               },
              !options?.approvedValuesAuthoritative,
              !!options?.approvedValuesAuthoritative,
            );
            const repairedSupplier = await readOdooSupplierIdentity(client, repaired);
            await ensureInvoiceAttachmentAndMain(
              client,
              repaired,
              marker,
              source,
              repairedSupplier.name,
              data.invoice_number,
              false,
            );
            const posted = await postVerifiedInvoiceMove(client, repaired);
            moveStatusForError = posted.state;
            const supplier = await readOdooSupplierIdentity(client, posted);
            if (!options?.readOnly && options?.workspaceOwnerId) {
              await linkImportedInvoiceToVerifiedOdooSupplier(
                importId,
                options.workspaceOwnerId,
                {
                  id: supplier.id,
                  name: supplier.name,
                  taxNumber: supplier.taxNumber ?? data.vendor_tax_number,
                },
              );
            }
            return {
              success: true,
              provider_bill_id: String(posted.id),
              provider_bill_url: `${base.url}/web#id=${posted.id}&model=account.move&view_type=form`,
              provider_bill_status: posted.state,
              provider_supplier_id: supplier.commercialPartnerId,
              provider_supplier_name: supplier.commercialName,
              provider_supplier_tax_number: supplier.commercialTaxNumber,
              outcome: "repaired_existing",
            };
          } catch (repairError) {
            if (repairError instanceof OdooAccountResolutionError
              || /account|tax|coding|invoice line/i.test(repairError instanceof Error ? repairError.message : "")) {
              return {
                success: false,
                provider_bill_id: String(moveIdForError),
                provider_bill_url: `${base.url}/web#id=${moveIdForError}&model=account.move&view_type=form`,
                provider_bill_status: moveStatusForError,
                reason_code: "account_resolution_required",
                error: `Odoo expense-account resolution failed: ${sanitiseOdooErrorText(
                  repairError instanceof Error ? repairError.message : "Odoo expense-account resolution failed",
                  apiKey,
                )}`,
              };
            }
            error = repairError;
          }
        }
        if (typeof moveIdForError === "number") {
          return {
            success: false,
            provider_bill_id: String(moveIdForError),
            provider_bill_url: `${base.url}/web#id=${moveIdForError}&model=account.move&view_type=form`,
            provider_bill_status: moveStatusForError,
            error: error instanceof Error ? sanitiseOdooErrorText(error.message, apiKey) : "Existing Odoo bill verification failed",
          };
        }
      }
      // A stale/reassigned local ID is not evidence of sync. Continue through
      // internal marker and clean-reference recovery before considering create.
      moveIdForError = undefined;
      moveStatusForError = undefined;
    }

    try {
      const recoveredBySupplierReference = options?.approvedValuesAuthoritative
        ? await findUniquePostedInvoiceBySupplierReference(client, data)
        : null;
      const recovered = recoveredBySupplierReference
        ?? await findInvoiceMoveByAttachmentMarker(client, marker)
        ?? await findInvoiceMoveByMarker(client, marker, data.invoice_number);
      if (recovered) {
        moveIdForError = recovered.id;
        moveStatusForError = recovered.state;
        if (options?.approvedValuesAuthoritative && await isConfidentPostedInvoiceMatch(client, recovered, data, marker)) {
          const supplier = await readOdooSupplierIdentity(client, recovered);
          await ensureInvoiceAttachmentAndMain(
            client,
            recovered,
            marker,
            source,
            supplier.name,
            data.invoice_number,
            !!options?.readOnly,
          );
          return {
            success: true,
            provider_bill_id: String(recovered.id),
            provider_bill_url: `${base.url}/web#id=${recovered.id}&model=account.move&view_type=form`,
            provider_bill_status: recovered.state,
            provider_supplier_id: supplier.commercialPartnerId,
            provider_supplier_name: supplier.commercialName,
            provider_supplier_tax_number: supplier.commercialTaxNumber,
            outcome: "recovered",
            warnings: postedRecoveryWarnings(),
          };
        }
        await verifyExistingInvoiceMove(client, recovered, data, companyId, marker, false, !options?.approvedValuesAuthoritative, undefined, !!options?.approvedValuesAuthoritative);
        const normalized = await normaliseVisibleInvoiceReference(client, recovered, ref, !!options?.readOnly);
        await verifyExistingInvoiceMove(client, normalized, data, companyId, marker, true, !options?.approvedValuesAuthoritative, undefined, !!options?.approvedValuesAuthoritative);
        const supplier = await readOdooSupplierIdentity(client, normalized);
        await ensureInvoiceAttachmentAndMain(
          client,
          normalized,
          marker,
          source,
          supplier.name,
          data.invoice_number,
          !!options?.readOnly,
        );
        const posted = options?.readOnly ? normalized : await postVerifiedInvoiceMove(client, normalized);
        moveStatusForError = posted.state;
        return {
          success: true,
          provider_bill_id: String(posted.id),
          provider_bill_url: `${base.url}/web#id=${posted.id}&model=account.move&view_type=form`,
          provider_bill_status: posted.state,
          provider_supplier_id: supplier.commercialPartnerId,
          provider_supplier_name: supplier.commercialName,
          provider_supplier_tax_number: supplier.commercialTaxNumber,
          outcome: "recovered",
        };
      }
    } catch (error) {
      if (typeof moveIdForError === "number") {
        return {
          success: false,
          provider_bill_id: String(moveIdForError),
          provider_bill_url: `${base.url}/web#id=${moveIdForError}&model=account.move&view_type=form`,
          provider_bill_status: moveStatusForError,
          ...(moveStatusForError === "posted" ? { reason_code: "posted_bill_conflict" } : {}),
          error: error instanceof Error ? sanitiseOdooErrorText(error.message, apiKey) : "Recovered Odoo bill verification failed",
        };
      }
      return {
        success: false,
        error: error instanceof Error ? sanitiseOdooErrorText(error.message, apiKey) : "Existing Odoo bill lookup failed",
      };
    }

    let enrichment: OdooInvoiceEnrichment | null = null;
    try {
      enrichment = await enrichInvoiceForOdoo(data, {
        baseUrl: base.url,
        database,
        companyId,
        token: apiKey,
        workspaceOwnerId: options?.workspaceOwnerId,
        entityId,
        defaultExpenseAccountId: this.entity.odoo_default_expense_account_id,
        allowSupplierCreation: !options?.readOnly && !!options?.workspaceOwnerId,
        approvedValuesAuthoritative: !!options?.approvedValuesAuthoritative,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resolve Odoo supplier and tax records";
      logger.warn({ importId, error: message }, "OdooConnector: supplier/tax enrichment failed");
      if (error instanceof OdooSupplierAmbiguityError && error.candidates.length > 0) {
        return {
          success: false,
          reason_code: "supplier_confirmation_required",
          supplier_candidates: error.candidates,
          error: message,
        };
      }
      if (error instanceof OdooAccountResolutionError) {
        return {
          success: false,
          reason_code: "account_resolution_required",
          error: `Odoo expense-account resolution failed: ${message}`,
        };
      }
      return { success: false, error: `Odoo supplier/tax lookup failed: ${message}` };
    }

    if (!options?.readOnly && options?.workspaceOwnerId) {
      try {
        await linkImportedInvoiceToVerifiedOdooSupplier(
          importId,
          options.workspaceOwnerId,
          {
            id: enrichment.partner.id,
            name: enrichment.partner.name,
            taxNumber: enrichment.partner.taxNumber ?? data.vendor_tax_number,
          },
        );
      } catch (error) {
        return {
          success: false,
          reason_code: "supplier_mapping_conflict",
          error: error instanceof Error
            ? sanitiseOdooErrorText(error.message, apiKey)
            : "Verified Odoo supplier could not be linked in Presentail OS",
        };
      }
    }

    const invoiceLines = data.line_items.map((line, index) => {
      const tax = enrichment.taxes[index];
      return {
        name: line.description || `Invoice line ${index + 1}`,
        quantity: line.quantity,
        price_unit: line.unit_price,
        account_id: enrichment.lines[index].account.id,
        ...(enrichment.lines[index].product ? { product_id: enrichment.lines[index].product!.id } : {}),
        tax_ids: [[6, 0, tax ? [tax.id] : []]],
      };
    });
    const values = {
      move_type: "in_invoice",
      company_id: companyId,
      journal_id: enrichment.journal.id,
      partner_id: enrichment.partner.id,
      currency_id: enrichment.currency.id,
      invoice_date: data.invoice_date,
      ...(data.due_date ? { invoice_date_due: data.due_date } : {}),
      ref,
      invoice_line_ids: invoiceLines.map((line) => [0, 0, line]),
      // Keep the idempotency marker off customer/accountant-facing bill
      // references while preserving atomic lost-response recovery. Odoo
      // creates this linked source attachment in the same transaction as the
      // account.move, so a committed move always has the internal marker.
       attachment_ids: [[0, 0, invoiceAttachmentValues(
         marker,
         source,
         buildOdooInvoiceAttachmentName(enrichment.partner.name, data.invoice_number, null),
       )]],
    };
    const expected = {
      invoiceNumber: data.invoice_number,
      companyId,
      journalId: enrichment.journal.id,
      partnerId: enrichment.partner.id,
        partnerCommercialPartnerId: enrichment.partner.commercialPartnerId,
        partnerTaxNumber: enrichment.partner.taxNumber,
      invoiceDate: data.invoice_date,
      currencyId: enrichment.currency.id,
      lineCount: invoiceLines.length,
      subtotal: data.subtotal,
      taxAmount: data.tax_amount,
      totalAmount: data.total_amount,
      verifyAmounts: !options?.approvedValuesAuthoritative,
      lines: invoiceLines.map((line) => ({
        productId: "product_id" in line ? Number(line.product_id) : null,
        accountId: Number(line.account_id),
        taxIds: ((line.tax_ids[0] as [number, number, number[]])[2] ?? []).map(Number),
        quantity: Number(line.quantity),
        priceUnit: Number(line.price_unit),
      })),
    };
    try {
      if (options?.readOnly) {
        return {
          success: true,
          outcome: "eligible_create",
          provider_supplier_id: enrichment.partner.id,
          provider_supplier_name: enrichment.partner.name,
          provider_supplier_tax_number: enrichment.partner.taxNumber,
        };
      }

      let moveId: number;
      let recoveredMove: OdooInvoiceMove | null = null;
      try {
        moveId = await client.createOne("account.move", values);
        moveIdForError = moveId;
      } catch (createError) {
        const recovered = await findInvoiceMoveByAttachmentMarker(client, marker)
          ?? await findInvoiceMoveByMarker(client, marker, data.invoice_number).catch(() => null);
        if (!recovered) throw createError;
        await verifyInvoiceMove(client, recovered, { ...expected, requireVisibleReference: false });
        recoveredMove = recovered;
        moveId = recovered.id;
        moveIdForError = moveId;
      }
      const created = recoveredMove
        ?? await findInvoiceMoveByAttachmentMarker(client, marker)
        ?? await findInvoiceMoveByMarker(client, marker, data.invoice_number);
      if (!created || created.id !== moveId) {
        throw new OdooJson2Error("Odoo created a vendor bill but read-after-create verification could not find the bill");
      }
      const normalized = await normaliseVisibleInvoiceReference(client, created, ref, false);
      moveIdForError = normalized.id;
      moveStatusForError = normalized.state;
      await verifyInvoiceMove(client, normalized, expected);
      await ensureInvoiceAttachmentAndMain(
        client,
        normalized,
        marker,
        source,
        enrichment.partner.name,
        data.invoice_number,
        false,
      );
      const posted = await postVerifiedInvoiceMove(client, normalized);
      moveStatusForError = posted.state;
      return {
        success: true,
        provider_bill_id: String(posted.id),
        provider_bill_url: `${base.url}/web#id=${posted.id}&model=account.move&view_type=form`,
        provider_bill_status: posted.state,
        provider_supplier_id: enrichment.partner.id,
        provider_supplier_name: enrichment.partner.name,
        provider_supplier_tax_number: enrichment.partner.taxNumber,
        outcome: recoveredMove ? "recovered" : "created",
      };
    } catch (err) {
      const error = err instanceof Error
        ? sanitiseOdooErrorText(err.message, apiKey)
        : "Network error connecting to Odoo";
      logger.error({ error, importId }, "OdooConnector: JSON-2 vendor bill creation failed");
      return {
        success: false,
        ...(typeof moveIdForError === "number" ? {
          provider_bill_id: String(moveIdForError),
          provider_bill_url: `${base.url}/web#id=${moveIdForError}&model=account.move&view_type=form`,
          provider_bill_status: moveStatusForError,
        } : {}),
        error,
      };
    }
  }

  async getInvoiceStatus(providerBillId: string): Promise<{ status: string; url?: string } | null> {
    const base = normaliseOdooBaseUrl(this.entity.odoo_base_url);
    const database = this.entity.odoo_database;
    const companyId = this.entity.odoo_company_id;
    const apiKey = process.env.ODOO_API_KEY?.trim();
    const billId = Number(providerBillId);
    if (!base.ok || !database || !companyId || !apiKey || !Number.isInteger(billId) || billId <= 0) return null;

    try {
      const client = new OdooJson2Client({ baseUrl: base.url, database, companyId, apiKey });
      const rows = await client.searchRead<Record<string, unknown>>(
        "account.move",
        [["id", "=", billId], ["company_id", "=", companyId], ["move_type", "=", "in_invoice"]],
        ["id", "state"],
        1,
      );
      if (!rows[0]) return null;
      return {
        status: String(rows[0].state ?? "unknown"),
        url: `${base.url}/web#id=${billId}&model=account.move&view_type=form`,
      };
    } catch {
      return null;
    }
  }

  async syncSettings(entityId: number, settings: Record<string, unknown>): Promise<SettingsSyncResult> {
    const { baseUrl, token } = getOdooConfig(this.entity);
    if (!baseUrl || !token) {
      return { success: false, error: "Odoo not configured" };
    }

    try {
      const response = await safeOdooFetch(`${baseUrl}/ai_invoice_import/api/v1/settings/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          entity_id: entityId,
          company_id: this.entity.odoo_company_id,
          settings: { ...settings, auto_post_vendor_bill: false },
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });

      if (!response.ok) {
        return { success: false, error: `Odoo settings sync returned ${response.status}` };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? sanitiseOdooErrorText(err.message, token) : "Network error",
      };
    }
  }

  async syncBankStatementLines(
    _entityId: number,
    journalId: number,
    lines: BankStatementLine[],
  ): Promise<PerLineSyncResult[]> {
    if (lines.some((line) => !line.fingerprint?.trim())) {
      return lines.map((line) => ({
        lineId: line.id,
        success: false,
        error: "Durable line fingerprint is required before Odoo sync",
      }));
    }
    // Bank reconciliation must always use the selected entity's production
    // configuration. Unlike legacy invoice import, it never falls back to
    // process-wide ODOO_* variables.
    const baseUrlResult = normaliseOdooBaseUrl(this.entity.odoo_base_url);
    const baseUrl = baseUrlResult.ok ? baseUrlResult.url : null;
    const database = this.entity.odoo_database;
    // Bank reconciliation is intentionally isolated from the legacy invoice
    // connector.  ODOO_API_KEY is a Replit secret and is never persisted on,
    // or read from, the entity row.
    const token = process.env.ODOO_API_KEY;

    if (
      !baseUrl ||
      !database ||
      !token ||
      this.entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
      this.entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME
    ) {
      logger.warn("OdooConnector: syncBankStatementLines — Odoo not configured");
      return lines.map((l) => ({
        lineId: l.id,
        success: false,
        error: "Odoo JSON-2 integration is not configured (base URL, database, company, and ODOO_API_KEY are required)",
      }));
    }

    let client: OdooJson2Client;
    try {
      client = new OdooJson2Client({
        baseUrl,
        database,
        companyId: this.entity.odoo_company_id,
        apiKey: token,
      });
      // Validate the selected journal once before making any mutations.
      const journal = await client.validateJournal(journalId);
      const company = await client.getCompany();
      if (
        company.id !== LEBANON_ODOO_COMPANY_ID ||
        company.name.trim() !== LEBANON_ODOO_COMPANY_NAME
      ) {
        throw new OdooJson2Error("Odoo company 2 is not Presentail SAL");
      }
      const journalCurrency = journal.currency_name || company.currency_name;
      if (!currenciesCompatible(journalCurrency, lines[0]?.currency)) {
        throw new OdooJson2Error(
          `Configured Odoo journal currency ${journalCurrency ?? "unknown"} is incompatible with bank currency ${normaliseCurrencyCode(lines[0]?.currency)}`,
        );
      }
      if (lines.some((line) => !currenciesCompatible(journalCurrency, line.currency))) {
        throw new OdooJson2Error("One or more bank lines use a currency incompatible with the configured Odoo journal");
      }
    } catch (err) {
      const msg = err instanceof Error ? sanitiseOdooErrorText(err.message, token) : "Odoo journal validation failed";
      return lines.map((l) => ({ lineId: l.id, success: false, error: msg }));
    }

    const results: PerLineSyncResult[] = [];
    // Do not batch these calls: JSON-2 transactions are independent and the
    // Presentail ledger intentionally records a result for every line.
    for (const line of lines) {
      if (!line.line_date || !/^\d{4}-\d{2}-\d{2}$/.test(line.line_date)) {
        results.push({
          lineId: line.id,
          success: false,
          error: "Business date is required for an Odoo bank statement line",
        });
        continue;
      }
      const fingerprint = line.fingerprint!.trim();
      const marker = statementLineMarker(fingerprint);
      try {
        // Search before every create, including retries after a timeout. This
        // handles a committed Odoo transaction whose response was lost.
        const existing = await client.findStatementLineByMarker(marker, journalId);
        if (existing) {
          results.push({
            lineId: line.id,
            success: true,
            odooRecordId: String(existing),
            odooRecordUrl: `${baseUrl}/web#id=${existing}&model=account.bank.statement.line&view_type=form`,
          });
          continue;
        }

        const amounts = parseBankAmounts(line.debit_amount, line.credit_amount);
        const amount = amounts.signed;
        // Standard Odoo has no writable value-date or structured import-id
        // field. Keep the complete source metadata in Presentail and only copy
        // a compact, human-readable note to narration.
        const sourceDetails = [
          line.description?.trim(),
          line.reference?.trim(),
          line.metadata.statement_filename ? `file=${line.metadata.statement_filename}` : null,
          line.metadata.period_start && line.metadata.period_end
            ? `period=${line.metadata.period_start}-${line.metadata.period_end}`
            : null,
          line.value_date ? `value_date=${line.value_date}` : null,
        ].filter(Boolean).join(" | ");
        const compactMetadata = `Presentail bank activity${sourceDetails ? `: ${sourceDetails}` : ""}; line=${line.id}`.slice(0, 900);
        const originalRef = line.reference?.trim() ?? "";
        // Keep the marker at the beginning so Odoo's 255-character ref limit
        // can never truncate the idempotency key.
        const ref = `${marker}${originalRef ? ` ${originalRef}` : ""}`.slice(0, 255);
        const statementLineId = await client.createStatementLine(journalId, {
          journal_id: journalId,
          company_id: this.entity.odoo_company_id,
          date: line.line_date,
          payment_ref: line.description || "",
          ref,
          amount,
          narration: compactMetadata,
        });
        results.push({
          lineId: line.id,
          success: true,
          odooRecordId: String(statementLineId),
          odooRecordUrl: `${baseUrl}/web#id=${statementLineId}&model=account.bank.statement.line&view_type=form`,
        });
      } catch (err) {
        const msg = err instanceof OdooJson2Error || err instanceof Error
          ? sanitiseOdooErrorText(err.message, token)
          : "Odoo JSON-2 statement-line creation failed";
        logger.warn({ lineId: line.id, error: msg }, "OdooConnector: statement line sync failed");
        results.push({ lineId: line.id, success: false, error: msg });
      }
    }
    return results;
  }

  private createBankJson2Client(): OdooJson2Client {
    const base = normaliseOdooBaseUrl(this.entity.odoo_base_url);
    if (
      !base.ok ||
      !this.entity.odoo_database ||
      this.entity.odoo_company_id !== LEBANON_ODOO_COMPANY_ID ||
      this.entity.odoo_company_name?.trim() !== LEBANON_ODOO_COMPANY_NAME ||
      !process.env.ODOO_API_KEY
    ) {
      throw new OdooJson2Error("Odoo JSON-2 integration is not configured");
    }
    return new OdooJson2Client({
      baseUrl: base.url,
      database: this.entity.odoo_database,
      companyId: this.entity.odoo_company_id,
      apiKey: process.env.ODOO_API_KEY,
    });
  }

  async refreshOdooReconciliationState(statementLineIds: number[]) {
    const states = await this.createBankJson2Client().refreshReconciliationState(statementLineIds);
    return states.map((state) => ({
      statementLineId: state.id,
      isReconciled: state.is_reconciled,
      moveLineIds: state.move_line_ids,
      liquidityMoveLineIds: state.liquidity_move_line_ids,
      unreconciledLiquidityMoveLineIds: state.unreconciled_liquidity_move_line_ids,
      statementSideEligibleMoveLineIds: state.statement_side_eligible_move_line_ids,
      unreconciledStatementSideEligibleMoveLineIds:
        state.unreconciled_statement_side_eligible_move_line_ids,
      moveLineReconciled: state.move_line_reconciled,
    }));
  }

  async reconcileOdooMoveLines(moveLineIds: number[]): Promise<unknown> {
    return this.createBankJson2Client().reconcileMoveLines(moveLineIds);
  }

  async validateOdooMoveLineSelection(moveLineIds: number[]) {
    return this.createBankJson2Client().validateMoveLineSelection(moveLineIds);
  }
}
