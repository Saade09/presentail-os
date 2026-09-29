#!/usr/bin/env node
/**
 * Paginated, machine-authenticated, read-only production Odoo audit.
 *
 * The production service executes the existing connector with readOnly:true.
 * This CLI cannot reach any bill sync/create/write route.
 */
import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";

const canonicalBaseURL = "https://os.presentail.com";
const baseURL = (process.env.PRODUCTION_SMOKE_BASE_URL ?? canonicalBaseURL).replace(/\/$/, "");
const receiptPath = process.env.PRODUCTION_AUTH_GATE_RECEIPT ?? "/tmp/presentail-production-auth-gate.json";
const receiptSecret = process.env.PRESENTAIL_OS_WEBHOOK_SECRET;
const auditCredential = process.env.ODOO_API_KEY;
const entityId = process.env.PRODUCTION_SMOKE_ENTITY_ID ?? "3";
const expectedAudited = Number(process.env.PRODUCTION_EXPECTED_AUDITED ?? "243");
const maxReceiptAgeMs = 30 * 60 * 1000;

type AuditPage = {
  read_only?: boolean;
  audited?: number;
  audit_complete?: boolean;
  next_after_id?: number;
  counts?: Record<string, number>;
};

async function main() {
  if (!receiptSecret) throw new Error("Odoo audit blocked: PRESENTAIL_OS_WEBHOOK_SECRET is unavailable.");
  if (!auditCredential) throw new Error("Odoo audit blocked: ODOO_API_KEY is unavailable.");
  if (baseURL !== canonicalBaseURL) throw new Error(`Odoo audit is pinned to ${canonicalBaseURL}.`);
  if (!Number.isInteger(expectedAudited) || expectedAudited < 0) {
    throw new Error("PRODUCTION_EXPECTED_AUDITED must be a non-negative integer.");
  }
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    status?: string;
    base_url?: string;
    clerk_domain?: string;
    passed_at?: string;
    checks?: Record<string, boolean>;
    signature?: string;
  };
  const { signature, ...unsignedReceipt } = receipt;
  const expectedSignature = createHmac("sha256", receiptSecret)
    .update(`presentail-production-auth-gate-v1\n${JSON.stringify(unsignedReceipt)}`)
    .digest("hex");
  const signatureValid = typeof signature === "string" &&
    signature.length === expectedSignature.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  const passedAt = Date.parse(receipt.passed_at ?? "");
  const receiptAge = Date.now() - passedAt;
  if (
    !signatureValid ||
    receipt.status !== "passed" ||
    receipt.base_url !== baseURL ||
    !Number.isFinite(passedAt) ||
    receiptAge < -60_000 ||
    receiptAge > maxReceiptAgeMs
  ) {
    throw new Error("Odoo audit blocked: run the production auth gate successfully immediately before this audit.");
  }

  let afterId = 0;
  let audited = 0;
  const counts: Record<string, number> = {};
  const seenCursors = new Set<number>();
  for (;;) {
    const params = new URLSearchParams({ entity_id: entityId, after_id: String(afterId) });
    const scopedAuditToken = createHmac("sha256", auditCredential)
      .update("production-odoo-read-only-audit-v1")
      .digest("hex");
    const response = await fetch(`${baseURL}/api/internal/finance/audit-approved-odoo?${params}`, {
      headers: {
        Authorization: `Bearer ${scopedAuditToken}`,
        "User-Agent": "presentail-read-only-odoo-audit/2.0",
      },
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });
    const body = (await response.json().catch(() => null)) as AuditPage | null;
    if (!response.ok) {
      throw new Error(`Read-only Odoo audit returned HTTP ${response.status}: ${JSON.stringify(body)}`);
    }
    if (!body || body.read_only !== true) {
      throw new Error("Read-only Odoo audit refused: response did not prove read_only=true.");
    }
    if (!Number.isInteger(body.audited) || !Number.isInteger(body.next_after_id) || typeof body.audit_complete !== "boolean") {
      throw new Error("Read-only Odoo audit returned an invalid pagination envelope.");
    }
    audited += body.audited as number;
    for (const [key, value] of Object.entries(body.counts ?? {})) counts[key] = (counts[key] ?? 0) + value;
    console.log(`Audited page: ${body.audited}; total ${audited}; cursor ${body.next_after_id}; complete=${body.audit_complete}`);
    if (body.audit_complete) break;
    const next = body.next_after_id as number;
    if (next <= afterId || seenCursors.has(next)) throw new Error("Read-only Odoo audit cursor did not advance.");
    seenCursors.add(next);
    afterId = next;
  }
  if (audited !== expectedAudited) {
    throw new Error(`Read-only Odoo audit count mismatch: expected ${expectedAudited}, received ${audited}.`);
  }
  console.log(JSON.stringify({ read_only: true, entity_id: Number(entityId), audited, counts }, null, 2));
  console.log("No Odoo bill or attachment create/write endpoint was called.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});