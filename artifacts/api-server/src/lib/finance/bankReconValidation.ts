export const LEBANON_ODOO_COMPANY_ID = 2;
export const LEBANON_ODOO_COMPANY_NAME = "Presentail SAL";

export function normaliseCurrencyCode(value: unknown): string {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "LEBANESE POUND" || normalized === "ل.ل") return "LBP";
  return normalized;
}

export function currenciesCompatible(left: unknown, right: unknown): boolean {
  const a = normaliseCurrencyCode(left);
  const b = normaliseCurrencyCode(right);
  return Boolean(a && b && a === b);
}

export type ParsedBankAmount = {
  debit: number;
  credit: number;
  signed: number;
};

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

function parseDecimal(value: string | null, label: string): number {
  if (value == null || value.trim() === "") return 0;
  const raw = value.trim();
  if (!DECIMAL.test(raw)) throw new Error(`${label} must be a non-negative decimal amount`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a finite non-negative decimal amount`);
  }
  return parsed;
}

export function parseBankAmounts(
  debitAmount: string | null,
  creditAmount: string | null,
): ParsedBankAmount {
  const debit = parseDecimal(debitAmount, "Debit amount");
  const credit = parseDecimal(creditAmount, "Credit amount");
  if (debit > 0 && credit > 0) {
    throw new Error("Debit and credit amounts cannot both be positive");
  }
  if (debit === 0 && credit === 0) {
    throw new Error("Exactly one positive debit or credit amount is required");
  }
  return { debit, credit, signed: credit - debit };
}
