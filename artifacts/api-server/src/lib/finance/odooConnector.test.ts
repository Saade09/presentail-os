import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOdooSupplier, OdooAccountingConnector } from "./odooConnector";

const { mockSafeOdooFetch } = vi.hoisted(() => ({
  mockSafeOdooFetch: vi.fn(),
}));
const { mockDbQuery } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
}));

const SOURCE_BYTES = Buffer.from("%PDF-presentail-test");
const SOURCE_CHECKSUM = "0aff20827dc8e5286266ff471569e4ebb3ae1330";

vi.mock("./odooUrl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./odooUrl")>();
  return {
    ...actual,
    safeOdooFetch: (...args: unknown[]) => mockSafeOdooFetch(...args),
  };
});

vi.mock("../objectStorage", () => ({
  objectStorageService: {
    getObjectEntityFile: vi.fn(async () => ({
      download: async () => [SOURCE_BYTES],
    })),
  },
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../db.js", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const ENTITY = {
  odoo_base_url: "https://odoo.example.com",
  odoo_database: "presentail_prod",
  odoo_integration_token: "secret-token",
  odoo_company_id: 2,
  odoo_company_name: "Presentail SAL",
};

const ACCOUNT_CODED_INVOICE = {
  vendor_name: "Acme Flowers SAL",
  vendor_tax_number: null,
  vendor_address: null,
  invoice_number: "INV-NEGATIVE",
  invoice_date: "2026-09-16",
  due_date: null,
  currency: "USD",
  subtotal: 100,
  discount: null,
  tax_amount: 11,
  total_amount: 111,
  line_items: [{
    description: "Bouquet",
    quantity: 1,
    unit_price: 100,
    total: 100,
    tax_rate: 0.11,
    account_code: "601101",
  }],
  confidence: 1,
  raw_ai_json: {},
  company_validation_status: "matched" as const,
  company_validation_notes: null,
  billing_country: "LB",
};

function installAccountCodedInvoiceMock(options: {
  taxes?: Array<Record<string, unknown>>;
  actualAccountId?: number;
  accountLookupId?: number;
  accounts?: Array<Record<string, unknown>>;
  initialEmptySearches?: number;
  withAttachment?: boolean;
  visibleReference?: string;
  attachmentCreateError?: string;
  partner?: Record<string, unknown>;
  partners?: Array<Record<string, unknown>>;
  noPartners?: boolean;
  createdPartner?: Record<string, unknown>;
  partnerId?: number;
  movePartnerId?: number;
  countryId?: number;
  canonicalPartner?: Record<string, unknown>;
  products?: Array<Record<string, unknown>>;
  includeDisplayLine?: boolean;
  currencies?: Array<Record<string, unknown>>;
  moveState?: string;
  moveCurrencyId?: number;
  moveInvoiceDate?: string;
  moveAmountUntaxed?: number;
  moveAmountTax?: number;
  moveAmountTotal?: number;
  multipleMoves?: boolean;
  moves?: Array<Record<string, unknown>>;
  actualQuantity?: number;
  actualTaxIds?: number[];
  repairUpdatesLine?: boolean;
  postError?: string;
  postReadState?: string;
  postThrowsAfterCommit?: boolean;
  mainAttachmentId?: number | null;
  attachmentName?: string;
}) {
  let moveSearchCount = 0;
  let currentMoveState = options.moveState ?? "draft";
  let currentAccountId = options.actualAccountId ?? 383;
  let currentTaxIds = options.actualTaxIds ?? [19];
  let currentQuantity = options.actualQuantity ?? 1;
  let currentPriceUnit = 100;
  let currentMainAttachmentId = options.mainAttachmentId ?? null;
  let visibleRef = options.visibleReference
    ?? (options.withAttachment ? "INV-NEGATIVE" : "[PRESENTAIL-INV:7:99] INV-NEGATIVE");
  const attachments: Array<Record<string, unknown>> = options.withAttachment ? [{
    id: 7001,
    name: options.attachmentName ?? "Acme Flowers SAL INV-NEGATIVE.pdf",
    res_model: "account.move",
    res_id: 8899,
    checksum: SOURCE_CHECKSUM,
    mimetype: "application/pdf",
    description: "Presentail internal idempotency marker [PRESENTAIL-INV:7:99]",
  }] : [];
  mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
    if (url.endsWith("/ir.attachment/search_read")) {
      return new Response(JSON.stringify(attachments), { status: 200 });
    }
    if (url.endsWith("/ir.attachment/create")) {
      if (options.attachmentCreateError) throw new Error(options.attachmentCreateError);
      const body = JSON.parse(String(request?.body ?? "{}")) as { vals_list?: Array<Record<string, unknown>> };
      attachments.push({
        ...(body.vals_list?.[0] ?? {}),
        id: 7001,
        name: String(body.vals_list?.[0]?.name ?? "Acme Flowers SAL INV-NEGATIVE.pdf"),
        res_model: "account.move",
        res_id: 8899,
        checksum: SOURCE_CHECKSUM,
        mimetype: "application/pdf",
        description: "Presentail internal idempotency marker [PRESENTAIL-INV:7:99]",
      });
      return new Response("[7001]", { status: 200 });
    }
    if (url.endsWith("/ir.attachment/write")) {
      const body = JSON.parse(String(request?.body ?? "{}")) as { ids?: number[]; vals?: Record<string, unknown> };
      for (const attachment of attachments) {
        if (body.ids?.includes(Number(attachment.id))) Object.assign(attachment, body.vals);
      }
      return new Response("true", { status: 200 });
    }
    if (url.endsWith("/res.partner/search_read")) {
      const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: Array<Array<unknown>> };
      const requestedId = body.domain?.find((part) => part[0] === "id" && part[1] === "=")?.[2];
      if (options.canonicalPartner && Number(requestedId) === Number(options.canonicalPartner.id)) {
        return new Response(JSON.stringify([options.canonicalPartner]), { status: 200 });
      }
      if (options.createdPartner && Number(requestedId) === Number(options.createdPartner.id)) {
        return new Response(JSON.stringify([options.createdPartner]), { status: 200 });
      }
      if (options.noPartners) return new Response("[]", { status: 200 });
      if (requestedId != null && options.partners) {
        const matching = options.partners.find((partner) => Number(partner.id) === Number(requestedId));
        return new Response(JSON.stringify(matching ? [matching] : []), { status: 200 });
      }
      return new Response(JSON.stringify(options.partners ?? [options.partner ?? { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123" }]), { status: 200 });
    }
    if (url.endsWith("/res.partner/create")) return new Response("[302]", { status: 200 });
    if (url.endsWith("/res.country/search_read")) {
      return new Response(JSON.stringify(options.countryId ? [{ id: options.countryId, code: "LB" }] : []), { status: 200 });
    }
    if (url.endsWith("/account.tax/search_read")) {
      return new Response(JSON.stringify(options.taxes ?? [{
        id: 19, name: "VAT 11%", amount: 11, amount_type: "percent", price_include: false,
      }]), { status: 200 });
    }
    if (url.endsWith("/res.currency/search_read")) return new Response(JSON.stringify(options.currencies ?? [{ id: 1, name: "USD" }]), { status: 200 });
    if (url.endsWith("/account.journal/search_read")) {
      return new Response('[{"id":14,"name":"Purchases","company_id":[2,"Presentail SAL"]}]', { status: 200 });
    }
    if (url.endsWith("/product.product/search_read")) {
      return new Response(JSON.stringify(options.products ?? []), { status: 200 });
    }
    if (url.endsWith("/product.template/search_read") || url.endsWith("/product.category/search_read")) {
      return new Response("[]", { status: 200 });
    }
    if (url.endsWith("/account.account/search_read")) {
      if (options.accounts) return new Response(JSON.stringify(options.accounts), { status: 200 });
      const accountId = options.accountLookupId ?? 383;
      const rows = [{ id: 383, code: "601101", name: "Goods & Services", account_type: "expense_direct_cost", company_ids: [2] }];
      if (accountId !== 383) rows.push({ id: accountId, code: "609999", name: "Alternate expense", account_type: "expense_direct_cost", company_ids: [2] });
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (url.endsWith("/account.move/create")) {
      const body = JSON.parse(String(request?.body));
      const attachmentValues = body.vals_list[0].attachment_ids[0][2];
      attachments.push({
        ...attachmentValues,
        id: 7001,
        res_model: "account.move",
        res_id: 8899,
        checksum: SOURCE_CHECKSUM,
      });
      return new Response("[8899]", { status: 200 });
    }
    if (url.endsWith("/account.move/write")) {
      const body = JSON.parse(String(request?.body ?? "{}")) as { vals?: Record<string, unknown> };
      if (body.vals && Object.hasOwn(body.vals, "message_main_attachment_id")) {
        currentMainAttachmentId = Number(body.vals.message_main_attachment_id) || null;
      }
      if (options.repairUpdatesLine) {
        const commands = body.vals?.invoice_line_ids as Array<[number, number, Record<string, unknown>?]> | undefined;
        const replacement = commands?.find((command) => command[0] === 0)?.[2];
        if (replacement) {
          currentAccountId = Number(replacement.account_id);
          currentTaxIds = Array.isArray(replacement.tax_ids)
            ? ((replacement.tax_ids[0] as [number, number, number[]])?.[2] ?? []).map(Number)
            : [];
          currentQuantity = Number(replacement.quantity);
          currentPriceUnit = Number(replacement.price_unit);
        }
      }
      visibleRef = "INV-NEGATIVE";
      return new Response("true", { status: 200 });
    }
    if (url.endsWith("/account.move/action_post")) {
      if (options.postError) throw new Error(options.postError);
      currentMoveState = options.postReadState ?? "posted";
      if (options.postThrowsAfterCommit) throw new Error("connection closed after posting");
      return new Response("true", { status: 200 });
    }
    if (url.endsWith("/account.move/search_read")) {
      moveSearchCount++;
      if (moveSearchCount <= (options.initialEmptySearches ?? 1)) return new Response("[]", { status: 200 });
      const body = JSON.parse(String(request?.body ?? "{}")) as { limit?: number };
      const move = {
        id: 8899,
        name: "BILL/2026/00899",
        state: currentMoveState,
        move_type: "in_invoice",
        company_id: [2, "Presentail SAL"],
        journal_id: [14, "Purchases"],
         partner_id: [options.movePartnerId ?? options.partnerId ?? 301, "Acme Flowers SAL"],
         currency_id: [options.moveCurrencyId ?? 1, options.moveCurrencyId === 96 ? "ل.ل" : "USD"],
        ref: visibleRef,
        message_main_attachment_id: currentMainAttachmentId ? [currentMainAttachmentId, "Existing bill document"] : false,
        invoice_date: options.moveInvoiceDate ?? "2026-09-16",
        invoice_line_ids: options.includeDisplayLine ? [9991, 9992] : [9991],
        amount_untaxed: options.moveAmountUntaxed ?? 100,
        amount_tax: options.moveAmountTax ?? 11,
        amount_total: options.moveAmountTotal ?? 111,
      };
      const rows = options.moves ?? (options.multipleMoves ? [move, { ...move, id: 8900 }] : [move]);
      return new Response(JSON.stringify(rows.slice(0, body.limit ?? rows.length)), { status: 200 });
    }
    if (url.endsWith("/account.move.line/search_read")) {
      const lines = [{
        id: 9991,
        product_id: false,
        account_id: [currentAccountId, "Expense"],
        tax_ids: currentTaxIds,
         quantity: currentQuantity,
        price_unit: currentPriceUnit,
      }, ...(options.includeDisplayLine ? [{
        id: 9992,
        display_type: "line_note",
        product_id: false,
        account_id: false,
        tax_ids: [],
        quantity: 0,
        price_unit: 0,
      }] : [])];
      return new Response(JSON.stringify(lines), { status: 200 });
    }
    throw new Error(`Unexpected Odoo call: ${url}`);
  });
}

const LINES = [
  {
    id: 41,
    line_date: "2026-08-15",
    value_date: "2026-08-16",
    description: "Customer transfer",
    reference: "REF-41",
    debit_amount: null,
    credit_amount: "125.50",
    balance: "500.00",
    currency: "USD",
    metadata: { statement_id: 7 },
    fingerprint: "line-41",
  },
];

afterEach(() => {
  mockSafeOdooFetch.mockReset();
  mockDbQuery.mockReset();
  vi.unstubAllEnvs();
});

describe("OdooAccountingConnector.syncBankStatementLines", () => {
  it("uses JSON-2, company context, journal validation and a deterministic marker", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 22,
          name: "BLOM USD",
          code: "BNK2",
          type: "bank",
          company_id: [2, "Presentail SAL"],
          currency_id: [1, "USD"],
          default_account_id: [1903, "Bank"],
          bank_account_id: [1, "BLOM USD"],
        }]), { status: 200 });
      }
      if (url.endsWith("/res.company/search_read")) {
        return new Response(JSON.stringify([{ id: 2, name: "Presentail SAL", currency_id: [1, "USD"] }]), { status: 200 });
      }
      if (url.endsWith("/account.bank.statement.line/search_read")) {
        return new Response("[]", { status: 200 });
      }
      expect(url).toContain("/account.bank.statement.line/create");
      expect(body.vals_list[0].ref).toContain("[PRESENTAIL-LB:line-41]");
      return new Response("[8001]", { status: 200 });
    });
    const connector = new OdooAccountingConnector(ENTITY);

    const results = await connector.syncBankStatementLines(1, 22, LINES);

    expect(results).toEqual([
      expect.objectContaining({ lineId: 41, success: true, odooRecordId: "8001" }),
    ]);
    expect(mockSafeOdooFetch).toHaveBeenCalledTimes(4);
    const [url, options] = mockSafeOdooFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://odoo.example.com/json/2/account.journal/search_read");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "bearer secret-token",
      "X-Odoo-Database": "presentail_prod",
    });
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      domain: [
        ["id", "=", 22],
        ["type", "=", "bank"],
        ["company_id", "=", 2],
        ["active", "=", true],
      ],
    });
    expect(payload.context).toMatchObject({ allowed_company_ids: [2], force_company: 2 });
  });

  it("returns actionable per-line failures when Odoo rejects the sync", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockResolvedValue(new Response("Unauthorized secret-token", { status: 401 }));
    const connector = new OdooAccountingConnector(ENTITY);

    const results = await connector.syncBankStatementLines(1, 22, LINES);

    expect(results).toEqual([
      {
        lineId: 41,
        success: false,
        error: "Odoo JSON-2 request failed (HTTP 401): Unauthorized [redacted]",
      },
    ]);
  });

  it("returns a network failure for every attempted line", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockRejectedValue(new Error("connection refused secret-token"));
    const connector = new OdooAccountingConnector(ENTITY);

    const results = await connector.syncBankStatementLines(1, 22, LINES);

    expect(results).toEqual([
      { lineId: 41, success: false, error: "connection refused [redacted]" },
    ]);
  });

  it("fails a posted line with no business date instead of inventing today's date", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockResolvedValue(new Response(JSON.stringify([{
      id: 22,
      name: "BLOM USD",
      code: "BNK2",
      type: "bank",
      company_id: [2, "Presentail SAL"],
      currency_id: [1, "USD"],
    }]), { status: 200 }));
    mockSafeOdooFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 22, name: "BLOM USD", code: "BNK2", type: "bank",
          company_id: [2, "Presentail SAL"], currency_id: [1, "USD"],
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 2, name: "Presentail SAL", currency_id: [1, "USD"] }]), { status: 200 });
    });
    const connector = new OdooAccountingConnector(ENTITY);

    const results = await connector.syncBankStatementLines(1, 22, [{ ...LINES[0], line_date: null }]);

    expect(results).toEqual([{
      lineId: 41,
      success: false,
      error: "Business date is required for an Odoo bank statement line",
    }]);
    expect(mockSafeOdooFetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a bank line whose currency conflicts with the configured journal", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 22, name: "BLOM USD", code: "BNK2", type: "bank",
          company_id: [2, "Presentail SAL"], currency_id: [1, "USD"],
        }]), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 2, name: "Presentail SAL", currency_id: [1, "USD"] }]), { status: 200 });
    });

    const results = await new OdooAccountingConnector(ENTITY).syncBankStatementLines(
      1,
      22,
      [{ ...LINES[0], currency: "LBP" }],
    );

    expect(results[0]).toMatchObject({
      lineId: 41,
      success: false,
      error: expect.stringMatching(/currency.*incompatible/i),
    });
    expect(mockSafeOdooFetch).toHaveBeenCalledTimes(2);
  });

  it("recovers a lost create response by finding the marker on retry", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    let createAttempt = 0;
    let markerSearch = 0;
    mockSafeOdooFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 22, name: "BLOM USD", code: "BNK2", type: "bank",
          company_id: [2, "Presentail SAL"], currency_id: [1, "USD"],
        }]), { status: 200 });
      }
      if (url.endsWith("/res.company/search_read")) {
        return new Response(JSON.stringify([{ id: 2, name: "Presentail SAL", currency_id: [1, "USD"] }]), { status: 200 });
      }
      if (url.endsWith("/account.bank.statement.line/create")) {
        createAttempt++;
        if (createAttempt === 1) throw new Error("timeout after commit secret-token");
        return new Response("[8002]", { status: 200 });
      }
      markerSearch++;
      return new Response(
        markerSearch === 1 ? "[]" : JSON.stringify([{ id: 8002, ref: "[PRESENTAIL-LB:line-41]", journal_id: [22, "BLOM USD"], company_id: [2, "Presentail SAL"] }]),
        { status: 200 },
      );
    });
    const connector = new OdooAccountingConnector(ENTITY);

    const first = await connector.syncBankStatementLines(1, 22, LINES);
    const second = await connector.syncBankStatementLines(1, 22, LINES);

    expect(first[0]).toMatchObject({ success: false, lineId: 41 });
    expect(second[0]).toMatchObject({ success: true, odooRecordId: "8002" });
    expect(createAttempt).toBe(1);
  });
});

describe("ensureOdooSupplier", () => {
  const SUPPLIER_ENTITY = {
    odoo_base_url: ENTITY.odoo_base_url,
    odoo_database: ENTITY.odoo_database,
    odoo_company_id: ENTITY.odoo_company_id,
  };

  it("reuses one exact supplier and returns its canonical commercial partner", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body ?? "{}")) as { domain?: unknown[][] };
      if (url.endsWith("/res.partner/search_read")) {
        const requestedId = body.domain?.find((part) => part[0] === "id" && part[1] === "=")?.[2];
        if (Number(requestedId) === 302) {
          return new Response(JSON.stringify([{
            id: 302,
            name: "Canonical Flowers SAL",
            display_name: "Canonical Flowers SAL",
            vat: "LB123",
          }]), { status: 200 });
        }
        return new Response(JSON.stringify([{
          id: 301,
          name: "Flowers Outlet",
          display_name: "Flowers Outlet",
          vat: "LB123",
          commercial_partner_id: [302, "Canonical Flowers SAL"],
        }]), { status: 200 });
      }
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await ensureOdooSupplier(SUPPLIER_ENTITY, {
      name: "Flowers Outlet",
      taxNumber: "LB123",
    });

    expect(result).toEqual({
      id: 302,
      name: "Canonical Flowers SAL",
      taxNumber: "LB123",
      created: false,
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/res.partner/create"))).toBe(false);
  });

  it("creates a reviewed supplier with safe identity and company-scoped fields", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/res.partner/search_read")) {
        const body = JSON.parse(String(options.body ?? "{}")) as { domain?: unknown[][] };
        const requestedId = body.domain?.find((part) => part[0] === "id" && part[1] === "=")?.[2];
        return Number(requestedId) === 901
          ? new Response('[{"id":901,"name":"New Reviewed Supplier","display_name":"New Reviewed Supplier","vat":"LB-456"}]', { status: 200 })
          : new Response("[]", { status: 200 });
      }
      if (url.endsWith("/res.country/search_read")) return new Response('[{"id":99,"code":"LB"}]', { status: 200 });
      if (url.endsWith("/res.partner/create")) return new Response("[901]", { status: 200 });
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await ensureOdooSupplier(SUPPLIER_ENTITY, {
      name: "New Reviewed Supplier",
      address: "Beirut",
      countryCode: "LB",
      taxNumber: "LB-456",
    });

    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/res.partner/create"));
    const values = JSON.parse(String(createCall?.[1]?.body)).vals_list[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      name: "New Reviewed Supplier",
      company_type: "company",
      is_company: true,
      supplier_rank: 1,
      customer_rank: 0,
      company_id: 2,
      street: "Beirut",
      vat: "LB-456",
      country_id: 99,
    });
    expect(result).toMatchObject({ id: 901, name: "New Reviewed Supplier", created: true });
  });
});

describe("OdooAccountingConnector.createDraftVendorBill", () => {
  it("uses an approved mapped supplier despite OCR VAT disagreement", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      partner: { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "CANONICAL-VAT" },
      partnerId: 301,
    });
    const approvedData = {
      ...ACCOUNT_CODED_INVOICE,
      source_filename: "scanner-OCR-name.png",
      vendor_tax_number: "OCR-VAT",
      odoo_partner_id: 301,
    };
    const connector = new OdooAccountingConnector(ENTITY);
    const result = await connector.createDraftVendorBill(
      7,
      101,
      approvedData,
      "/objects/invoice-101.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({
      success: true,
      provider_bill_id: "8899",
      provider_supplier_id: 301,
      provider_supplier_tax_number: "CANONICAL-VAT",
    });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    const createdValues = JSON.parse(String(createCall?.[1]?.body)).vals_list[0];
    expect(createdValues.partner_id).toBe(301);
    expect(createdValues.attachment_ids[0][2].name).toBe("Acme Flowers SAL INV-NEGATIVE.pdf");
    expect(createdValues.attachment_ids[0][2].name).not.toContain("scanner-OCR-name");
    expect(approvedData.vendor_tax_number).toBe("OCR-VAT");
    expect(result.provider_supplier_tax_number).toBe("CANONICAL-VAT");
  });

  it("maps approved LBP aliases to Odoo currency 96", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      currencies: [{ id: 96, name: "ل.ل" }],
      moveCurrencyId: 96,
    });
    const connector = new OdooAccountingConnector(ENTITY);
    const result = await connector.createDraftVendorBill(
      7,
      102,
      { ...ACCOUNT_CODED_INVOICE, currency: "Lebanese Pound" },
      "/objects/invoice-102.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].currency_id).toBe(96);
  });

  it("sets a posted bill's missing main scan using a separate attachment-only write", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      withAttachment: true,
      visibleReference: "INV-NEGATIVE",
      initialEmptySearches: 0,
    });
    const connector = new OdooAccountingConnector(ENTITY);
    const result = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    const second = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_supplier_id: 301,
      provider_supplier_name: "Acme Flowers SAL",
      provider_supplier_tax_number: "LB123",
    });
    expect(second).toMatchObject({ success: true, outcome: "recovered", provider_bill_id: "8899" });
    const moveWrites = mockSafeOdooFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/account.move/write"));
    expect(moveWrites).toHaveLength(1);
    const postedWrite = JSON.parse(String(moveWrites[0][1]?.body)).vals;
    expect(postedWrite).toEqual({ message_main_attachment_id: 7001 });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
  });

  it("preserves an already designated main document on a posted bill", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      withAttachment: true,
      mainAttachmentId: 9001,
      initialEmptySearches: 0,
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({ success: true, provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/write"))).toHaveLength(0);
  });

  it("recovers a posted bill whose supplier reference differs only by case and whitespace", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      withAttachment: true,
      mainAttachmentId: 9001,
      visibleReference: "  inv-negative  ",
      initialEmptySearches: 0,
      moveCurrencyId: 96,
      moveInvoiceDate: "2026-08-01",
      moveAmountUntaxed: 850,
      moveAmountTax: 0,
      moveAmountTotal: 850,
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_bill_status: "posted",
      warnings: [
        "posted_bill_recovered_by_supplier_reference",
        "posted_provider_representation_preserved",
      ],
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/action_post"))).toBe(false);
  });

  it("rejects a posted marker-reference bill whose visible invoice reference differs", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      visibleReference: "[PRESENTAIL-INV:7:99] INV-NEGATIVE",
      initialEmptySearches: 0,
      actualAccountId: 999,
      actualTaxIds: [77],
      includeDisplayLine: true,
      moveCurrencyId: 96,
      moveInvoiceDate: "2026-08-01",
      moveAmountUntaxed: 850,
      moveAmountTax: 0,
      moveAmountTotal: 850,
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      {
        ...ACCOUNT_CODED_INVOICE,
        line_items: [{
          ...ACCOUNT_CODED_INVOICE.line_items[0],
          description: "Different approved description",
          product_code: "DIFFERENT-PRODUCT",
          account_code: "609999",
          tax_rate: 0.21,
        }],
        odoo_partner_id: 301,
      },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({
      success: false,
      provider_bill_id: "8899",
      provider_bill_status: "posted",
      reason_code: "posted_bill_conflict",
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/action_post"))).toBe(false);
  });

  it.each([
    ["#383-style financial coding", { actualAccountId: 999 }, {}],
    ["#382-style invoice lines", {}, {
      line_items: [
        ACCOUNT_CODED_INVOICE.line_items[0],
        { ...ACCOUNT_CODED_INVOICE.line_items[0], description: "Second approved line" },
      ],
    }],
    ["date plus financial coding", { actualAccountId: 999, moveInvoiceDate: "2024-01-02" }, {}],
    ["supplier plus financial coding through the canonical commercial partner", {
      actualAccountId: 999,
      movePartnerId: 302,
      partners: [
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "CANONICAL", commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
        { id: 302, name: "Acme Flowers Outlet", display_name: "Acme Flowers Outlet", vat: "STALE", parent_id: [301, "Acme Flowers SAL"], commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
      ],
    }, { odoo_partner_id: 301, vendor_tax_number: "OCR-STALE" }],
    ["date plus invoice lines", { moveInvoiceDate: "2024-01-02" }, {
      line_items: [
        ACCOUNT_CODED_INVOICE.line_items[0],
        { ...ACCOUNT_CODED_INVOICE.line_items[0], description: "Second approved line" },
      ],
    }],
  ])("recovers an approved posted bill for %s without modifying provider representation", async (_label, mockOptions, dataOverrides) => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [] });
    installAccountCodedInvoiceMock({
      moveState: "posted",
      visibleReference: "INV-NEGATIVE",
      initialEmptySearches: 0,
      withAttachment: true,
      mainAttachmentId: 9001,
      ...mockOptions,
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      {
        ...ACCOUNT_CODED_INVOICE,
        odoo_partner_id: undefined,
        partner_id: undefined,
        ...dataOverrides,
      },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true, workspaceOwnerId: "workspace-1" },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_bill_status: "posted",
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/action_post"))).toBe(false);
  });

  it("recovers the #383-style posted Raidan bill through saved supplier-history aliases", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM suppliers s")
        ? {
          rows: [{
            supplier_id: 35,
            supplier_name: "Raidan Floriculture S.A.R.L.",
            supplier_display_name: null,
            supplier_tax_number: "2724085-601",
            odoo_partner_id: 354,
            historical_vendor_name: "Raidan SALES SARL",
          }],
        }
        : { rows: [] });
    installAccountCodedInvoiceMock({
      moveState: "posted",
      mainAttachmentId: 9001,
      visibleReference: "SF2602207",
      initialEmptySearches: 0,
      actualAccountId: 999,
      partnerId: 354,
      movePartnerId: 355,
      moveInvoiceDate: "2026-01-01",
      partners: [
        { id: 354, name: "Raidan Floriculture S.A.R.L.", display_name: "Raidan Floriculture S.A.R.L.", vat: "2724085-601", commercial_partner_id: [354, "Raidan Floriculture S.A.R.L."], company_id: [2, "Presentail SAL"], supplier_rank: 1 },
        { id: 355, name: "Raidan SALES", display_name: "Raidan SALES", vat: "STALE", parent_id: [354, "Raidan Floriculture S.A.R.L."], commercial_partner_id: [354, "Raidan Floriculture S.A.R.L."], company_id: [2, "Presentail SAL"], supplier_rank: 0 },
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      383,
      {
        ...ACCOUNT_CODED_INVOICE,
        invoice_number: "SF2602207",
        vendor_name: "Raidan SALES SARL",
        vendor_tax_number: null,
        supplier_id: null,
        provider_bill_id: "8899",
        odoo_partner_id: undefined,
        partner_id: undefined,
      },
      "/objects/invoice-383.pdf",
      { approvedValuesAuthoritative: true, workspaceOwnerId: "workspace-1" },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_supplier_id: 354,
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
  });

  it("recovers an older posted bill through its stored ID and exact legal supplier alias", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      mainAttachmentId: 9001,
      visibleReference: "SF2602409",
      initialEmptySearches: 0,
      partnerId: 354,
      movePartnerId: 56,
      moveInvoiceDate: "2026-08-27",
      partners: [
        { id: 56, name: "Raidan Floriculture SARL", display_name: "Raidan Floriculture SARL", vat: "2035191", commercial_partner_id: [56, "Raidan Floriculture SARL"], company_id: false, supplier_rank: 1 },
        { id: 354, name: "Raidan Floriculture S.A.R.L", display_name: "Raidan Floriculture S.A.R.L", vat: "2724085-601", commercial_partner_id: [354, "Raidan Floriculture S.A.R.L"], company_id: [2, "Presentail SAL"], supplier_rank: 1 },
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      280,
      {
        ...ACCOUNT_CODED_INVOICE,
        invoice_number: "SF2602409",
        vendor_name: "Raidan Floriculture S.A.R.L.",
        vendor_tax_number: "2724085-601",
        supplier_id: 35,
        provider_bill_id: "8899",
        odoo_partner_id: 354,
        partner_id: 354,
      },
      "/objects/invoice-280.pdf",
      { approvedValuesAuthoritative: true, workspaceOwnerId: "workspace-1" },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_supplier_id: 56,
    });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
  });

  it("recovers a posted child contact for an approved parent supplier and attaches once", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      mainAttachmentId: 9001,
      visibleReference: "INV-NEGATIVE",
      initialEmptySearches: 0,
      partnerId: 301,
      movePartnerId: 302,
      partners: [
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123", commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
        { id: 302, name: "Acme Flowers - Beirut", display_name: "Acme Flowers - Beirut", vat: "LB123", commercial_partner_id: [301, "Acme Flowers SAL"], parent_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
      ],
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({
      success: true,
      outcome: "recovered",
      provider_bill_id: "8899",
      provider_supplier_id: 301,
      provider_supplier_name: "Acme Flowers SAL",
      provider_supplier_tax_number: "LB123",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });

  it("rejects a posted contact belonging to an unrelated commercial partner", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      visibleReference: "INV-NEGATIVE",
      initialEmptySearches: 0,
      partnerId: 301,
      movePartnerId: 302,
      partners: [
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123", commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
        { id: 302, name: "Other Supplier Contact", display_name: "Other Supplier Contact", vat: "OTHER", commercial_partner_id: [303, "Other Supplier"], parent_id: [303, "Other Supplier"], company_id: [2, "Presentail SAL"] },
      ],
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({ success: false });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
  });

  it("fails closed when multiple posted bills share the normalized supplier reference", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    const move = (id: number, partnerId: number) => ({
      id,
      state: "posted",
      move_type: "in_invoice",
      company_id: [2, "Presentail SAL"],
      journal_id: [14, "Purchases"],
      partner_id: [partnerId, partnerId === 301 ? "Acme Flowers SAL" : "Other Supplier"],
      currency_id: [1, "USD"],
      ref: "INV-NEGATIVE",
      invoice_date: "2026-09-16",
      invoice_line_ids: [9991],
      amount_untaxed: 100,
      amount_tax: 11,
      amount_total: 111,
    });
    installAccountCodedInvoiceMock({
      initialEmptySearches: 0,
      moves: [move(8899, 999), move(8900, 301)],
      partners: [
        { id: 999, name: "Other Supplier", display_name: "Other Supplier", vat: "OTHER", commercial_partner_id: [999, "Other Supplier"], company_id: [2, "Presentail SAL"] },
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123", commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899", odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({ success: false });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/action_post"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/ir.attachment/create"))).toBe(false);
  });

  it("checks beyond the first ten Odoo search results before declaring a posted reference unique", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    const move = (id: number, ref: string) => ({
      id,
      state: "posted",
      move_type: "in_invoice",
      company_id: [2, "Presentail SAL"],
      journal_id: [14, "Purchases"],
      partner_id: [301, "Acme Flowers SAL"],
      currency_id: [1, "USD"],
      ref,
      invoice_date: "2026-09-16",
      invoice_line_ids: [9991],
      amount_untaxed: 100,
      amount_tax: 11,
      amount_total: 111,
    });
    installAccountCodedInvoiceMock({
      initialEmptySearches: 0,
      moves: [
        move(8899, "INV-NEGATIVE"),
        ...Array.from({ length: 9 }, (_, index) => move(8900 + index, `INV-NEGATIVE-${index + 1}`)),
        move(8999, " inv-negative "),
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899", odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({ success: false });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });

  it("fails closed when the stored canonical bill has a second exact-reference posted duplicate", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    const move = (id: number, partnerId: number) => ({
      id,
      state: "posted",
      move_type: "in_invoice",
      company_id: [2, "Presentail SAL"],
      journal_id: [14, "Purchases"],
      partner_id: [partnerId, partnerId === 301 ? "Acme Flowers SAL" : "Other Supplier"],
      currency_id: [1, "USD"],
      ref: "INV-NEGATIVE",
      invoice_date: "2026-09-16",
      invoice_line_ids: [9991],
      amount_untaxed: 100,
      amount_tax: 11,
      amount_total: 111,
    });
    installAccountCodedInvoiceMock({
      initialEmptySearches: 0,
      moves: [move(8899, 301), move(8900, 999)],
      partners: [
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123", commercial_partner_id: [301, "Acme Flowers SAL"], company_id: [2, "Presentail SAL"] },
        { id: 999, name: "Other Supplier", display_name: "Other Supplier", vat: "OTHER", commercial_partner_id: [999, "Other Supplier"], company_id: [2, "Presentail SAL"] },
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899", odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result).toMatchObject({ success: false });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/create"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/action_post"))).toBe(false);
  });

  it("fails closed for a posted bill with contradictory invoice reference", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      visibleReference: "OTHER-INVOICE",
      initialEmptySearches: 0,
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({ success: false, provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });

  it("fails closed when multiple posted bills match the recovery marker", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({
      moveState: "posted",
      visibleReference: "INV-NEGATIVE",
      multipleMoves: true,
      initialEmptySearches: 0,
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, odoo_partner_id: 301 },
      "/objects/invoice-99.pdf",
      { approvedValuesAuthoritative: true },
    );
    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toMatch(/multiple/i);
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });

  it("supports a read-only reconciliation pass without creating a bill", async () => {
    installAccountCodedInvoiceMock({ withAttachment: true, initialEmptySearches: 0 });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
      { readOnly: true },
    );

    expect(result).toMatchObject({ success: true, outcome: "recovered", provider_bill_id: "8899" });
    expect(mockSafeOdooFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/account.move/create"),
      expect.anything(),
    );
  });

  it("fails read-only reconciliation when the existing bill has no exact source attachment", async () => {
    installAccountCodedInvoiceMock({ visibleReference: "INV-NEGATIVE" });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
      { readOnly: true },
    );

    expect(result).toMatchObject({
      success: false,
      provider_bill_id: "8899",
      error: "Odoo vendor bill is missing its original supporting attachment",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(0);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/action_post"))).toHaveLength(0);
  });

  it("fails with the provider identity when Odoo rejects posting a matching Draft bill", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0, postError: "Posting is blocked by Odoo" });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );

    expect(result).toMatchObject({
      success: false,
      provider_bill_id: "8899",
      provider_bill_status: "draft",
      error: "Posting is blocked by Odoo",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/action_post"))).toHaveLength(1);
  });

  it("does not report success when posting read-back remains Draft", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0, postReadState: "draft" });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );

    expect(result).toMatchObject({
      success: false,
      provider_bill_id: "8899",
      provider_bill_status: "draft",
      error: "Odoo vendor bill 8899 was not verified as posted after posting (state: draft)",
    });
  });

  it("recovers a bill after the posting response is lost without reposting it", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0, postThrowsAfterCommit: true });
    const connector = new OdooAccountingConnector(ENTITY);

    const first = await connector.createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );
    const second = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: first.provider_bill_id },
      "/objects/invoice-99.pdf",
    );

    expect(first).toMatchObject({ success: false, provider_bill_id: "8899" });
    expect(second).toMatchObject({ success: true, provider_bill_id: "8899", provider_bill_status: "posted" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/action_post"))).toHaveLength(1);
  });

  it("repairs a recovered legacy bill reference and attaches the source without creating another bill", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0 });
    const connector = new OdooAccountingConnector(ENTITY);

    const first = await connector.createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );
    const second = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: first.provider_bill_id },
      "/objects/invoice-99.pdf",
    );
    const third = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: first.provider_bill_id },
      "/objects/invoice-99.pdf",
    );

    expect(first).toMatchObject({ success: true, outcome: "recovered", provider_bill_id: "8899" });
    expect(second).toMatchObject({ success: true, outcome: "verified_existing", provider_bill_id: "8899" });
    expect(third).toMatchObject({ success: true, outcome: "verified_existing", provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(0);
    const writes = mockSafeOdooFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/account.move/write"))
      .map(([, request]) => JSON.parse(String(request?.body)).vals);
    expect(writes).toHaveLength(2);
    expect(writes).toContainEqual({ message_main_attachment_id: 7001 });
    expect(writes).toContainEqual({ ref: "INV-NEGATIVE" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(1);
  });

  it("preserves the recovered bill identity when supporting attachment upload fails", async () => {
    installAccountCodedInvoiceMock({ attachmentCreateError: "attachment upload denied", initialEmptySearches: 0 });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );

    expect(result).toMatchObject({
      success: false,
      provider_bill_id: "8899",
      provider_bill_status: "draft",
      error: "attachment upload denied",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(0);
  });

  it("verifies the same bill on a second run without a second provider create", async () => {
    vi.stubEnv("ODOO_API_KEY", "json2-secret");
    installAccountCodedInvoiceMock({
      initialEmptySearches: 2,
      accounts: [
        { id: 383, code: "601101", name: "Entity default", account_type: "expense_direct_cost", company_ids: [2] },
        { id: 410, code: "413418", name: "Legacy A", account_type: "expense_direct_cost", company_ids: [2] },
        { id: 411, code: "413418", name: "Legacy B", account_type: "expense_direct_cost", company_ids: [2] },
      ],
    });
    const connector = new OdooAccountingConnector(ENTITY);

    const first = await connector.createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
    );
    const second = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: first.provider_bill_id },
      "/objects/invoice-99.pdf",
    );

    expect(first).toMatchObject({ success: true, outcome: "created", provider_bill_id: "8899" });
    expect(second).toMatchObject({ success: true, outcome: "verified_existing", provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
  });

  it("creates, verifies, and posts a vendor bill entirely through JSON-2", async () => {
    vi.stubEnv("ODOO_API_KEY", "json2-secret");
    let moveSearchCount = 0;
    let moveCreated = false;
    let moveState = "draft";
    let currentMainAttachmentId: number | null = null;
    const attachments: Array<Record<string, unknown>> = [];
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      expect(options.headers).toMatchObject({ Authorization: "bearer json2-secret" });
      if (url.endsWith("/ir.attachment/search_read")) return new Response(JSON.stringify(attachments), { status: 200 });
      if (url.endsWith("/ir.attachment/create")) {
        attachments.push({
          id: 7010, name: "INV-44", res_model: "account.move", res_id: 8801,
          checksum: SOURCE_CHECKSUM, mimetype: "application/pdf",
          description: "Presentail internal idempotency marker [PRESENTAIL-INV:7:44]",
        });
        return new Response("[7010]", { status: 200 });
      }
      if (url.endsWith("/ir.attachment/write")) return new Response("true", { status: 200 });
      if (url.endsWith("/account.move/write")) {
        const body = JSON.parse(String(options.body ?? "{}")) as { vals?: Record<string, unknown> };
        if (body.vals && Object.hasOwn(body.vals, "message_main_attachment_id")) {
          currentMainAttachmentId = Number(body.vals.message_main_attachment_id) || null;
        }
        return new Response("true", { status: 200 });
      }
      if (url.endsWith("/res.partner/search_read")) {
        return new Response(JSON.stringify([
          { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123" },
        ]), { status: 200 });
      }
      if (url.endsWith("/account.tax/search_read")) {
        return new Response(JSON.stringify([
          { id: 19, name: "Purchase VAT 11%", amount: 11, amount_type: "percent", price_include: false },
          { id: 20, name: "Purchase VAT 11% EXP", amount: 11, amount_type: "percent", price_include: false },
        ]), { status: 200 });
      }
      if (url.endsWith("/res.currency/search_read")) {
        return new Response(JSON.stringify([{ id: 1, name: "USD" }]), { status: 200 });
      }
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 14, name: "Purchases", code: "BILL", company_id: [2, "Presentail SAL"], currency_id: false, sequence: 6,
        }]), { status: 200 });
      }
      if (url.endsWith("/product.product/search_read")) {
        return new Response(JSON.stringify([{
          id: 501, name: "Bouquet", default_code: "P-1", company_id: [2, "Presentail SAL"],
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move.line/search_read")) {
        const body = JSON.parse(String(options.body));
        if (body.domain.some((part: unknown[]) => part[0] === "move_id")) {
          return new Response(JSON.stringify([{
            id: 9001,
            product_id: [501, "Bouquet"],
            account_id: [383, "Goods & Services"],
            tax_ids: [19],
            quantity: 1,
            price_unit: 100,
          }]), { status: 200 });
        }
        return new Response(JSON.stringify([{
          id: 700, product_id: [501, "Bouquet"], account_id: [383, "Goods & Services"], tax_ids: [19], parent_state: "posted",
        }]), { status: 200 });
      }
      if (url.endsWith("/account.account/search_read")) {
        return new Response(JSON.stringify([{
          id: 383, code: "601101", name: "Goods & Services Type A", account_type: "expense_direct_cost", company_ids: [2],
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move/create")) {
        const body = JSON.parse(String(options.body));
        expect(body.vals_list[0]).toMatchObject({
          move_type: "in_invoice",
          company_id: 2,
          journal_id: 14,
          partner_id: 301,
          currency_id: 1,
          invoice_date: "2026-09-16",
          ref: "INV-44",
          invoice_line_ids: [[0, 0, {
            name: "Bouquet",
            quantity: 1,
            price_unit: 100,
            product_id: 501,
            account_id: 383,
            tax_ids: [[6, 0, [19]]],
          }]],
          attachment_ids: [[0, 0, {
            name: "Acme Flowers SAL INV-44.pdf",
            type: "binary",
            datas: SOURCE_BYTES.toString("base64"),
            res_model: "account.move",
            mimetype: "application/pdf",
            description: "Presentail internal idempotency marker [PRESENTAIL-INV:7:44]",
          }]],
        });
        const attachmentValues = body.vals_list[0].attachment_ids[0][2];
        attachments.push({
          ...attachmentValues,
          id: 7010,
          res_id: 8801,
          checksum: SOURCE_CHECKSUM,
        });
        moveCreated = true;
        return new Response("[8801]", { status: 200 });
      }
      if (url.endsWith("/account.move/action_post")) {
        moveState = "posted";
        return new Response("true", { status: 200 });
      }
      if (url.endsWith("/account.move/search_read")) {
        moveSearchCount++;
        if (!moveCreated) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify([{
          id: 8801,
          name: "BILL/2026/00801",
          state: moveState,
          move_type: "in_invoice",
          company_id: [2, "Presentail SAL"],
          journal_id: [14, "Purchases"],
          partner_id: [301, "Acme Flowers SAL"],
          currency_id: [1, "USD"],
           invoice_date: "2026-09-16T00:00:00.000Z",
          ref: "INV-44",
          message_main_attachment_id: currentMainAttachmentId ? [currentMainAttachmentId, "Invoice scan"] : false,
          invoice_line_ids: [9001],
          amount_untaxed: 100,
          amount_tax: 11,
          amount_total: 111,
        }]), { status: 200 });
      }
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 44, {
      vendor_name: "Acme Flower SAL",
      vendor_tax_number: "LB123",
      vendor_address: "Beirut",
      invoice_number: "INV-44",
      invoice_date: "2026-09-16",
      due_date: null,
      currency: "USD",
      subtotal: 100,
      discount: null,
      tax_amount: 11,
      total_amount: 111,
      line_items: [{ description: "Bouquet", quantity: 1, unit_price: 100, total: 100, tax_rate: 0.11, product_code: "P-1" }],
      confidence: 1,
      raw_ai_json: {},
      company_validation_status: "matched",
      company_validation_notes: null,
      billing_country: "LB",
    }, "/objects/invoice-44.pdf");

    expect(result).toEqual(expect.objectContaining({ success: true, provider_bill_id: "8801" }));
    expect(result).toEqual(expect.objectContaining({
      success: true,
      provider_bill_id: "8801",
      provider_bill_status: "posted",
      provider_supplier_id: 301,
      provider_supplier_name: "Acme Flowers SAL",
      provider_supplier_tax_number: "LB123",
    }));
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
    expect(mockSafeOdooFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/ai_invoice_import/"),
      expect.anything(),
    );
  });

  it("does not create a bill when the supplier name is not close", async () => {
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/ir.attachment/search_read") || url.endsWith("/account.move/search_read")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/res.partner/search_read")) {
        return new Response(JSON.stringify([{ id: 301, name: "Completely Different Supplier", display_name: null }]), { status: 200 });
      }
      if (url.endsWith("/account.tax/search_read")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/res.currency/search_read")) {
        return new Response(JSON.stringify([{ id: 1, name: "USD" }]), { status: 200 });
      }
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{
          id: 14, name: "Purchases", code: "BILL", company_id: [2, "Presentail SAL"],
        }]), { status: 200 });
      }
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 45, {
      vendor_name: "Acme Flower",
      vendor_tax_number: null,
      vendor_address: null,
      invoice_number: "INV-45",
      invoice_date: "2026-09-16",
      due_date: null,
      currency: "USD",
      subtotal: 100,
      discount: null,
      tax_amount: null,
      total_amount: 100,
      line_items: [{ description: "Bouquet", quantity: 1, unit_price: 100, total: 100 }],
      confidence: 1,
      raw_ai_json: {},
      company_validation_status: "unknown",
      company_validation_notes: null,
      billing_country: "LB",
    }, "/objects/invoice-45.pdf");

    expect(result).toEqual({
      success: false,
      error: 'Odoo supplier/tax lookup failed: No close Odoo supplier match found for "Acme Flower"',
    });
    expect(mockSafeOdooFetch).not.toHaveBeenCalledWith(
      "https://odoo.example.com/json/2/account.move/create",
      expect.anything(),
    );
  });

  it("creates and links a reviewed supplier when the approved sync has no trustworthy Odoo match", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("WITH lock_key")
        ? { rows: [{ supplier_id: 77 }] }
        : { rows: [] },
    );
    installAccountCodedInvoiceMock({
      noPartners: true,
      countryId: 1,
      partnerId: 302,
      createdPartner: {
        id: 302,
        name: "New Flowers SAL",
        display_name: "New Flowers SAL",
        vat: "LB999",
        commercial_partner_id: [302, "New Flowers SAL"],
      },
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 46, {
      ...ACCOUNT_CODED_INVOICE,
      vendor_name: "New Flowers SAL",
      vendor_tax_number: "LB999",
    }, "/objects/invoice-46.pdf", { workspaceOwnerId: "workspace-1" });

    expect(result).toMatchObject({
      success: true,
      provider_bill_id: "8899",
      provider_supplier_id: 302,
      provider_supplier_name: "New Flowers SAL",
      provider_supplier_tax_number: "LB999",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/res.partner/create"))).toHaveLength(1);
    const billCreate = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(billCreate?.[1]?.body)).vals_list[0].partner_id).toBe(302);
    expect(mockDbQuery).toHaveBeenCalledWith(expect.stringContaining("WITH lock_key"), expect.any(Array));
  });

  it.each([
    ["header total mismatch", { subtotal: 100, tax_amount: 11, total_amount: 999 }],
    ["line subtotal mismatch", { subtotal: 175, tax_amount: 11, total_amount: 186 }],
  ])("accepts approved OS lines despite %s and remains idempotent", async (_label, amounts) => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({ initialEmptySearches: 2 });
    const connector = new OdooAccountingConnector(ENTITY);
    const data = { ...ACCOUNT_CODED_INVOICE, ...amounts };

    const first = await connector.createDraftVendorBill(
      7, 99, data, "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );
    const second = await connector.createDraftVendorBill(
      7, 99, data, "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );

    expect(first, JSON.stringify(first)).toMatchObject({ success: true, provider_bill_id: "8899" });
    expect(second).toMatchObject({ success: true, provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
  });

  it("creates a fresh approved-identity supplier instead of guessing between ambiguous Odoo candidates", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("WITH lock_key")
        ? { rows: [{ supplier_id: 78 }] }
        : { rows: [] },
    );
    installAccountCodedInvoiceMock({
      partners: [
        { id: 301, name: "Acme Flower Trading", display_name: "Acme Flower Trading", vat: null },
        { id: 303, name: "Acme Flowers Lebanon", display_name: "Acme Flowers Lebanon", vat: null },
      ],
      countryId: 1,
      partnerId: 302,
      createdPartner: {
        id: 302,
        name: "Acme Flowers SAL",
        display_name: "Acme Flowers SAL",
        vat: "LB123",
        commercial_partner_id: [302, "Acme Flowers SAL"],
      },
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 47, {
      ...ACCOUNT_CODED_INVOICE,
      vendor_name: "Acme Flowers SAL",
      vendor_tax_number: "LB123",
    }, "/objects/invoice-47.pdf", { workspaceOwnerId: "workspace-1" });

    expect(result).toMatchObject({
      success: true,
      provider_supplier_id: 302,
      provider_supplier_name: "Acme Flowers SAL",
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/res.partner/create"))).toHaveLength(1);
    const billCreate = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(billCreate?.[1]?.body)).vals_list[0].partner_id).toBe(302);
  });

  it("fails closed instead of creating another supplier when multiple exact suppliers already exist", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [] });
    installAccountCodedInvoiceMock({
      partners: [
        { id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123" },
        { id: 303, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123" },
      ],
      countryId: 1,
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 48, {
      ...ACCOUNT_CODED_INVOICE,
      vendor_name: "Acme Flowers SAL",
      vendor_tax_number: "LB123",
    }, "/objects/invoice-48.pdf", { workspaceOwnerId: "workspace-1" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Multiple exact Odoo suppliers"),
    });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/res.partner/create"))).toHaveLength(0);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(0);
  });

  it("returns an account-specific review failure when no verified expense mapping exists", async () => {
    mockSafeOdooFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/ir.attachment/search_read") || url.endsWith("/account.move/search_read")) {
        return new Response("[]", { status: 200 });
      }
      if (url.endsWith("/res.partner/search_read")) {
        return new Response(JSON.stringify([{ id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL", vat: "LB123" }]), { status: 200 });
      }
      if (url.endsWith("/account.tax/search_read")) {
        return new Response(JSON.stringify([{ id: 19, name: "Purchase VAT 0%", amount: 0, amount_type: "percent", price_include: false }]), { status: 200 });
      }
      if (url.endsWith("/res.currency/search_read")) return new Response(JSON.stringify([{ id: 1, name: "USD" }]), { status: 200 });
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{ id: 14, name: "Purchases", code: "BILL", company_id: [2, "Presentail SAL"] }]), { status: 200 });
      }
      if (url.endsWith("/product.product/search_read")) {
        return new Response(JSON.stringify([{ id: 501, name: "Gypsophilla", default_code: "C0258", company_id: [2, "Presentail SAL"] }]), { status: 200 });
      }
      if (url.endsWith("/account.move.line/search_read")) return new Response("[]", { status: 200 });
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 258, {
      vendor_name: "Acme Flowers SAL",
      vendor_tax_number: "LB123",
      vendor_address: "Beirut",
      invoice_number: "INV-258",
      invoice_date: "2026-09-16",
      due_date: null,
      currency: "USD",
      subtotal: 100,
      discount: null,
      tax_amount: 0,
      total_amount: 100,
      line_items: [{ description: "Gypsophilla", quantity: 1, unit_price: 100, total: 100, tax_rate: 0, product_code: "C0258" }],
      confidence: 1,
      raw_ai_json: {},
      company_validation_status: "matched",
      company_validation_notes: null,
      billing_country: "LB",
    }, "/objects/invoice-258.pdf");

    expect(result).toEqual({
      success: false,
      reason_code: "account_resolution_required",
      error: expect.stringContaining("Odoo expense-account resolution failed"),
    });
    expect(mockSafeOdooFetch).not.toHaveBeenCalledWith(
      "https://odoo.example.com/json/2/account.move/create",
      expect.anything(),
    );
  });

  it("uses the entity default expense account for approved lines without account codes and verifies idempotently", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({ initialEmptySearches: 2 });
    const connector = new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 383,
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };

    const first = await connector.createDraftVendorBill(
      7,
      99,
      data,
      "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );
    const second = await connector.createDraftVendorBill(
      7,
      99,
      data,
      "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );

    expect(first).toMatchObject({ success: true, provider_bill_id: "8899" });
    expect(second).toMatchObject({ success: true, provider_bill_id: "8899" });
    const defaultAccountLookup = mockSafeOdooFetch.mock.calls.find(([url, request]) => {
      if (!String(url).endsWith("/account.account/search_read")) return false;
      const domain = JSON.parse(String((request as RequestInit)?.body ?? "{}")).domain as unknown[][];
      return domain.some((part) => part[0] === "id" && part[1] === "=" && part[2] === 383);
    });
    expect(defaultAccountLookup).toBeDefined();
    const billCreate = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(billCreate?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(383);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
  });

  it("ignores a stale explicit account code and falls through to the entity default", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({
      initialEmptySearches: 2,
      accounts: [
        { id: 383, code: "601101", name: "Entity default", account_type: "expense_direct_cost", company_ids: [2] },
        { id: 410, code: "413418", name: "Legacy A", account_type: "expense_direct_cost", company_ids: [2] },
        { id: 411, code: "413418", name: "Legacy B", account_type: "expense_direct_cost", company_ids: [2] },
      ],
    });
    const connector = new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 383,
    });

    const result = await connector.createDraftVendorBill(
      7,
      99,
      {
        ...ACCOUNT_CODED_INVOICE,
        line_items: ACCOUNT_CODED_INVOICE.line_items.map((line) => ({
          ...line,
          account_code: "413418",
        })),
      },
      "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const billCreate = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(billCreate?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(383);
  });

  it("repairs an approved draft from OS lines, verifies derived coding, and posts without creating a second bill", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({
      initialEmptySearches: 0,
      moveState: "draft",
      actualAccountId: 390,
      accountLookupId: 390,
      actualTaxIds: [],
      repairUpdatesLine: true,
    });
    const connector = new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 383,
    });

    const result = await connector.createDraftVendorBill(
      7,
      99,
      { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899" },
      "/objects/invoice-99.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      provider_bill_id: "8899",
      provider_bill_status: "posted",
      outcome: "repaired_existing",
    });
    const writes = mockSafeOdooFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/account.move/write"))
      .map(([, request]) => JSON.parse(String(request?.body)).vals);
    expect(writes).toHaveLength(2);
    expect(writes.find((values) => Object.hasOwn(values, "message_main_attachment_id")))
      .toEqual({ message_main_attachment_id: 7001 });
    expect(writes.find((values) => Object.hasOwn(values, "invoice_line_ids")))
      .not.toHaveProperty("message_main_attachment_id");
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/action_post"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(0);
  });

  it("syncs the approved minimum commercial contract with provider-derived accounting fields", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({ actualTaxIds: [], initialEmptySearches: 2 });
    const connector = new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 383,
    });

    const result = await connector.createDraftVendorBill(
      7,
      99,
      {
        vendor_name: "Acme Flowers SAL",
        supplier_id: 77,
        vendor_tax_number: null,
        vendor_address: null,
        invoice_number: "INV-NEGATIVE",
        invoice_date: "2026-09-16",
        due_date: null,
        currency: "USD",
        subtotal: null,
        discount: null,
        tax_amount: null,
        total_amount: 100,
        line_items: [{ description: "Approved flowers", quantity: 1, unit_price: 100, total: 100 }],
        confidence: 0,
        raw_ai_json: {},
        company_validation_status: "unknown",
        company_validation_notes: null,
        billing_country: "LB",
      },
      "/objects/invoice-198.pdf",
      { workspaceOwnerId: "workspace-1", approvedValuesAuthoritative: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    const values = JSON.parse(String(createCall?.[1]?.body)).vals_list[0];
    expect(values).not.toHaveProperty("invoice_date_due");
    expect(values).not.toHaveProperty("amount_total");
    expect(values.invoice_line_ids[0][2]).toMatchObject({
      name: "Approved flowers",
      quantity: 1,
      price_unit: 100,
      account_id: 383,
      tax_ids: [[6, 0, []]],
    });
    expect(values.invoice_line_ids[0][2]).not.toHaveProperty("product_id");
    expect(values.attachment_ids).toHaveLength(1);
  });

  it("reuses verified recurring-supplier history when the approved line has no account code", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("WITH lock_key") ? { rows: [{ supplier_id: 77 }] } : { rows: [] });
    installAccountCodedInvoiceMock({});
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      299,
      data,
      "/objects/invoice-299.pdf",
      { approvedValuesAuthoritative: true, workspaceOwnerId: "workspace-1" },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(383);
    const historyCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move.line/search_read"));
    const historyDomain = JSON.parse(String(historyCall?.[1]?.body)).domain as unknown[][];
    expect(historyDomain).toEqual(expect.arrayContaining([
      ["move_id.partner_id", "in", [301]],
      ["company_id", "=", 2],
      ["move_id.move_type", "=", "in_invoice"],
      ["parent_state", "=", "posted"],
    ]));
    const localHistoryCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("FROM suppliers s") && String(sql).includes("entity_id=$2"));
    expect(localHistoryCall).toBeDefined();
    expect(localHistoryCall?.[1]).toEqual(["workspace-1", 7]);
    const localHistorySql = String(localHistoryCall?.[0]);
    expect(localHistorySql.indexOf("AND ($2::integer IS NULL OR i.entity_id=$2)")).toBeLessThan(
      localHistorySql.indexOf("WHERE s.workspace_owner_id=$1"),
    );
  });

  it("uses posted history from child contacts for a selected commercial partner", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("WITH lock_key") ? { rows: [{ supplier_id: 77 }] } : { rows: [] });
    installAccountCodedInvoiceMock({
      partnerId: 301,
      partners: [
        {
          id: 301,
          name: "Acme Flowers SAL",
          display_name: "Acme Flowers SAL",
          vat: "LB123",
          commercial_partner_id: [301, "Acme Flowers SAL"],
          company_id: [2, "Presentail SAL"],
        },
        {
          id: 302,
          name: "Acme Flowers Beirut",
          display_name: "Acme Flowers Beirut",
          vat: "LB123",
          supplier_rank: 0,
          parent_id: [301, "Acme Flowers SAL"],
          commercial_partner_id: [301, "Acme Flowers SAL"],
          company_id: [2, "Presentail SAL"],
        },
      ],
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      odoo_partner_id: 301,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      300,
      data,
      "/objects/invoice-300.pdf",
      { approvedValuesAuthoritative: true, workspaceOwnerId: "workspace-1" },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const familyCall = mockSafeOdooFetch.mock.calls.find(([url, request]) => {
      if (!String(url).endsWith("/res.partner/search_read")) return false;
      const body = JSON.parse(String((request as RequestInit)?.body ?? "{}")) as { domain?: unknown[][] };
      return body.domain?.some((part) => part[0] === "commercial_partner_id");
    });
    expect(familyCall).toBeDefined();
    const familyDomain = JSON.parse(String((familyCall?.[1] as RequestInit)?.body)).domain as unknown[][];
    expect(familyDomain).toEqual(expect.arrayContaining([
      ["commercial_partner_id", "=", 301],
      ["parent_id", "=", 301],
      ["company_id", "=", 2],
    ]));
    const historyCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move.line/search_read"));
    const historyDomain = JSON.parse(String(historyCall?.[1]?.body)).domain as unknown[][];
    expect(historyDomain).toEqual(expect.arrayContaining([
      ["move_id.partner_id", "in", [301, 302]],
    ]));
  });

  it("falls back to the entity default when recurring supplier history is ambiguous", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({ actualAccountId: 390 });
    const baseImplementation = mockSafeOdooFetch.getMockImplementation()!;
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move.line/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        if (body.domain?.some((part) => part[0] === "move_id.partner_id")) {
          return new Response(JSON.stringify([
            { id: 31, product_id: false, account_id: [383, "Expense A"], parent_state: "posted" },
            { id: 32, product_id: false, account_id: [384, "Expense B"], parent_state: "posted" },
          ]), { status: 200 });
        }
      }
      if (url.endsWith("/account.account/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        const exactId = Number(body.domain?.find((part) => part[0] === "id" && part[1] === "=")?.[2] ?? 0);
        const accounts = [
          { id: 383, code: "601101", name: "Expense A", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 384, code: "601102", name: "Expense B", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 390, code: "601199", name: "Entity default", account_type: "expense_direct_cost", company_ids: [2] },
        ];
        return new Response(JSON.stringify(exactId ? accounts.filter((account) => account.id === exactId) : accounts), { status: 200 });
      }
      return baseImplementation(url, request);
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };

    const result = await new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 390,
    }).createDraftVendorBill(7, 301, data, "/objects/invoice-301.pdf", { approvedValuesAuthoritative: true });

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(390);
  });

  it("ignores invalid supplier-history accounts and uses the unique valid entity-history account", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({ actualAccountId: 383 });
    const baseImplementation = mockSafeOdooFetch.getMockImplementation()!;
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move.line/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        if (body.domain?.some((part) => part[0] === "move_id.partner_id")) {
          return new Response(JSON.stringify([
            { id: 31, product_id: false, account_id: [999, "Inactive legacy account"], parent_state: "posted" },
          ]), { status: 200 });
        }
        if (body.domain?.some((part) => part[0] === "move_id.move_type")) {
          return new Response(JSON.stringify([
            { id: 31, product_id: false, account_id: [999, "Inactive legacy account"], parent_state: "posted" },
            { id: 32, product_id: false, account_id: [383, "Valid entity expense"], parent_state: "posted" },
          ]), { status: 200 });
        }
      }
      return baseImplementation(url, request);
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      303,
      data,
      "/objects/invoice-303.pdf",
      { approvedValuesAuthoritative: true },
    );

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(383);
  });

  it("paginates recurring supplier history and refuses conflicting accounts", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    installAccountCodedInvoiceMock({ actualAccountId: 390 });
    const baseImplementation = mockSafeOdooFetch.getMockImplementation()!;
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move.line/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        const supplierQuery = body.domain?.some((part) => part[0] === "move_id.partner_id");
        const afterId = Number(body.domain?.find((part) => part[0] === "id" && part[1] === ">")?.[2] ?? 0);
        if (supplierQuery) {
          if (afterId) return new Response(JSON.stringify([{ id: 1001, product_id: false, account_id: [384, "Expense B"], parent_state: "posted" }]), { status: 200 });
          return new Response(JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({
            id: index + 1, product_id: false, account_id: [383, "Expense A"], parent_state: "posted",
          }))), { status: 200 });
        }
        if (body.domain?.some((part) => part[0] === "move_id.move_type")) {
          return new Response(JSON.stringify([
            { id: 2001, product_id: false, account_id: [383, "Expense A"], parent_state: "posted" },
            { id: 2002, product_id: false, account_id: [384, "Expense B"], parent_state: "posted" },
          ]), { status: 200 });
        }
      }
      if (url.endsWith("/account.account/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        const exactId = Number(body.domain?.find((part) => part[0] === "id" && part[1] === "=")?.[2] ?? 0);
        const accounts = [
          { id: 383, code: "601101", name: "Expense A", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 384, code: "601102", name: "Expense B", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 390, code: "601199", name: "Entity default", account_type: "expense_direct_cost", company_ids: [2] },
        ];
        return new Response(JSON.stringify(exactId ? accounts.filter((account) => account.id === exactId) : accounts), { status: 200 });
      }
      return baseImplementation(url, request);
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: ACCOUNT_CODED_INVOICE.line_items.map(({ account_code: _accountCode, ...line }) => line),
    };
    const result = await new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 390,
    }).createDraftVendorBill(7, 302, data, "/objects/invoice-302.pdf", { approvedValuesAuthoritative: true });

    expect(result, JSON.stringify(result)).toMatchObject({ success: true, provider_bill_id: "8899" });
    const supplierHistoryCalls = mockSafeOdooFetch.mock.calls.filter(([url, request]) => {
      if (!String(url).endsWith("/account.move.line/search_read")) return false;
      const domain = JSON.parse(String((request as RequestInit)?.body ?? "{}")).domain as unknown[][];
      return domain.some((part) => part[0] === "move_id.partner_id");
    });
    expect(supplierHistoryCalls).toHaveLength(2);
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(390);
  });

  it("falls through from ambiguous product history to the entity default", async () => {
    vi.stubEnv("ODOO_API_KEY", "secret-token");
    mockDbQuery.mockResolvedValue({ rows: [{ supplier_id: 77 }] });
    installAccountCodedInvoiceMock({
      actualAccountId: 390,
      products: [{ id: 501, name: "Bouquet", default_code: "P-1", company_id: [2, "Presentail SAL"] }],
    });
    const baseImplementation = mockSafeOdooFetch.getMockImplementation()!;
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move.line/search_read")) {
        const body = JSON.parse(String(request?.body ?? "{}")) as { domain?: unknown[][] };
        const isProductHistory = body.domain?.some((part) => part[0] === "product_id");
        if (isProductHistory) {
          return new Response(JSON.stringify([
            { id: 1, product_id: [501, "Bouquet"], account_id: [383, "Expense A"], tax_ids: [19], parent_state: "posted" },
            { id: 2, product_id: [501, "Bouquet"], account_id: [384, "Expense B"], tax_ids: [19], parent_state: "posted" },
          ]), { status: 200 });
        }
        const isSupplierHistory = body.domain?.some((part) => part[0] === "move_id.partner_id");
        if (isSupplierHistory) {
          return new Response(JSON.stringify([
            { id: 3, product_id: false, account_id: [383, "Expense A"], parent_state: "posted" },
            { id: 4, product_id: false, account_id: [384, "Expense B"], parent_state: "posted" },
          ]), { status: 200 });
        }
      }
      if (url.endsWith("/account.account/search_read")) {
        return new Response(JSON.stringify([
          { id: 383, code: "601101", name: "Expense A", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 384, code: "601102", name: "Expense B", account_type: "expense_direct_cost", company_ids: [2] },
          { id: 390, code: "601199", name: "Default", account_type: "expense_direct_cost", company_ids: [2] },
        ]), { status: 200 });
      }
      return baseImplementation(url, request);
    });
    const data = {
      ...ACCOUNT_CODED_INVOICE,
      line_items: [{ ...ACCOUNT_CODED_INVOICE.line_items[0], account_code: undefined, product_code: "P-1" }],
    };
    const result = await new OdooAccountingConnector({
      ...ENTITY,
      odoo_default_expense_account_id: 390,
    }).createDraftVendorBill(7, 99, data, "/objects/invoice-99.pdf", { workspaceOwnerId: "workspace-1" });
    expect(result).toMatchObject({ success: true });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].account_id).toBe(390);
  });

  it("recovers a committed JSON-2 bill by marker after a lost create response", async () => {
    vi.stubEnv("ODOO_API_KEY", "json2-secret");
    let markerSearchCount = 0;
    let visibleRef = "INV-46";
    let moveCreated = false;
    let moveState = "draft";
    let mainAttachmentId: number | null = null;
    const attachments: Array<Record<string, unknown>> = [];
    mockSafeOdooFetch.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/ir.attachment/search_read")) return new Response(JSON.stringify(attachments), { status: 200 });
      if (url.endsWith("/ir.attachment/create")) {
        attachments.push({
          id: 7011, name: "INV-46", res_model: "account.move", res_id: 8802,
          checksum: SOURCE_CHECKSUM, mimetype: "application/pdf",
          description: "Presentail internal idempotency marker [PRESENTAIL-INV:7:46]",
        });
        return new Response("[7011]", { status: 200 });
      }
      if (url.endsWith("/ir.attachment/write")) {
        const body = JSON.parse(String(options.body ?? "{}")) as { ids?: number[]; vals?: Record<string, unknown> };
        for (const attachment of attachments) {
          if (body.ids?.includes(Number(attachment.id))) Object.assign(attachment, body.vals);
        }
        return new Response("true", { status: 200 });
      }
      if (url.endsWith("/account.move/write")) {
        const body = JSON.parse(String(options.body ?? "{}")) as { vals?: Record<string, unknown> };
        if (body.vals && Object.hasOwn(body.vals, "message_main_attachment_id")) {
          mainAttachmentId = Number(body.vals.message_main_attachment_id) || null;
        }
        visibleRef = "INV-46";
        return new Response("true", { status: 200 });
      }
      if (url.endsWith("/res.partner/search_read")) {
        return new Response(JSON.stringify([{ id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL" }]), { status: 200 });
      }
      if (url.endsWith("/account.tax/search_read")) {
        return new Response(JSON.stringify([{ id: 19, name: "VAT 11%", amount: 11, amount_type: "percent", price_include: false }]), { status: 200 });
      }
      if (url.endsWith("/res.currency/search_read")) {
        return new Response(JSON.stringify([{ id: 1, name: "USD" }]), { status: 200 });
      }
      if (url.endsWith("/account.journal/search_read")) {
        return new Response(JSON.stringify([{ id: 14, name: "Purchases", company_id: [2, "Presentail SAL"] }]), { status: 200 });
      }
      if (url.endsWith("/account.account/search_read")) {
        return new Response(JSON.stringify([{
          id: 383, code: "601101", name: "Goods & Services Type A", account_type: "expense_direct_cost", company_ids: [2],
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move.line/search_read")) {
        return new Response(JSON.stringify([{
          id: 9002,
          product_id: false,
          account_id: [383, "Goods & Services"],
          tax_ids: [19],
          quantity: 1,
          price_unit: 100,
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move/create")) {
        const body = JSON.parse(String(options.body));
        const attachmentValues = body.vals_list[0].attachment_ids[0][2];
        attachments.push({
          ...attachmentValues,
          id: 7011,
          res_model: "account.move",
          res_id: 8802,
          checksum: SOURCE_CHECKSUM,
        });
        moveCreated = true;
        throw new Error("connection closed after commit");
      }
      if (url.endsWith("/account.move/action_post")) {
        moveState = "posted";
        return new Response("true", { status: 200 });
      }
      if (url.endsWith("/account.move/search_read")) {
        markerSearchCount++;
        if (!moveCreated) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify([{
          id: 8802,
          name: "BILL/2026/00802",
          state: moveState,
          move_type: "in_invoice",
          company_id: [2, "Presentail SAL"],
          journal_id: [14, "Purchases"],
          partner_id: [301, "Acme Flowers SAL"],
          currency_id: [1, "USD"],
           invoice_date: "2026-09-16T00:00:00.000Z",
          ref: visibleRef,
          message_main_attachment_id: mainAttachmentId ? [mainAttachmentId, "Invoice scan"] : false,
          invoice_line_ids: [9002],
          amount_untaxed: 100,
          amount_tax: 11,
          amount_total: 111,
        }]), { status: 200 });
      }
      throw new Error(`Unexpected Odoo call: ${url}`);
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 46, {
      vendor_name: "Acme Flower SAL",
      vendor_tax_number: null,
      vendor_address: null,
      invoice_number: "INV-46",
      invoice_date: "2026-09-16",
      due_date: null,
      currency: "USD",
      subtotal: 100,
      discount: null,
      tax_amount: 11,
      total_amount: 111,
      line_items: [{
        description: "Bouquet",
        quantity: 1,
        unit_price: 100,
        total: 100,
        tax_rate: 0.11,
        account_code: "601101",
      }],
      confidence: 1,
      raw_ai_json: {},
      company_validation_status: "matched",
      company_validation_notes: null,
      billing_country: "LB",
    }, "/objects/invoice-46.pdf");

    expect(result).toMatchObject({
      success: true,
      provider_bill_id: "8802",
      provider_bill_status: "posted",
    });
    expect(markerSearchCount).toBeGreaterThanOrEqual(4);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/ir.attachment/create"))).toHaveLength(0);
    const moveWrites = mockSafeOdooFetch.mock.calls
      .filter(([url]) => String(url).endsWith("/account.move/write"));
    expect(moveWrites).toHaveLength(1);
    expect(JSON.parse(String(moveWrites[0][1]?.body)).vals).toEqual({ message_main_attachment_id: 7011 });
  });

  it("reuses the historical account-compatible tax when multiple purchase taxes match", async () => {
    installAccountCodedInvoiceMock({
      taxes: [
        { id: 19, name: "VAT 11% A", amount: 11, amount_type: "percent", price_include: false },
        { id: 20, name: "VAT 11% B", amount: 11, amount_type: "percent", price_include: false },
      ],
    });
    const result = await new OdooAccountingConnector(ENTITY)
      .createDraftVendorBill(7, 99, ACCOUNT_CODED_INVOICE, "/objects/invoice-99.pdf");
    expect(result).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(createCall).toBeDefined();
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2].tax_ids).toEqual([[6, 0, [19]]]);
  });

  it("does not report success when read-back line coding differs", async () => {
    installAccountCodedInvoiceMock({ actualAccountId: 999 });
    const result = await new OdooAccountingConnector(ENTITY)
      .createDraftVendorBill(7, 99, ACCOUNT_CODED_INVOICE, "/objects/invoice-99.pdf");
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("invoice line coding");
  });

  it("accepts Odoo-supported quantity rounding with canonical account and tax read-back", async () => {
    installAccountCodedInvoiceMock({ actualQuantity: 22.35 });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      {
        ...ACCOUNT_CODED_INVOICE,
        line_items: [{ ...ACCOUNT_CODED_INVOICE.line_items[0], quantity: 22.349 }],
      },
      "/objects/invoice-99.pdf",
    );

    expect(result).toMatchObject({ success: true, provider_bill_id: "8899" });
    expect(mockSafeOdooFetch.mock.calls.filter(([url]) => String(url).endsWith("/account.move/create"))).toHaveLength(1);
  });

  it("rejects a fuzzy supplier name when the supplied tax number contradicts Odoo", async () => {
    installAccountCodedInvoiceMock({});
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 99, {
      ...ACCOUNT_CODED_INVOICE,
      vendor_name: "Acme Flower S.A.L.",
      vendor_tax_number: "DIFFERENT-TAX-ID",
    }, "/objects/invoice-99.pdf");
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("No close Odoo supplier match");
  });

  it("reuses the saved OS/Odoo supplier mapping for a descriptive Raidan name", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{
        supplier_id: 77,
        supplier_name: "Raidan Floriculture SARL",
        supplier_display_name: null,
        supplier_tax_number: null,
        odoo_partner_id: 301,
        historical_vendor_name: "Raidan - Flowers and Plants Wholesaler",
      }],
    });
    installAccountCodedInvoiceMock({
      partner: {
        id: 301,
        name: "Raidan Floriculture SARL",
        display_name: "Raidan Floriculture SARL",
        vat: null,
      },
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 99, {
      ...ACCOUNT_CODED_INVOICE,
      vendor_name: "Raidan - Flowers and Plants Wholesaler",
      supplier_id: 77,
    }, "/objects/invoice-99.pdf", { workspaceOwnerId: "workspace-1" });

    expect(result).toMatchObject({
      success: true,
      provider_supplier_id: 301,
      provider_supplier_name: "Raidan Floriculture SARL",
    });
  });

  it("omits an ambiguous product code instead of selecting an arbitrary product", async () => {
    installAccountCodedInvoiceMock({
      products: [
        { id: 501, name: "Bouquet A", default_code: "P-1", company_id: [2, "Presentail SAL"] },
        { id: 502, name: "Bouquet B", default_code: "P-1", company_id: [2, "Presentail SAL"] },
      ],
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(7, 99, {
      ...ACCOUNT_CODED_INVOICE,
      line_items: [{ ...ACCOUNT_CODED_INVOICE.line_items[0], product_code: "P-1" }],
    }, "/objects/invoice-99.pdf");

    expect(result).toMatchObject({ success: true, provider_bill_id: "8899" });
    const createCall = mockSafeOdooFetch.mock.calls.find(([url]) => String(url).endsWith("/account.move/create"));
    expect(JSON.parse(String(createCall?.[1]?.body)).vals_list[0].invoice_line_ids[0][2]).not.toHaveProperty("product_id");
  });

  it("ignores Odoo display and note lines while retaining canonical supplier verification", async () => {
    installAccountCodedInvoiceMock({
      withAttachment: true,
      attachmentName: "Acme Flowers Outlet INV-NEGATIVE.pdf",
      initialEmptySearches: 0,
      includeDisplayLine: true,
      partner: {
        id: 301,
        name: "Acme Flowers Outlet",
        display_name: "Acme Flowers Outlet",
        vat: "LB123",
        parent_id: [302, "Acme Flowers SAL"],
        commercial_partner_id: [302, "Acme Flowers SAL"],
      },
      canonicalPartner: {
        id: 302,
        name: "Acme Flowers SAL",
        display_name: "Acme Flowers SAL",
        vat: "LB123",
        commercial_partner_id: [302, "Acme Flowers SAL"],
      },
    });

    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7,
      99,
      ACCOUNT_CODED_INVOICE,
      "/objects/invoice-99.pdf",
      { readOnly: true },
    );

    expect(result).toMatchObject({
      success: true,
      provider_bill_id: "8899",
      outcome: "recovered",
    });
  });

  it("rejects a posted mismatched bill without attempting any write", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0 });
    const callsBefore = mockSafeOdooFetch.mock.calls.length;
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move/search_read")) {
        return new Response(JSON.stringify([{
          id: 8899, state: "posted", move_type: "in_invoice", company_id: [2, "Presentail SAL"],
          journal_id: [14, "Purchases"], partner_id: [301, "Acme Flowers SAL"], currency_id: [1, "USD"],
          ref: "INV-NEGATIVE", invoice_date: "2026-09-16", invoice_line_ids: [9991],
          amount_untaxed: 90, amount_tax: 9, amount_total: 99,
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move.line/search_read")) {
        return new Response(JSON.stringify([{ id: 9991, product_id: false, account_id: [383, "Expense"], tax_ids: [19], quantity: 1, price_unit: 90 }]), { status: 200 });
      }
      if (url.endsWith("/res.partner/search_read")) {
        return new Response('[{"id":301,"name":"Acme Flowers SAL","display_name":"Acme Flowers SAL","vat":"LB123"}]', { status: 200 });
      }
      if (url.endsWith("/account.account/search_read")) return new Response('[{"id":383,"code":"601101","account_type":"expense_direct_cost"}]', { status: 200 });
      if (url.endsWith("/account.tax/search_read")) return new Response('[{"id":19,"name":"VAT","amount":11,"amount_type":"percent","price_include":false}]', { status: 200 });
      if (url.endsWith("/ir.attachment/search_read")) return new Response("[]", { status: 200 });
      if (url.endsWith("/res.currency/search_read")) return new Response('[{"id":1,"name":"USD"}]', { status: 200 });
      if (url.endsWith("/account.journal/search_read")) return new Response('[{"id":14,"name":"Purchases","company_id":[2,"Presentail SAL"]}]', { status: 200 });
      throw new Error(`Unexpected Odoo call: ${url}`);
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7, 99, { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899" }, "/objects/invoice-99.pdf",
    );
    expect(result).toMatchObject({ success: false, provider_bill_id: "8899" });
    expect(result.error).toMatch(/posted.*cannot be modified/i);
    expect(mockSafeOdooFetch.mock.calls.slice(callsBefore).some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });

  it("keeps account-resolution failures reviewable during a draft repair", async () => {
    installAccountCodedInvoiceMock({ initialEmptySearches: 0 });
    const original = mockSafeOdooFetch.getMockImplementation();
    mockSafeOdooFetch.mockImplementation(async (url: string, request?: RequestInit) => {
      if (url.endsWith("/account.move/search_read")) {
        return new Response(JSON.stringify([{
          id: 8899, state: "draft", move_type: "in_invoice", company_id: [2, "Presentail SAL"],
          journal_id: [14, "Purchases"], partner_id: [301, "Acme Flowers SAL"], currency_id: [1, "USD"],
          ref: "INV-NEGATIVE", invoice_date: "2026-09-16", invoice_line_ids: [9991],
          amount_untaxed: 90, amount_tax: 9, amount_total: 99,
        }]), { status: 200 });
      }
      if (url.endsWith("/account.move.line/search_read")) return new Response(JSON.stringify([{ id: 9991, account_id: [999, "Unknown"], tax_ids: [], quantity: 1, price_unit: 90 }]), { status: 200 });
      if (url.endsWith("/account.account/search_read")) return new Response("[]", { status: 200 });
      if (url.endsWith("/account.tax/search_read")) return new Response("[]", { status: 200 });
      if (url.endsWith("/res.partner/search_read")) return new Response('[{"id":301,"name":"Acme Flowers SAL","display_name":"Acme Flowers SAL","vat":"LB123"}]', { status: 200 });
      if (url.endsWith("/res.currency/search_read")) return new Response('[{"id":1,"name":"USD"}]', { status: 200 });
      if (url.endsWith("/account.journal/search_read")) return new Response('[{"id":14,"name":"Purchases","company_id":[2,"Presentail SAL"]}]', { status: 200 });
      return original ? original(url, request) : new Response("[]", { status: 200 });
    });
    const result = await new OdooAccountingConnector(ENTITY).createDraftVendorBill(
      7, 99, { ...ACCOUNT_CODED_INVOICE, provider_bill_id: "8899" }, "/objects/invoice-99.pdf",
    );
    expect(result).toMatchObject({ success: false, reason_code: "account_resolution_required" });
    expect(mockSafeOdooFetch.mock.calls.some(([url]) => String(url).endsWith("/account.move/write"))).toBe(false);
  });
});