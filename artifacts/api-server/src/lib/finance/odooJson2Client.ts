import { normaliseOdooBaseUrl, safeOdooFetch } from "./odooUrl.js";

/**
 * Small, server-only wrapper around Odoo's JSON-2 API.  Bank reconciliation
 * deliberately uses this client instead of the legacy invoice connector.
 * JSON-2 executes each request in its own transaction, so callers should make
 * one create call per statement line.
 */
export type OdooJson2Config = {
  baseUrl: string;
  database: string;
  companyId: number;
  apiKey?: string;
};

export type OdooJournal = {
  id: number;
  name: string;
  code: string;
  type: string;
  company_id: number;
  company_name: string;
  currency_id: number | null;
  currency_name: string | null;
  default_account_id: number | null;
  default_account_name: string | null;
  bank_account_id: number | null;
  bank_account_name: string | null;
};

export type OdooStatementLineState = {
  id: number;
  is_reconciled: boolean;
  move_id: number | null;
  move_line_ids: number[];
  move_line_reconciled: boolean;
  liquidity_move_line_ids: number[];
  unreconciled_liquidity_move_line_ids: number[];
  statement_side_eligible_move_line_ids: number[];
  unreconciled_statement_side_eligible_move_line_ids: number[];
};

export class OdooJson2Error extends Error {
  readonly status?: number;
  readonly cause?: unknown;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = "OdooJson2Error";
    this.status = status;
    this.cause = cause;
  }
}

function redacted(text: string, apiKey: string): string {
  return (apiKey ? text.split(apiKey).join("[redacted]") : text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function relation(value: unknown): { id: number | null; name: string | null } {
  if (Array.isArray(value)) {
    const id = Number(value[0]);
    return {
      id: Number.isFinite(id) ? id : null,
      name: value[1] == null ? null : String(value[1]),
    };
  }
  if (value && typeof value === "object") {
    const row = value as { id?: unknown; name?: unknown };
    const id = Number(row.id);
    return {
      id: Number.isFinite(id) ? id : null,
      name: row.name == null ? null : String(row.name),
    };
  }
  return { id: null, name: null };
}

function idsFromCreateResult(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      if (typeof item === "number") return item;
      if (typeof item === "string" && /^\d+$/.test(item)) return Number(item);
      if (item && typeof item === "object" && "id" in item) return Number((item as { id: unknown }).id);
      return NaN;
    })
    .filter((id) => Number.isInteger(id) && id > 0);
}

export class OdooJson2Client {
  private readonly baseUrl: string;
  private readonly database: string;
  private readonly companyId: number;
  private readonly apiKey: string;

  constructor(config: OdooJson2Config) {
    const base = normaliseOdooBaseUrl(config.baseUrl);
    if (!base.ok) throw new OdooJson2Error(base.error);
    if (!config.database.trim()) throw new OdooJson2Error("Odoo database is required");
    if (!Number.isInteger(config.companyId) || config.companyId <= 0) {
      throw new OdooJson2Error("Odoo company is required");
    }
    this.baseUrl = base.url;
    this.database = config.database.trim();
    this.companyId = config.companyId;
    this.apiKey = config.apiKey ?? process.env.ODOO_API_KEY ?? "";
    if (!this.apiKey) throw new OdooJson2Error("ODOO_API_KEY is not configured");
  }

  get company(): number {
    return this.companyId;
  }

  private context(): Record<string, unknown> {
    return {
      allowed_company_ids: [this.companyId],
      force_company: this.companyId,
    };
  }

  async call<T = unknown>(
    model: string,
    method: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const url = `${this.baseUrl}/json/2/${encodeURIComponent(model)}/${encodeURIComponent(method)}`;
    const body = { ...fields, context: { ...this.context(), ...(fields.context as Record<string, unknown> | undefined) } };
    let response: Response;
    try {
      response = await safeOdooFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${this.apiKey}`,
          "X-Odoo-Database": this.database,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Network error connecting to Odoo";
      throw new OdooJson2Error(redacted(message, this.apiKey), undefined, error);
    }

    const text = await response.text().catch(() => "");
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const detail = payload && typeof payload === "object"
        ? String((payload as { message?: unknown; error?: unknown }).message ??
            (payload as { error?: unknown }).error ?? "")
        : text;
      const suffix = redacted(detail, this.apiKey);
      throw new OdooJson2Error(
        `Odoo JSON-2 request failed (HTTP ${response.status})${suffix ? `: ${suffix}` : ""}`,
        response.status,
      );
    }
    if (payload && typeof payload === "object" && "error" in payload &&
        (payload as { error?: unknown }).error) {
      const error = (payload as { error?: unknown }).error;
      throw new OdooJson2Error(redacted(typeof error === "string" ? error : JSON.stringify(error), this.apiKey), response.status);
    }
    return payload as T;
  }

  async searchRead<T extends Record<string, unknown>>(
    model: string,
    domain: unknown[][],
    fields: string[],
    limit = 1000,
    order?: string,
  ): Promise<T[]> {
    const result = await this.call<unknown>(model, "search_read", {
      domain,
      fields,
      limit,
      ...(order ? { order } : {}),
    });
    return Array.isArray(result) ? result as T[] : [];
  }

  async createOne(model: string, values: Record<string, unknown>): Promise<number> {
    const created = await this.call<unknown>(model, "create", { vals_list: [values] });
    const ids = idsFromCreateResult(created);
    if (ids.length !== 1) throw new OdooJson2Error(`Odoo did not return exactly one ${model} record ID`);
    return ids[0];
  }

  async writeOne(model: string, id: number, values: Record<string, unknown>): Promise<void> {
    if (!Number.isInteger(id) || id <= 0) throw new OdooJson2Error(`Invalid ${model} record ID`);
    const result = await this.call<unknown>(model, "write", { ids: [id], vals: values });
    if (result !== true && result !== 1 && !(Array.isArray(result) && result.includes(id))) {
      throw new OdooJson2Error(`Odoo did not confirm ${model} ${id} update`);
    }
  }

  async postInvoice(id: number): Promise<void> {
    if (!Number.isInteger(id) || id <= 0) throw new OdooJson2Error("Invalid account.move record ID");
    await this.call("account.move", "action_post", { ids: [id] });
  }

  async getJournals(): Promise<OdooJournal[]> {
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.journal",
      [["type", "=", "bank"], ["company_id", "=", this.companyId], ["active", "=", true]],
      [
        "id", "name", "code", "type", "company_id", "currency_id",
        "default_account_id", "bank_account_id",
      ],
    );
    return rows
      .map((row) => {
        const company = relation(row.company_id);
        const currency = relation(row.currency_id);
        const account = relation(row.default_account_id);
        const bank = relation(row.bank_account_id);
        return {
          id: Number(row.id),
          name: String(row.name ?? ""),
          code: String(row.code ?? ""),
          type: String(row.type ?? ""),
          company_id: company.id ?? this.companyId,
          company_name: company.name ?? "",
          currency_id: currency.id,
          currency_name: currency.name,
          default_account_id: account.id,
          default_account_name: account.name,
          bank_account_id: bank.id,
          bank_account_name: bank.name,
        };
      })
      .filter((journal) => Number.isInteger(journal.id) && journal.company_id === this.companyId);
  }

  async validateJournal(journalId: number): Promise<OdooJournal> {
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.journal",
      [["id", "=", journalId], ["type", "=", "bank"], ["company_id", "=", this.companyId], ["active", "=", true]],
      [
        "id", "name", "code", "type", "company_id", "currency_id",
        "default_account_id", "bank_account_id",
      ],
      1,
    );
    const journal = rows.length ? await this.normaliseJournal(rows[0]) : null;
    if (!journal) throw new OdooJson2Error("Configured Odoo journal was not found, is inactive, or belongs to another company");
    return journal;
  }

  async getCompany(): Promise<{ id: number; name: string; currency_id: number | null; currency_name: string | null }> {
    const rows = await this.searchRead<Record<string, unknown>>(
      "res.company",
      [["id", "=", this.companyId]],
      ["id", "name", "currency_id"],
      1,
    );
    const row = rows[0];
    if (!row || Number(row.id) !== this.companyId) {
      throw new OdooJson2Error("Configured Odoo company was not found");
    }
    const currency = relation(row.currency_id);
    return {
      id: this.companyId,
      name: String(row.name ?? ""),
      currency_id: currency.id,
      currency_name: currency.name,
    };
  }

  private async normaliseJournal(row: Record<string, unknown>): Promise<OdooJournal> {
    const company = relation(row.company_id);
    const currency = relation(row.currency_id);
    const account = relation(row.default_account_id);
    const bank = relation(row.bank_account_id);
    return {
      id: Number(row.id),
      name: String(row.name ?? ""),
      code: String(row.code ?? ""),
      type: String(row.type ?? ""),
      company_id: company.id ?? this.companyId,
      company_name: company.name ?? "",
      currency_id: currency.id,
      currency_name: currency.name,
      default_account_id: account.id,
      default_account_name: account.name,
      bank_account_id: bank.id,
      bank_account_name: bank.name,
    };
  }

  async diagnostics(): Promise<{
    context: Record<string, unknown> | null;
    company: Record<string, unknown> | null;
    journals: OdooJournal[];
    access: Record<string, unknown>;
  }> {
    const diagnostics = {
      context: null as Record<string, unknown> | null,
      company: null as Record<string, unknown> | null,
      journals: [] as OdooJournal[],
      access: {} as Record<string, unknown>,
    };
    diagnostics.context = await this.call<Record<string, unknown>>("res.users", "context_get");
    const companies = await this.searchRead<Record<string, unknown>>(
      "res.company", [["id", "=", this.companyId]], ["id", "name", "currency_id"], 1,
    );
    diagnostics.company = companies[0] ?? null;
    diagnostics.journals = await this.getJournals();
    for (const [model, operation] of [
      ["account.journal", "read"],
      ["account.bank.statement.line", "read"],
      ["account.bank.statement.line", "create"],
      ["account.bank.statement.line", "write"],
      ["account.move.line", "read"],
      ["account.move.line", "write"],
    ] as const) {
      diagnostics.access[`${model}.${operation}`] = await this.call(
        model,
        "check_access_rights",
        { operation, raise_exception: false },
      );
    }
    return diagnostics;
  }

  async findStatementLineByMarker(marker: string, journalId: number): Promise<number | null> {
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.bank.statement.line",
      [["ref", "ilike", marker], ["journal_id", "=", journalId], ["company_id", "=", this.companyId]],
      ["id", "journal_id", "company_id", "ref", "is_reconciled", "move_id"],
      2,
    );
    const row = rows.find((candidate) =>
      relation(candidate.journal_id).id === journalId &&
      relation(candidate.company_id).id === this.companyId &&
      String(candidate.ref ?? "").includes(marker),
    );
    return row ? Number(row.id) : null;
  }

  async createStatementLine(
    journalId: number,
    values: Record<string, unknown>,
  ): Promise<number> {
    const created = await this.call<unknown>("account.bank.statement.line", "create", { vals_list: [values] });
    const ids = idsFromCreateResult(created);
    if (ids.length !== 1) throw new OdooJson2Error("Odoo did not return a statement-line ID");
    return ids[0];
  }

  async refreshReconciliationState(statementLineIds: number[]): Promise<OdooStatementLineState[]> {
    if (statementLineIds.length === 0) return [];
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.bank.statement.line",
      [["id", "in", statementLineIds], ["company_id", "=", this.companyId]],
      ["id", "is_reconciled", "move_id"],
      statementLineIds.length,
    );
    const states: OdooStatementLineState[] = [];
    for (const row of rows) {
      const moveId = relation(row.move_id).id;
      let moveLines: Array<Record<string, unknown>> = [];
      if (moveId) {
        moveLines = await this.searchRead<Record<string, unknown>>(
          "account.move.line",
          [["move_id", "=", moveId], ["company_id", "=", this.companyId]],
          ["id", "reconciled", "company_id", "account_id"],
          100,
        );
        const accountIds = moveLines.map((line) => relation(line.account_id).id).filter((id): id is number => id != null);
        if (accountIds.length) {
          const accounts = await this.searchRead<Record<string, unknown>>(
            "account.account",
            [["id", "in", accountIds], ["company_id", "=", this.companyId]],
            ["id", "name", "code", "reconcile", "account_type", "internal_group", "is_off_balance"],
            accountIds.length,
          );
          const accountById = new Map(accounts.map((account) => [Number(account.id), account]));
          moveLines = moveLines.map((line) => ({
            ...line,
            _account: accountById.get(relation(line.account_id).id ?? -1),
          }));
        }
      }
      const liquidityMoveLineIds = moveLines
        .filter((line) => {
          const account = (line as { _account?: Record<string, unknown> })._account;
          const accountType = String(account?.account_type ?? "");
          const internalGroup = String(account?.internal_group ?? "");
          return accountType === "asset_cash" || internalGroup === "liquidity";
        })
        .map((line) => Number(line.id))
        .filter(Number.isInteger);
      const statementSideEligibleMoveLineIds = moveLines
        .filter((line) => {
          const account = (line as { _account?: Record<string, unknown> })._account;
          if (!account?.reconcile || account.is_off_balance === true) return false;
          const accountType = String(account.account_type ?? "");
          const internalGroup = String(account.internal_group ?? "");
          const accountLabel = `${String(account.name ?? "")} ${String(account.code ?? "")}`.toLowerCase();
          const isLiquidity = accountType === "asset_cash" || internalGroup === "liquidity";
          const isSuspense = accountLabel.includes("suspense") || accountLabel.includes("temporary clearing");
          return !isLiquidity && !isSuspense;
        })
        .map((line) => Number(line.id))
        .filter(Number.isInteger);
      states.push({
        id: Number(row.id),
        is_reconciled: row.is_reconciled === true,
        move_id: moveId,
        move_line_ids: moveLines.map((line) => Number(line.id)).filter(Number.isInteger),
        move_line_reconciled: moveLines.length > 0 && moveLines.every((line) => line.reconciled === true),
        liquidity_move_line_ids: liquidityMoveLineIds,
        unreconciled_liquidity_move_line_ids: liquidityMoveLineIds.filter((id) => {
          const line = moveLines.find((candidate) => Number(candidate.id) === id);
          return line?.reconciled !== true;
        }),
        statement_side_eligible_move_line_ids: statementSideEligibleMoveLineIds,
        unreconciled_statement_side_eligible_move_line_ids: statementSideEligibleMoveLineIds.filter((id) => {
          const line = moveLines.find((candidate) => Number(candidate.id) === id);
          return line?.reconciled !== true;
        }),
      });
    }
    return states;
  }

  async validateMoveLineSelection(moveLineIds: number[]): Promise<{
    id: number;
    company_id: number | null;
    account_id: number | null;
    reconciled: boolean;
    reconcilable: boolean;
  }[]> {
    const ids = [...new Set(moveLineIds)];
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.move.line",
      [["id", "in", ids], ["company_id", "=", this.companyId]],
      ["id", "company_id", "reconciled", "account_id"],
      ids.length,
    );
    const accountIds = rows.map((row) => relation(row.account_id).id).filter((id): id is number => id != null);
    const accounts = accountIds.length
      ? await this.searchRead<Record<string, unknown>>(
        "account.account",
        [["id", "in", accountIds], ["company_id", "=", this.companyId]],
        ["id", "reconcile"],
        accountIds.length,
      )
      : [];
    const accountById = new Map(accounts.map((account) => [Number(account.id), account]));
    return rows.map((row) => ({
      id: Number(row.id),
      company_id: relation(row.company_id).id,
      account_id: relation(row.account_id).id,
      reconciled: row.reconciled === true,
      reconcilable: accountById.get(relation(row.account_id).id ?? -1)?.reconcile === true,
    }));
  }

  async reconcileMoveLines(moveLineIds: number[]): Promise<unknown> {
    if (new Set(moveLineIds).size !== moveLineIds.length) {
      throw new OdooJson2Error("Duplicate Odoo journal item IDs are not allowed");
    }
    const ids = moveLineIds.filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length < 2 || ids.length !== moveLineIds.length) {
      throw new OdooJson2Error("At least two valid Odoo journal items are required to reconcile");
    }
    const rows = await this.searchRead<Record<string, unknown>>(
      "account.move.line",
      [["id", "in", ids], ["company_id", "=", this.companyId]],
      ["id", "company_id", "reconciled", "account_id"],
      ids.length,
    );
    const found = new Set(rows.map((row) => Number(row.id)));
    if (
      found.size !== ids.length ||
      ids.some((id) => !found.has(id)) ||
      rows.some((row) => relation(row.company_id).id !== this.companyId || row.reconciled === true)
    ) {
      throw new OdooJson2Error("One or more selected Odoo journal items are missing or belong to another company");
    }
    const accountIds = new Set(rows.map((row) => relation(row.account_id).id).filter((id): id is number => id != null));
    if (accountIds.size !== 1 || accountIds.size !== rows.length) {
      throw new OdooJson2Error("All selected Odoo journal items must use the same reconcilable account");
    }
    const accounts = await this.searchRead<Record<string, unknown>>(
      "account.account",
      [["id", "in", [...accountIds]], ["company_id", "=", this.companyId]],
      ["id", "reconcile"],
      accountIds.size,
    );
    if (accounts.length !== 1 || accounts[0].reconcile !== true) {
      throw new OdooJson2Error("All selected Odoo journal items must use the same reconcilable account");
    }
    return this.call("account.move.line", "reconcile", { ids });
  }
}

export function statementLineMarker(fingerprint: string): string {
  return `[PRESENTAIL-LB:${fingerprint}]`;
}
