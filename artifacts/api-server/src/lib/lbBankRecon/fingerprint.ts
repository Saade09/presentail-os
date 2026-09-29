/**
 * Stable SHA-256 fingerprint for a Lebanon bank statement line.
 *
 * The fingerprint is derived from the fields that uniquely identify a
 * transaction within an account statement.  Including `sourceRowIndex`
 * in the hash means that two rows with an identical Transaction Ref on
 * different lines of the same statement get distinct fingerprints, so
 * they are never collapsed into a single DB row.
 */
import { createHash } from "crypto";

export interface LineFingerprintInput {
  /** lb_bank_accounts primary key. */
  accountId: number;
  /** Statement period start string (e.g. "01/07/2026"). */
  periodStart: string;
  /** Statement period end string (e.g. "31/07/2026"). */
  periodEnd: string;
  businessDate: string;
  valueDate: string;
  /** Positive debit amount, or null when the row is a credit. */
  debitAmount: number | null;
  /** Positive credit amount, or null when the row is a debit. */
  creditAmount: number | null;
  /** Free-text narrative (Unicode / Arabic preserved verbatim). */
  narrative: string;
  transactionRef: string;
  /**
   * Running / real-time balance for posted rows; null for pending rows
   * (which have no realtime balance column in BLOM statements).
   */
  realtimeBalance: number | null;
  /**
   * 0-based worksheet row index.
   * Ensures rows with repeated Transaction Ref values are distinct.
   */
  sourceRowIndex: number;
}

/**
 * Return a hex-encoded SHA-256 fingerprint for a bank statement line.
 *
 * Fields are joined with a NUL byte separator (`\x00`) to prevent boundary
 * collisions between adjacent string fields.
 */
export function computeLineFingerprint(input: LineFingerprintInput): string {
  const parts = [
    String(input.accountId),
    input.periodStart,
    input.periodEnd,
    input.businessDate,
    input.valueDate,
    input.debitAmount !== null ? String(input.debitAmount) : "",
    input.creditAmount !== null ? String(input.creditAmount) : "",
    input.narrative,
    input.transactionRef,
    input.realtimeBalance !== null ? String(input.realtimeBalance) : "",
    String(input.sourceRowIndex),
  ];

  return createHash("sha256").update(parts.join("\x00")).digest("hex");
}
