import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { z } from "zod";
import PDFDocument from "pdfkit";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { db } from "../lib/db";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "../../outputs");

function ensureOutputsDir() {
  if (!fs.existsSync(OUTPUTS_DIR)) {
    fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  }
}

const platformSchema = z.object({
  name: z.string().min(1, "Platform name is required"),
  allocation: z.number().min(0).max(100),
});

const channelSchema = z.object({
  name: z.string().min(1),
  salesTarget: z.number().positive("Sales target must be positive"),
  marketingBudgetPct: z.number().min(0).max(100, "Marketing budget must be 0-100%"),
  platforms: z.array(platformSchema).min(1, "At least one platform is required"),
});

const calculateRequestSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  channels: z.array(channelSchema).length(3, "Exactly 3 channels required"),
});

const dailyRowSchema = z.object({
  date: z.string(),
  platforms: z.record(z.string(), z.number()),
});

const channelGridSchema = z.object({
  channelName: z.string(),
  platformNames: z.array(z.string()),
  rows: z.array(dailyRowSchema),
  calculatedTotal: z.number(),
});

const generateRequestSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  currency: z.string().min(1).max(10).optional().default("AED"),
  channels: z.array(channelGridSchema),
});

function getDatesInRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

router.post("/budget/calculate", async (req, res) => {
  const parsed = calculateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { month, year, startDate, endDate, channels } = parsed.data;

  if (new Date(startDate) > new Date(endDate)) {
    res.status(400).json({ error: "Start date must be before or equal to end date" });
    return;
  }

  const errors: string[] = [];
  channels.forEach((ch, i) => {
    const totalAlloc = ch.platforms.reduce((sum, p) => sum + p.allocation, 0);
    if (Math.abs(totalAlloc - 100) > 0.01) {
      errors.push(`Channel "${ch.name}" platform allocations must sum to 100% (currently ${totalAlloc.toFixed(1)}%)`);
    }
  });

  if (errors.length > 0) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }

  const dates = getDatesInRange(startDate, endDate);
  const numDays = dates.length;

  if (numDays === 0) {
    res.status(400).json({ error: "Date range produces no days" });
    return;
  }

  const channelGrids = channels.map((ch) => {
    const totalBudget = ch.salesTarget * (ch.marketingBudgetPct / 100);
    const dailyBudget = totalBudget / numDays;

    const platformNames = ch.platforms.map((p) => p.name);

    const rows = dates.map((date) => {
      const platforms: Record<string, number> = {};
      ch.platforms.forEach((p) => {
        platforms[p.name] = parseFloat((dailyBudget * (p.allocation / 100)).toFixed(2));
      });
      return { date, platforms };
    });

    return {
      channelName: ch.name,
      platformNames,
      rows,
      calculatedTotal: parseFloat(totalBudget.toFixed(2)),
    };
  });

  res.json({ month, year, channels: channelGrids });
});

router.post("/budget/generate", async (req, res) => {
  const parsed = generateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { month, year, currency, channels } = parsed.data;

  ensureOutputsDir();

  const monthName = MONTH_NAMES[month - 1];
  const downloadUrls: Array<{ channelName: string; url: string; filename: string }> = [];

  try {
    for (const channel of channels) {
      const safeName = channel.channelName.replace(/[^A-Za-z0-9_-]/g, "_");
      const filename = `${monthName}_${year}_${safeName}_ad_spend_budget.pdf`;
      const filePath = path.join(OUTPUTS_DIR, filename);
      const resolvedFilePath = path.resolve(filePath);
      const resolvedOutputsDir = path.resolve(OUTPUTS_DIR);
      if (!resolvedFilePath.startsWith(resolvedOutputsDir + path.sep)) {
        res.status(400).json({ error: "Invalid channel name" });
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
        const writeStream = fs.createWriteStream(filePath);

        doc.pipe(writeStream);

        const primaryColor = "#1a56db";
        const headerBg = "#1e3a5f";
        const altRowBg = "#f3f7fb";
        const borderColor = "#d1dce8";
        const totalRowBg = "#e8f0fb";

        doc.fontSize(18).fillColor(headerBg).font("Helvetica-Bold")
          .text(`${channel.channelName} — Ad Spend Budget`, { align: "center" });
        doc.fontSize(11).fillColor("#555").font("Helvetica")
          .text(`${monthName} ${year}`, { align: "center" });
        doc.moveDown(0.8);

        const platformNames = channel.platformNames;
        const numCols = platformNames.length + 2;

        const pageWidth = doc.page.width - 80;
        const dateColWidth = 90;
        const totalColWidth = 80;
        const platformColWidth = Math.max(60, (pageWidth - dateColWidth - totalColWidth) / platformNames.length);
        const rowHeight = 22;
        const headerRowHeight = 30;

        let x = 40;
        const startY = doc.y;
        let y = startY;

        const drawCell = (
          text: string,
          cx: number,
          cy: number,
          cw: number,
          ch: number,
          opts: {
            bgColor?: string;
            textColor?: string;
            bold?: boolean;
            align?: "left" | "center" | "right";
            fontSize?: number;
          } = {}
        ) => {
          const {
            bgColor,
            textColor = "#1a1a2e",
            bold = false,
            align = "center",
            fontSize = 9,
          } = opts;

          if (bgColor) {
            doc.rect(cx, cy, cw, ch).fill(bgColor).stroke(borderColor);
          } else {
            doc.rect(cx, cy, cw, ch).stroke(borderColor);
          }

          doc.fillColor(textColor)
            .font(bold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(fontSize);

          const textX = cx + 4;
          const textWidth = cw - 8;

          doc.text(text, textX, cy + (ch - fontSize) / 2 + 1, {
            width: textWidth,
            align,
            lineBreak: false,
          });
        };

        drawCell("Date", x, y, dateColWidth, headerRowHeight, {
          bgColor: headerBg, textColor: "#ffffff", bold: true, align: "center", fontSize: 10,
        });
        x += dateColWidth;

        platformNames.forEach((pName) => {
          drawCell(pName, x, y, platformColWidth, headerRowHeight, {
            bgColor: headerBg, textColor: "#ffffff", bold: true, align: "center", fontSize: 9,
          });
          x += platformColWidth;
        });

        drawCell("Total", x, y, totalColWidth, headerRowHeight, {
          bgColor: headerBg, textColor: "#ffffff", bold: true, align: "center", fontSize: 10,
        });

        y += headerRowHeight;

        const platformTotals: Record<string, number> = {};
        platformNames.forEach((p) => { platformTotals[p] = 0; });
        let grandTotal = 0;

        channel.rows.forEach((row, rowIdx) => {
          x = 40;
          const isAlt = rowIdx % 2 === 1;
          const bg = isAlt ? altRowBg : "#ffffff";

          const displayDate = new Date(row.date + "T00:00:00Z").toLocaleDateString("en-GB", {
            day: "2-digit", month: "short", year: "numeric", timeZone: "UTC",
          });

          drawCell(displayDate, x, y, dateColWidth, rowHeight, {
            bgColor: bg, align: "left", fontSize: 8,
          });
          x += dateColWidth;

          let rowTotal = 0;
          platformNames.forEach((pName) => {
            const val = row.platforms[pName] ?? 0;
            platformTotals[pName] = (platformTotals[pName] ?? 0) + val;
            rowTotal += val;
            drawCell(`${currency} ${val.toFixed(2)}`, x, y, platformColWidth, rowHeight, {
              bgColor: bg, align: "right", fontSize: 8,
            });
            x += platformColWidth;
          });

          grandTotal += rowTotal;
          drawCell(`${currency} ${rowTotal.toFixed(2)}`, x, y, totalColWidth, rowHeight, {
            bgColor: bg, align: "right", fontSize: 8, bold: true,
          });

          y += rowHeight;

          if (y > doc.page.height - 60) {
            doc.addPage();
            y = 40;
          }
        });

        x = 40;
        drawCell("Total Budget", x, y, dateColWidth, rowHeight + 4, {
          bgColor: totalRowBg, bold: true, align: "left", fontSize: 9, textColor: primaryColor,
        });
        x += dateColWidth;

        platformNames.forEach((pName) => {
          drawCell(`${currency} ${(platformTotals[pName] ?? 0).toFixed(2)}`, x, y, platformColWidth, rowHeight + 4, {
            bgColor: totalRowBg, bold: true, align: "right", fontSize: 9, textColor: primaryColor,
          });
          x += platformColWidth;
        });

        drawCell(`${currency} ${grandTotal.toFixed(2)}`, x, y, totalColWidth, rowHeight + 4, {
          bgColor: totalRowBg, bold: true, align: "right", fontSize: 10, textColor: primaryColor,
        });

        doc.end();

        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      downloadUrls.push({
        channelName: channel.channelName,
        url: `/api/budget/download/${filename}`,
        filename,
      });
    }

    res.json({ files: downloadUrls });
  } catch (err) {
    req.log.error({ err }, "budget/generate: PDF generation failed");
    res.status(500).json({ error: "Failed to generate PDFs" });
  }
});

// ── Budget Configuration persistence ──────────────────────────────────────

const saveConfigSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  channels: z.array(channelSchema),
});

type BudgetConfigRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  month: number;
  year: number;
  start_date: string;
  end_date: string;
  channels: z.infer<typeof channelSchema>[];
  created_at: string;
  updated_at: string;
};

router.get("/budget/configs", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<BudgetConfigRow>(
    `SELECT id, name, month, year, start_date, end_date, channels, created_at, updated_at
       FROM budget_configs
      WHERE workspace_owner_id = $1
      ORDER BY updated_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ configs: result.rows });
});

router.post("/budget/configs", async (req, res) => {
  const wreq = workspace(req);
  const parsed = saveConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const { name, month, year, startDate, endDate, channels } = parsed.data;
  const result = await db.query<BudgetConfigRow>(
    `INSERT INTO budget_configs (workspace_owner_id, name, month, year, start_date, end_date, channels)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, month, year, start_date, end_date, channels, created_at, updated_at`,
    [wreq.workspaceOwnerId, name, month, year, startDate, endDate, JSON.stringify(channels)],
  );
  res.status(201).json({ config: result.rows[0] });
});

router.patch("/budget/configs/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid config id" });
    return;
  }
  const parsed = z.object({ name: z.string().min(1, "Name is required").max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const result = await db.query<BudgetConfigRow>(
    `UPDATE budget_configs
        SET name = $1, updated_at = now()
      WHERE id = $2 AND workspace_owner_id = $3
      RETURNING id, name, month, year, start_date, end_date, channels, created_at, updated_at`,
    [parsed.data.name, id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Config not found" });
    return;
  }
  res.json({ config: result.rows[0] });
});

router.put("/budget/configs/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid config id" });
    return;
  }
  const parsed = saveConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const { name, month, year, startDate, endDate, channels } = parsed.data;
  const result = await db.query<BudgetConfigRow>(
    `UPDATE budget_configs
        SET name = $1, month = $2, year = $3, start_date = $4, end_date = $5,
            channels = $6, updated_at = now()
      WHERE id = $7 AND workspace_owner_id = $8
      RETURNING id, name, month, year, start_date, end_date, channels, created_at, updated_at`,
    [name, month, year, startDate, endDate, JSON.stringify(channels), id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Config not found" });
    return;
  }
  res.json({ config: result.rows[0] });
});

router.delete("/budget/configs/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid config id" });
    return;
  }
  const result = await db.query(
    `DELETE FROM budget_configs WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Config not found" });
    return;
  }
  res.json({ ok: true });
});

// ── Marketing Budgets API (/api/marketing-budgets) ────────────────────────

type MarketingBudgetRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  month: number;
  year: number;
  start_date: string;
  end_date: string;
  currency: string;
  channels: z.infer<typeof channelSchema>[];
  created_at: string;
  updated_at: string;
  status?: "planned" | "current" | "past";
};

function calcBudgetStatus(startDate: string, endDate: string): "planned" | "current" | "past" {
  const today = new Date().toISOString().split("T")[0];
  if (today < startDate) return "planned";
  if (today > endDate) return "past";
  return "current";
}

const createMarketingBudgetSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().min(1).max(10).default("AED"),
  channels: z.array(channelSchema).optional().default([]),
});

const updateMarketingBudgetSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().min(1).max(10).optional(),
  channels: z.array(channelSchema).optional(),
});

router.get("/marketing-budgets", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<MarketingBudgetRow>(
    `SELECT id, name, month, year, start_date, end_date, currency, channels, created_at, updated_at
       FROM budget_configs
      WHERE workspace_owner_id = $1
      ORDER BY updated_at DESC`,
    [wreq.workspaceOwnerId],
  );
  const budgets = result.rows.map((row) => ({
    ...row,
    status: calcBudgetStatus(row.start_date, row.end_date),
  }));
  res.json({ budgets });
});

router.post("/marketing-budgets", async (req, res) => {
  const wreq = workspace(req);
  const parsed = createMarketingBudgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const { name, startDate, endDate, currency, channels } = parsed.data;
  const derivedYear = parsed.data.year ?? parseInt(startDate.slice(0, 4), 10);
  const derivedMonth = parsed.data.month ?? parseInt(startDate.slice(5, 7), 10);
  if (new Date(startDate) > new Date(endDate)) {
    res.status(400).json({ error: "Start date must be before or equal to end date" });
    return;
  }
  const result = await db.query<MarketingBudgetRow>(
    `INSERT INTO budget_configs (workspace_owner_id, name, month, year, start_date, end_date, currency, channels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, month, year, start_date, end_date, currency, channels, created_at, updated_at`,
    [wreq.workspaceOwnerId, name, derivedMonth, derivedYear, startDate, endDate, currency, JSON.stringify(channels)],
  );
  const budget = { ...result.rows[0], status: calcBudgetStatus(startDate, endDate) };
  res.status(201).json({ budget });
});

router.get("/marketing-budgets/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid budget id" });
    return;
  }
  const result = await db.query<MarketingBudgetRow>(
    `SELECT id, name, month, year, start_date, end_date, currency, channels, created_at, updated_at
       FROM budget_configs
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Budget not found" });
    return;
  }
  const budget = { ...result.rows[0], status: calcBudgetStatus(result.rows[0].start_date, result.rows[0].end_date) };
  res.json({ budget });
});

router.patch("/marketing-budgets/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid budget id" });
    return;
  }
  const parsed = updateMarketingBudgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    return;
  }
  const existing = await db.query<MarketingBudgetRow>(
    `SELECT id, name, month, year, start_date, end_date, currency, channels, created_at, updated_at
       FROM budget_configs WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rows.length === 0) {
    res.status(404).json({ error: "Budget not found" });
    return;
  }
  const cur = existing.rows[0];
  const upd = parsed.data;
  const name = upd.name ?? cur.name;
  const startDate = upd.startDate ?? cur.start_date;
  const month = upd.month ?? (upd.startDate ? parseInt(upd.startDate.slice(5, 7), 10) : cur.month);
  const year = upd.year ?? (upd.startDate ? parseInt(upd.startDate.slice(0, 4), 10) : cur.year);
  const endDate = upd.endDate ?? cur.end_date;
  const currency = upd.currency ?? cur.currency;
  const channels = upd.channels !== undefined ? upd.channels : cur.channels;
  if (new Date(startDate) > new Date(endDate)) {
    res.status(400).json({ error: "Start date must be before or equal to end date" });
    return;
  }
  const result = await db.query<MarketingBudgetRow>(
    `UPDATE budget_configs
        SET name = $1, month = $2, year = $3, start_date = $4, end_date = $5,
            currency = $6, channels = $7, updated_at = now()
      WHERE id = $8 AND workspace_owner_id = $9
      RETURNING id, name, month, year, start_date, end_date, currency, channels, created_at, updated_at`,
    [name, month, year, startDate, endDate, currency, JSON.stringify(channels), id, wreq.workspaceOwnerId],
  );
  const budget = { ...result.rows[0], status: calcBudgetStatus(startDate, endDate) };
  res.json({ budget });
});

router.delete("/marketing-budgets/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid budget id" });
    return;
  }
  const result = await db.query(
    `DELETE FROM budget_configs WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Budget not found" });
    return;
  }
  res.json({ ok: true });
});

router.get("/budget/download/:filename", (req, res) => {
  const { filename } = req.params;

  if (!/^[\w\-]+\.pdf$/.test(filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  const filePath = path.join(OUTPUTS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }

  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "application/pdf");
  fs.createReadStream(filePath).pipe(res);
});

export default router;
