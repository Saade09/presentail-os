/**
 * Repairs only Odoo attachments created by Presentail OS, identified by the
 * connector's exact [PRESENTAIL-INV:<entity>:<import>] marker.
 *
 * Usage:
 *   repair:odoo-invoice-attachments --entity-id 7 --company-id 2
 *   repair:odoo-invoice-attachments apply --entity-id 7 --company-id 2 --import-ids 101,102
 *
 * Dry-run is the default. Review the report before explicitly passing apply.
 */
import { writeFile } from "node:fs/promises";
import { OdooJson2Client } from "../lib/finance/odooJson2Client.js";
import { buildOdooInvoiceAttachmentName } from "../lib/finance/odooInvoiceAttachmentName.js";
import { normaliseOdooBaseUrl } from "../lib/finance/odooUrl.js";

export type InvoiceAttachmentRepairMode = "dry-run" | "apply";

export type InvoiceAttachmentRepairOptions = {
  mode: InvoiceAttachmentRepairMode;
  entityId: number;
  companyId: number;
  importIds?: number[];
  outputPath?: string;
};

export type InvoiceAttachmentRepairCandidate = {
  entity_id: number;
  import_id: number;
  bill_id: number | null;
  bill_name: string | null;
  supplier_name: string | null;
  attachment_ids: number[];
  current_attachment_names: string[];
  proposed_filename: string | null;
  current_main_attachment_id: number | null;
  status:
    | "ready"
    | "skipped_ambiguous"
    | "skipped_invalid"
    | "skipped_existing_main"
    | "skipped_changed"
    | "applied"
    | "failed";
  reason: string | null;
};

export type InvoiceAttachmentRepairReport = {
  report_version: 1;
  generated_at: string;
  mode: InvoiceAttachmentRepairMode;
  entity_id: number;
  company_id: number;
  import_ids: number[] | null;
  summary: {
    candidate_count: number;
    ready_count: number;
    applied_count: number;
    skipped_count: number;
    failed_count: number;
  };
  candidates: InvoiceAttachmentRepairCandidate[];
};

type Json2ClientLike = {
  searchRead<T extends Record<string, unknown>>(
    model: string,
    domain: unknown[][],
    fields: string[],
    limit?: number,
    order?: string,
  ): Promise<T[]>;
  writeOne(model: string, id: number, values: Record<string, unknown>): Promise<void>;
};

type MarkedAttachment = {
  id: number;
  name: string;
  res_model: string;
  res_id: number;
  description: string;
  entity_id: number;
  import_id: number;
};

function recordId(value: unknown): number | null {
  const candidate = Array.isArray(value)
    ? value[0]
    : value && typeof value === "object" && "id" in value
      ? (value as { id: unknown }).id
      : value;
  const id = Number(candidate);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function markerIds(description: unknown): { entityId: number; importId: number } | null {
  const match = /(?:^|\s)Presentail internal idempotency marker \[PRESENTAIL-INV:(\d+):(\d+)\](?=\s|$)/.exec(
    String(description ?? ""),
  );
  if (!match) return null;
  const entityId = Number(match[1]);
  const importId = Number(match[2]);
  return Number.isInteger(entityId) && entityId > 0 && Number.isInteger(importId) && importId > 0
    ? { entityId, importId }
    : null;
}

function approvedReference(value: unknown): string {
  return String(value ?? "")
    .replace(/\[PRESENTAIL-INV:\d+:\d+\]/g, "")
    .trim();
}

export function parseInvoiceAttachmentRepairOptions(
  argv: string[] = process.argv.slice(2),
): InvoiceAttachmentRepairOptions {
  let mode: InvoiceAttachmentRepairMode = "dry-run";
  let entityId: number | undefined;
  let companyId: number | undefined;
  let importIds: number[] | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "apply" || arg === "--apply") mode = "apply";
    else if (arg === "dry-run" || arg === "--dry-run") mode = "dry-run";
    else if (arg === "--entity-id") entityId = Number(argv[++index]);
    else if (arg === "--company-id") companyId = Number(argv[++index]);
    else if (arg === "--import-ids") {
      const raw = argv[++index];
      if (!raw) throw new Error("--import-ids requires a comma-separated list");
      importIds = raw.split(",").map((value) => Number(value.trim()));
      if (importIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error("--import-ids must contain positive integer IDs");
      }
      importIds = [...new Set(importIds)];
    } else if (arg === "--output") {
      outputPath = argv[++index];
      if (!outputPath) throw new Error("--output requires a path");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(entityId) || Number(entityId) <= 0) {
    throw new Error("--entity-id must be a positive integer");
  }
  if (!Number.isInteger(companyId) || Number(companyId) <= 0) {
    throw new Error("--company-id must be a positive integer");
  }
  return {
    mode,
    entityId: Number(entityId),
    companyId: Number(companyId),
    ...(importIds ? { importIds } : {}),
    ...(outputPath ? { outputPath } : {}),
  };
}

async function readMove(
  client: Json2ClientLike,
  billId: number,
  companyId: number,
): Promise<Record<string, unknown> | null> {
  const rows = await client.searchRead<Record<string, unknown>>(
    "account.move",
    [["id", "=", billId], ["move_type", "=", "in_invoice"], ["company_id", "=", companyId]],
    ["id", "name", "move_type", "company_id", "partner_id", "ref", "message_main_attachment_id"],
    2,
  );
  const matches = rows.filter((row) =>
    Number(row.id) === billId &&
    String(row.move_type ?? "") === "in_invoice" &&
    recordId(row.company_id) === companyId,
  );
  return matches.length === 1 ? matches[0] : null;
}

async function readSupplierName(
  client: Json2ClientLike,
  partnerId: number,
): Promise<string | null> {
  const rows = await client.searchRead<Record<string, unknown>>(
    "res.partner",
    [["id", "=", partnerId]],
    ["id", "name", "display_name"],
    2,
  );
  const partner = rows.find((row) => Number(row.id) === partnerId);
  const name = String(partner?.display_name ?? partner?.name ?? "").trim();
  return name || null;
}

function attachmentFromRow(
  row: Record<string, unknown>,
  entityId: number,
): MarkedAttachment | null {
  const marker = markerIds(row.description);
  const id = Number(row.id);
  const resId = Number(row.res_id);
  if (
    !marker ||
    marker.entityId !== entityId ||
    !Number.isInteger(id) ||
    id <= 0 ||
    String(row.res_model ?? "") !== "account.move" ||
    !Number.isInteger(resId) ||
    resId <= 0
  ) {
    return null;
  }
  return {
    id,
    name: String(row.name ?? ""),
    res_model: "account.move",
    res_id: resId,
    description: String(row.description ?? ""),
    entity_id: marker.entityId,
    import_id: marker.importId,
  };
}

export async function buildInvoiceAttachmentRepairReport(
  client: Json2ClientLike,
  options: InvoiceAttachmentRepairOptions,
): Promise<InvoiceAttachmentRepairReport> {
  const domain: unknown[][] = [
    ["res_model", "=", "account.move"],
    ["description", "ilike", `[PRESENTAIL-INV:${options.entityId}:`],
  ];
  const rows = await client.searchRead<Record<string, unknown>>(
    "ir.attachment",
    domain,
    ["id", "name", "res_model", "res_id", "description"],
    10_000,
    "id",
  );
  const importFilter = options.importIds ? new Set(options.importIds) : null;
  const attachments = rows
    .map((row) => attachmentFromRow(row, options.entityId))
    .filter((attachment): attachment is MarkedAttachment =>
      attachment !== null && (!importFilter || importFilter.has(attachment.import_id)),
    );

  const markerGroups = new Map<string, MarkedAttachment[]>();
  for (const attachment of attachments) {
    const key = `${attachment.entity_id}:${attachment.import_id}`;
    markerGroups.set(key, [...(markerGroups.get(key) ?? []), attachment]);
  }
  const byBill = new Map<number, MarkedAttachment[]>();
  for (const attachment of attachments) {
    byBill.set(attachment.res_id, [...(byBill.get(attachment.res_id) ?? []), attachment]);
  }

  const candidates: InvoiceAttachmentRepairCandidate[] = [];
  for (const [key, markerMatches] of markerGroups) {
    const marker = markerMatches[0];
    const sameBillMarkers = byBill.get(marker.res_id) ?? [];
    const baseCandidate: InvoiceAttachmentRepairCandidate = {
      entity_id: marker.entity_id,
      import_id: marker.import_id,
      bill_id: marker.res_id,
      bill_name: null,
      supplier_name: null,
      attachment_ids: markerMatches.map((attachment) => attachment.id),
      current_attachment_names: markerMatches.map((attachment) => attachment.name),
      proposed_filename: null,
      current_main_attachment_id: null,
      status: "ready",
      reason: null,
    };
    if (markerMatches.length !== 1 || sameBillMarkers.length !== 1) {
      candidates.push({
        ...baseCandidate,
        attachment_ids: sameBillMarkers.map((attachment) => attachment.id),
        current_attachment_names: sameBillMarkers.map((attachment) => attachment.name),
        status: "skipped_ambiguous",
        reason: "More than one Presentail invoice scan matches this marker or bill",
      });
      continue;
    }

    const move = await readMove(client, marker.res_id, options.companyId);
    if (!move) {
      candidates.push({
        ...baseCandidate,
        status: "skipped_invalid",
        reason: "Marked attachment does not resolve to exactly one vendor bill in the selected company",
      });
      continue;
    }
    const partnerId = recordId(move.partner_id);
    const supplierName = partnerId ? await readSupplierName(client, partnerId) : null;
    if (!supplierName) {
      candidates.push({
        ...baseCandidate,
        bill_name: String(move.name ?? "") || null,
        status: "skipped_invalid",
        reason: "Vendor bill supplier could not be resolved",
      });
      continue;
    }
    const mainAttachmentId = recordId(move.message_main_attachment_id);
    const proposedFilename = buildOdooInvoiceAttachmentName(
      supplierName,
      approvedReference(move.ref),
      move.name,
    );
    const candidate: InvoiceAttachmentRepairCandidate = {
      ...baseCandidate,
      bill_name: String(move.name ?? "") || null,
      supplier_name: supplierName,
      proposed_filename: proposedFilename,
      current_main_attachment_id: mainAttachmentId,
    };
    if (mainAttachmentId) {
      candidates.push({
        ...candidate,
        status: "skipped_existing_main",
        reason: "Bill already has a main attachment; it will not be replaced",
      });
      continue;
    }
    if (options.mode === "dry-run") {
      candidates.push(candidate);
      continue;
    }

    try {
      // Re-read both records immediately before mutation. A stale dry-run or
      // a concurrent user edit must never authorize replacing a main document.
      const currentMove = await readMove(client, marker.res_id, options.companyId);
      if (!currentMove) {
        candidates.push({
          ...candidate,
          status: "skipped_changed",
          reason: "Vendor bill changed or is no longer in the selected company",
        });
        continue;
      }
      if (recordId(currentMove.message_main_attachment_id)) {
        candidates.push({
          ...candidate,
          current_main_attachment_id: recordId(currentMove.message_main_attachment_id),
          status: "skipped_existing_main",
          reason: "Bill acquired a main attachment after candidate discovery; it was preserved",
        });
        continue;
      }
      const currentAttachmentRows = await client.searchRead<Record<string, unknown>>(
        "ir.attachment",
        [["id", "=", marker.id], ["res_model", "=", "account.move"], ["res_id", "=", marker.res_id]],
        ["id", "name", "res_model", "res_id", "description"],
        2,
      );
      const currentAttachment = currentAttachmentRows
        .map((row) => attachmentFromRow(row, options.entityId))
        .find((attachment) =>
          attachment?.id === marker.id &&
          attachment.import_id === marker.import_id &&
          attachment.res_id === marker.res_id,
        );
      if (!currentAttachment) {
        candidates.push({
          ...candidate,
          status: "skipped_changed",
          reason: "The marked Presentail invoice scan changed after candidate discovery",
        });
        continue;
      }
      if (currentAttachment.name !== proposedFilename) {
        await client.writeOne("ir.attachment", currentAttachment.id, { name: proposedFilename });
      }
      const renamedRows = await client.searchRead<Record<string, unknown>>(
        "ir.attachment",
        [["id", "=", currentAttachment.id]],
        ["id", "name", "res_model", "res_id", "description"],
        2,
      );
      const renamed = renamedRows.find((row) =>
        Number(row.id) === currentAttachment.id &&
        String(row.res_model ?? "") === "account.move" &&
        Number(row.res_id) === marker.res_id &&
        markerIds(row.description)?.entityId === options.entityId &&
        markerIds(row.description)?.importId === marker.import_id &&
        String(row.name ?? "") === proposedFilename,
      );
      if (!renamed) throw new Error("Matched invoice scan filename could not be verified");

      const beforeMainWrite = await readMove(client, marker.res_id, options.companyId);
      if (!beforeMainWrite) throw new Error("Vendor bill could not be verified before setting its main attachment");
      const latestMainId = recordId(beforeMainWrite.message_main_attachment_id);
      if (latestMainId) {
        candidates.push({
          ...candidate,
          current_attachment_names: [proposedFilename],
          current_main_attachment_id: latestMainId,
          status: "skipped_existing_main",
          reason: "Bill acquired a main attachment during repair; it was preserved",
        });
        continue;
      }
      await client.writeOne("account.move", marker.res_id, {
        message_main_attachment_id: currentAttachment.id,
      });
      const verifiedMove = await readMove(client, marker.res_id, options.companyId);
      if (recordId(verifiedMove?.message_main_attachment_id) !== currentAttachment.id) {
        throw new Error("Bill main invoice attachment could not be verified");
      }
      candidates.push({
        ...candidate,
        current_attachment_names: [proposedFilename],
        current_main_attachment_id: currentAttachment.id,
        status: "applied",
        reason: null,
      });
    } catch (error) {
      candidates.push({
        ...candidate,
        status: "failed",
        reason: error instanceof Error ? error.message.slice(0, 240) : "Unknown Odoo repair error",
      });
    }
  }

  const readyCount = candidates.filter((candidate) => candidate.status === "ready").length;
  return {
    report_version: 1,
    generated_at: new Date().toISOString(),
    mode: options.mode,
    entity_id: options.entityId,
    company_id: options.companyId,
    import_ids: options.importIds ?? null,
    summary: {
      candidate_count: candidates.length,
      ready_count: readyCount,
      applied_count: candidates.filter((candidate) => candidate.status === "applied").length,
      skipped_count: candidates.filter((candidate) => candidate.status.startsWith("skipped_")).length,
      failed_count: candidates.filter((candidate) => candidate.status === "failed").length,
    },
    candidates,
  };
}

async function writeReport(report: InvoiceAttachmentRepairReport, outputPath?: string): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
  else console.log(serialized);
}

async function main(): Promise<void> {
  const options = parseInvoiceAttachmentRepairOptions();
  const baseUrl = process.env.ODOO_BASE_URL?.trim();
  const database = process.env.ODOO_DATABASE?.trim();
  const apiKey = process.env.ODOO_API_KEY?.trim();
  const base = normaliseOdooBaseUrl(baseUrl);
  if (!base.ok || !database || !apiKey) {
    throw new Error("Set ODOO_BASE_URL, ODOO_DATABASE, and ODOO_API_KEY before running the repair");
  }
  const client = new OdooJson2Client({
    baseUrl: base.url,
    database,
    companyId: options.companyId,
    apiKey,
  });
  const report = await buildInvoiceAttachmentRepairReport(client, options);
  await writeReport(report, options.outputPath);
  if (report.summary.failed_count > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("repair-odoo-invoice-attachments.ts")) {
  await main();
}