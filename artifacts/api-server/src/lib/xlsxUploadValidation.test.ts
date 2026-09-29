import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { validateXlsxUpload } from "./xlsxUploadValidation";

async function makeXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Items").addRow(["Name", "Code"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("validateXlsxUpload", () => {
  it("accepts a valid OOXML workbook", async () => {
    expect(validateXlsxUpload(await makeXlsx())).toEqual({ valid: true });
  });

  it("rejects plain text renamed as XLSX", () => {
    expect(validateXlsxUpload(Buffer.from("not a workbook"))).toMatchObject({
      valid: false,
    });
  });

  it("rejects a generic empty ZIP without required XLSX parts", () => {
    const emptyZip = Buffer.from([
      0x50, 0x4b, 0x05, 0x06,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00,
    ]);

    expect(validateXlsxUpload(emptyZip)).toMatchObject({ valid: false });
  });

  it("rejects local headers that disagree with the central directory", async () => {
    const xlsx = await makeXlsx();
    const corrupted = Buffer.from(xlsx);
    corrupted.writeUInt16LE(0, 8);

    expect(validateXlsxUpload(corrupted)).toMatchObject({ valid: false });
  });
});