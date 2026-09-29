import { describe, expect, it, vi } from "vitest";
import {
  buildInvoiceAttachmentRepairReport,
  parseInvoiceAttachmentRepairOptions,
} from "./repair-odoo-invoice-attachments";

const MAIN_MARKER = "Presentail internal idempotency marker [PRESENTAIL-INV:7:99]";

function fakeClient(options: {
  mainAttachmentId?: number | null;
  attachments?: Array<Record<string, unknown>>;
} = {}) {
  let mainAttachmentId = options.mainAttachmentId ?? null;
  const attachments = (options.attachments ?? [{
    id: 7001,
    name: "OCR scan 2026.png",
    res_model: "account.move",
    res_id: 8899,
    description: MAIN_MARKER,
  }]).map((row) => ({ ...row }));
  const writes: Array<{ model: string; id: number; vals: Record<string, unknown> }> = [];
  const searchRead = vi.fn(async <T extends Record<string, unknown>>(
    model: string,
    domain: unknown[][],
  ): Promise<T[]> => {
    if (model === "ir.attachment") {
      const idFilter = domain.find((part) => part[0] === "id" && part[1] === "=")?.[2];
      return attachments
        .filter((row) => idFilter == null || Number(row.id) === Number(idFilter))
        .map((row) => ({ ...row }) as unknown as T);
    }
    if (model === "account.move") {
      return [{
        id: 8899,
        name: "BILL/2026/00899",
        move_type: "in_invoice",
        company_id: [2, "Presentail SAL"],
        partner_id: [301, "Acme Flowers SAL"],
        ref: "INV-99",
        message_main_attachment_id: mainAttachmentId ? [mainAttachmentId, "Main"] : false,
      } as unknown as T];
    }
    if (model === "res.partner") {
      return [{ id: 301, name: "Acme Flowers SAL", display_name: "Acme Flowers SAL" } as unknown as T];
    }
    throw new Error(`Unexpected search model ${model}`);
  });
  const writeOne = vi.fn(async (model: string, id: number, vals: Record<string, unknown>) => {
    writes.push({ model, id, vals: { ...vals } });
    if (model === "ir.attachment") {
      const row = attachments.find((attachment) => Number(attachment.id) === id);
      if (row) Object.assign(row, vals);
    }
    if (model === "account.move" && Object.hasOwn(vals, "message_main_attachment_id")) {
      mainAttachmentId = Number(vals.message_main_attachment_id);
    }
  });
  return { searchRead, writeOne, writes, attachments, getMainId: () => mainAttachmentId };
}

const options = {
  mode: "dry-run" as const,
  entityId: 7,
  companyId: 2,
};

describe("Odoo invoice attachment repair", () => {
  it("defaults to dry-run and accepts an explicit entity/company/import scope", () => {
    expect(parseInvoiceAttachmentRepairOptions(["--entity-id", "7", "--company-id", "2"]))
      .toEqual({ ...options });
    expect(parseInvoiceAttachmentRepairOptions([
      "apply", "--entity-id", "7", "--company-id", "2", "--import-ids", "99,100",
    ])).toMatchObject({ mode: "apply", entityId: 7, companyId: 2, importIds: [99, 100] });
  });

  it("reports the candidate and proposed stable name in dry-run without writes", async () => {
    const client = fakeClient();
    const report = await buildInvoiceAttachmentRepairReport(
      client as unknown as Parameters<typeof buildInvoiceAttachmentRepairReport>[0],
      options,
    );
    expect(report.summary).toMatchObject({ candidate_count: 1, ready_count: 1, applied_count: 0 });
    expect(report.candidates[0]).toMatchObject({
      bill_id: 8899,
      attachment_ids: [7001],
      current_attachment_names: ["OCR scan 2026.png"],
      proposed_filename: "Acme Flowers SAL INV-99.pdf",
      status: "ready",
    });
    expect(client.writeOne).not.toHaveBeenCalled();
  });

  it("renames only the matched scan, then sets and verifies an empty main attachment", async () => {
    const client = fakeClient({
      attachments: [
        {
          id: 7001,
          name: "OCR scan 2026.png",
          res_model: "account.move",
          res_id: 8899,
          description: MAIN_MARKER,
        },
        {
          id: 7002,
          name: "unrelated.pdf",
          res_model: "account.move",
          res_id: 8899,
          description: "Uploaded by an accountant",
        },
      ],
    });
    const report = await buildInvoiceAttachmentRepairReport(
      client as unknown as Parameters<typeof buildInvoiceAttachmentRepairReport>[0],
      { ...options, mode: "apply" },
    );
    expect(report.summary).toMatchObject({ applied_count: 1, skipped_count: 0, failed_count: 0 });
    expect(report.candidates[0]).toMatchObject({ status: "applied", current_main_attachment_id: 7001 });
    expect(client.attachments.map((attachment) => attachment.name)).toEqual([
      "Acme Flowers SAL INV-99.pdf",
      "unrelated.pdf",
    ]);
    expect(client.writes).toEqual([
      { model: "ir.attachment", id: 7001, vals: { name: "Acme Flowers SAL INV-99.pdf" } },
      { model: "account.move", id: 8899, vals: { message_main_attachment_id: 7001 } },
    ]);
    expect(client.getMainId()).toBe(7001);
  });

  it("skips already-designated bills without renaming or replacing the main document", async () => {
    const client = fakeClient({ mainAttachmentId: 5555 });
    const report = await buildInvoiceAttachmentRepairReport(
      client as unknown as Parameters<typeof buildInvoiceAttachmentRepairReport>[0],
      { ...options, mode: "apply" },
    );
    expect(report.candidates[0]).toMatchObject({
      status: "skipped_existing_main",
      current_main_attachment_id: 5555,
    });
    expect(client.writeOne).not.toHaveBeenCalled();
    expect(client.getMainId()).toBe(5555);
  });

  it("skips duplicate marker matches as ambiguous", async () => {
    const client = fakeClient({
      attachments: [
        { id: 7001, name: "scan-a.png", res_model: "account.move", res_id: 8899, description: MAIN_MARKER },
        { id: 7002, name: "scan-b.png", res_model: "account.move", res_id: 8899, description: MAIN_MARKER },
      ],
    });
    const report = await buildInvoiceAttachmentRepairReport(
      client as unknown as Parameters<typeof buildInvoiceAttachmentRepairReport>[0],
      { ...options, mode: "apply" },
    );
    expect(report.candidates[0]).toMatchObject({
      status: "skipped_ambiguous",
      attachment_ids: [7001, 7002],
    });
    expect(client.writeOne).not.toHaveBeenCalled();
  });
});