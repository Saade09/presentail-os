import { randomUUID } from "crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  editImageBuffers,
  generateImageBuffer,
} from "@workspace/integrations-openai-ai-server/image";
import { callAI } from "../lib/ai/callAI";
import { applyRounding, getStoredRate, type RoundingRule } from "../lib/exchangeRateService";
import { requireAuth } from "../lib/auth";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { objectStorageService } from "../lib/objectStorage";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  BLOOMPRINT_IMAGE_MODELS,
  BLOOMPRINT_VISION_MODELS,
} from "../lib/aiUsageRecorder";

const router = Router();
router.use(requireAuth, resolveWorkspace);
const BLOOMPRINT_IMAGE_SIZE = "1024x1024";
const BLOOMPRINT_IMAGE_QUALITY = "medium";

type BaseItem = { id: number; name: string; code: string | null; canonical_unit: string | null };
type DraftRow = {
  id: number; workspace_owner_id: string; inspiration_image_path: string; analysis: Record<string, unknown>;
  name: string | null; description: string | null; price_usd: string | number | null; price_aed: string | number | null;
  substitution_notes: string | null; box_color: string; status: string; style_profile_id: number | null; recipe_suggestion_id: number | null;
  generated_image_path: string | null; generated_image_public_path: string | null; approved_product_id: number | null;
  created_at: string; updated_at: string;
};
type SuggestionLine = {
  id: number; line_order: number; proposed_base_item_id: number | null; proposed_base_item_name: string | null;
  quantity: string | number; extracted_requirement: string | null; match_confidence: string; source_type: string; rationale: string | null;
};

const analysisSchema = z.object({
  name: z.string().trim().min(2).max(150),
  description: z.string().trim().min(10).max(1200),
  visual_summary: z.string().trim().min(10).max(1800),
  components: z.array(z.object({
    requirement: z.string().trim().min(2).max(180),
    quantity: z.coerce.number().positive().max(500),
    notes: z.string().trim().max(400).optional().default(""),
  })).min(1).max(30),
  substitution_notes: z.array(z.string().trim().min(2).max(300)).max(20).default([]),
  box_color: z.enum(["black", "white", "blush_pink", "natural_kraft"]).default("black"),
  suggested_price_usd: z.coerce.number().nonnegative().max(100_000).default(0),
  suggested_price_aed: z.coerce.number().nonnegative().max(100_000).default(0),
});
type Analysis = z.infer<typeof analysisSchema>;

const createSchema = z.object({
  inspiration_image_path: z.string().trim().min(1).max(1000),
  style_profile_id: z.number().int().positive().optional(),
});
const patchSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  description: z.string().trim().max(1200).nullable().optional(),
  price_usd: z.coerce.number().nonnegative().max(100_000).optional(),
  price_aed: z.coerce.number().nonnegative().max(100_000).optional(),
  box_color: z.enum(["black", "white", "blush_pink", "natural_kraft"]).optional(),
  substitution_notes: z.string().trim().max(3000).nullable().optional(),
  recipe_items: z.array(z.object({
    base_item_id: z.number().int().positive(),
    quantity: z.coerce.number().positive().max(100_000),
    rationale: z.string().trim().max(1000).optional(),
  })).min(1).max(100).optional(),
});
const profileSchema = z.object({
  name: z.string().trim().min(2).max(100),
  prompt: z.string().trim().min(20).max(4000),
  reference_image_paths: z.array(z.string().trim().min(1).max(1000)).max(6).default([]),
  make_default: z.boolean().optional().default(false),
});

const DEFAULT_STYLE_PROMPT = `Presentail catalogue house style: create a premium, photorealistic studio product photograph for a modern Gulf floral gifting brand. The finished arrangement is the sole hero, centered and fully visible, photographed at a refined three-quarter angle in a clean editorial composition. Use realistic fresh botanicals with natural petal texture, subtle tonal variation, believable stems, careful proportion, and an intentional florist-built silhouette. Present it in a premium Presentail gift box in the selected box colour, with a discreet, correctly spelled Presentail wordmark printed directly on the box. Use a warm soft-ivory to very pale stone seamless background, natural diffused daylight from upper left, soft grounded shadow, accurate colour, gentle depth of field, and luxury ecommerce retouching. Keep the result elegant, calm, contemporary, and catalogue-ready. Do not add graphic overlays, extra copy, price tags, stickers, watermarks, floating text, people, hands, tools, or unrelated products.`;

function assertOwnedImagePaths(paths: string[], workspaceOwnerId: string): void {
  if (paths.some((path) => !ownedImagePath(path, workspaceOwnerId))) {
    throw new Error("Reference images must be private uploads in this workspace");
  }
}

function requireManagement(req: Request, res: Response): boolean {
  const wreq = workspace(req);
  if (wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes("products.manage")) return true;
  res.status(403).json({ error: "Bloomprint requires owner access or the Manage products permission" });
  return false;
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function ownedImagePath(path: string, workspaceOwnerId: string): boolean {
  return path.startsWith(`/objects/${workspaceOwnerId}/uploads/`);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchBaseItem(requirement: string, baseItems: BaseItem[]): BaseItem | null {
  const source = normalize(requirement);
  const sourceTokens = new Set(source.split(" ").filter((token) => token.length > 2));
  let winner: { item: BaseItem; score: number } | null = null;
  for (const item of baseItems) {
    const candidate = normalize(`${item.name} ${item.code ?? ""}`);
    if (candidate === source || candidate.includes(source) || source.includes(normalize(item.name))) {
      return item;
    }
    const candidateTokens = new Set(candidate.split(" ").filter((token) => token.length > 2));
    const overlap = [...sourceTokens].filter((token) => candidateTokens.has(token)).length;
    const score = sourceTokens.size === 0 ? 0 : overlap / sourceTokens.size;
    if (score >= 0.7 && (!winner || score > winner.score)) winner = { item, score };
  }
  return winner?.item ?? null;
}

async function ensureDefaultStyleProfile(workspaceOwnerId: string, userId: string | null): Promise<{ id: number; name: string; version: number; prompt: string; reference_image_paths: string[] }> {
  await db.query(
    `INSERT INTO bloomprint_style_profiles (workspace_owner_id, name, version, prompt, reference_image_paths, is_default, created_by_user_id)
     SELECT $1, 'Presentail floral catalogue', 1,
        $2, '[]'::jsonb, true, $3
     WHERE NOT EXISTS (SELECT 1 FROM bloomprint_style_profiles WHERE workspace_owner_id = $1)`,
    [workspaceOwnerId, DEFAULT_STYLE_PROMPT, userId],
  );
  const result = await db.query<{ id: number; name: string; version: number; prompt: string; reference_image_paths: string[] }>(
    `SELECT id, name, version, prompt, reference_image_paths FROM bloomprint_style_profiles
      WHERE workspace_owner_id = $1 ORDER BY is_default DESC, created_at DESC LIMIT 1`,
    [workspaceOwnerId],
  );
  return result.rows[0];
}

function resolveModelId(model: string, purpose: "vision analysis" | "image generation"): string {
  const supportedModels = purpose === "vision analysis"
    ? new Set<string>(BLOOMPRINT_VISION_MODELS)
    : new Set<string>(BLOOMPRINT_IMAGE_MODELS);
  if (!supportedModels.has(model)) {
    throw new Error(`Bloomprint ${purpose} model "${model}" is not supported by the configured OpenAI integration`);
  }
  return model;
}

async function activeBaseItems(workspaceOwnerId: string): Promise<BaseItem[]> {
  const result = await db.query<BaseItem>(
    `SELECT bi.id, bi.name, bi.code, COALESCE(bip.unit, 'unit') AS canonical_unit
       FROM base_items bi
       LEFT JOIN base_item_packages bip ON bip.base_item_id = bi.id
         AND bip.workspace_owner_id = bi.workspace_owner_id AND bip.is_default = true
      WHERE bi.workspace_owner_id = $1 AND COALESCE(bi.status, 'active') = 'active'
        AND bi.archived_at IS NULL
      ORDER BY bi.name ASC, bi.id ASC`,
    [workspaceOwnerId],
  );
  return result.rows;
}

async function analyzeInspiration(imagePath: string, workspaceOwnerId: string): Promise<Analysis> {
  const file = await objectStorageService.getObjectEntityFile(imagePath);
  const [metadataResponse, downloadResponse] = await Promise.all([file.getMetadata(), file.download()]);
  const metadata = metadataResponse[0] as unknown as { contentType?: string };
  const mime = String(metadata.contentType ?? "image/jpeg").split(";")[0];
  const buffer = Buffer.from(downloadResponse[0] as Buffer);
  if (!mime.startsWith("image/") || buffer.length === 0 || buffer.length > 12 * 1024 * 1024) {
    throw new Error("The inspiration image must be a valid image no larger than 12 MB");
  }
  const visionModel = resolveModelId(process.env.BLOOMPRINT_VISION_MODEL ?? "gpt-5.6-terra", "vision analysis");
  let response;
  try {
    response = await callAI({
      actionKey: "bloomprint.inspiration_analysis",
      surface: "bloomprint",
      provider: "openai",
      model: visionModel,
      sessionId: `workspace:${workspaceOwnerId}`,
      maxTokens: 8192,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `You are a florist and production planner. Analyze this inspiration arrangement and return JSON only:
{"name":"catalogue-safe short product name","description":"customer-ready description","visual_summary":"factual visual analysis","components":[{"requirement":"a buildable material or flower requirement, never invent an SKU","quantity":positive number,"notes":"brief evidence"}],"substitution_notes":["likely substitutions"],"box_color":"black|white|blush_pink|natural_kraft","suggested_price_usd":number,"suggested_price_aed":number}
Describe components conservatively. Include containers, filler, mechanics, and wrapping only when visually supported. Choose box_color from the listed values based on the arrangement and gifting aesthetic. Never claim an exact flower cultivar if the photo is ambiguous.` },
          { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" } },
        ],
      }],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown provider error";
    throw new Error(`Bloomprint vision analysis model "${visionModel}" is unavailable through the configured OpenAI integration: ${detail}`);
  }
  const content = response.choices[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The inspiration analysis returned an unreadable result");
  const parsed = analysisSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) throw new Error("The inspiration analysis did not contain a usable build plan");
  return parsed.data;
}

async function insertSuggestionLines(client: PoolClient, workspaceOwnerId: string, suggestionId: number, analysis: Analysis, baseItems: BaseItem[]): Promise<void> {
  for (const [lineOrder, component] of analysis.components.entries()) {
    const item = matchBaseItem(component.requirement, baseItems);
    await client.query(
      `INSERT INTO recipe_suggestion_lines (
        workspace_owner_id, suggestion_id, line_order, proposed_base_item_id, proposed_base_item_name,
        proposed_base_item_code, extracted_requirement, unit_context, source_evidence, match_confidence,
        quantity, confidence, source_type, rationale
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
      [
        workspaceOwnerId, suggestionId, lineOrder, item?.id ?? null, item?.name ?? null, item?.code ?? null,
        component.requirement, item?.canonical_unit ?? null,
        JSON.stringify([{ type: "bloomprint_vision", notes: component.notes }]),
        item ? "medium" : "no_match", component.quantity, item ? 0.7 : 0,
        item ? "bloomprint_match" : "unresolved",
        item ? "Matched conservatively against an active workspace Base Item." : "No safe existing Base Item match was found. Add or select one before approval.",
      ],
    );
  }
}

export function calculateBloomprintCostDerivedPrices(
  cogsUsd: number,
  markup: number,
  usdToAedRate: number,
  roundingRule: RoundingRule,
): { priceUsd: number; priceAed: number } {
  const priceUsd = applyRounding(cogsUsd * (1 + markup / 100), roundingRule);
  return { priceUsd, priceAed: applyRounding(priceUsd * usdToAedRate, roundingRule) };
}

async function deriveRecipePrices(
  workspaceOwnerId: string,
  analysis: Analysis,
  baseItems: BaseItem[],
): Promise<{ priceUsd: number; priceAed: number } | null> {
  const lines = analysis.components.map((component) => ({
    quantity: component.quantity,
    item: matchBaseItem(component.requirement, baseItems),
  }));
  if (lines.some((line) => !line.item)) return null;

  const ids = [...new Set(lines.map((line) => line.item!.id))];
  const supplierCosts = await db.query<{ base_item_id: number; price: string }>(
    `SELECT DISTINCT ON (base_item_id) base_item_id, price::text
       FROM base_item_suppliers
      WHERE workspace_owner_id = $1
        AND base_item_id = ANY($2::int[])
        AND is_preferred = true
        AND currency = 'USD'
        AND price IS NOT NULL
      ORDER BY base_item_id, created_at DESC`,
    [workspaceOwnerId, ids],
  );
  const costsByItem = new Map(supplierCosts.rows.map((row) => [row.base_item_id, Number(row.price)]));
  if (costsByItem.size !== ids.length || [...costsByItem.values()].some((cost) => !Number.isFinite(cost) || cost < 0)) {
    return null;
  }

  const settings = await db.query<{ default_markup_percentage: string; rounding_rule: string }>(
    `SELECT default_markup_percentage::text, rounding_rule
       FROM exchange_rate_settings WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  const markup = Math.max(0, Number(settings.rows[0]?.default_markup_percentage ?? 0));
  const roundingRule = (settings.rows[0]?.rounding_rule ?? "round_up_whole") as RoundingRule;
  const cogsUsd = lines.reduce((total, line) => total + line.quantity * costsByItem.get(line.item!.id)!, 0);

  const usdToAed = await getStoredRate("USD", "AED", "__global__");
  if (!usdToAed) return null;
  return calculateBloomprintCostDerivedPrices(cogsUsd, markup, usdToAed.rate, roundingRule);
}

async function loadPrivateReferenceImage(path: string): Promise<{ bytes: Buffer; mimeType: "image/jpeg" | "image/png" | "image/webp" }> {
  const file = await objectStorageService.getObjectEntityFile(path);
  const [metadataResponse, downloadResponse] = await Promise.all([file.getMetadata(), file.download()]);
  const contentType = String((metadataResponse[0] as { contentType?: string }).contentType ?? "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    throw new Error("Style reference images must be JPEG, PNG, or WebP files");
  }
  const bytes = Buffer.from(downloadResponse[0] as Buffer);
  if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) {
    throw new Error("Each style reference image must be between 1 byte and 12 MB");
  }
  return { bytes, mimeType: contentType as "image/jpeg" | "image/png" | "image/webp" };
}

async function draftDetail(id: number, workspaceOwnerId: string) {
  const draftResult = await db.query<DraftRow>(
    `SELECT * FROM bloomprint_drafts WHERE id = $1 AND workspace_owner_id = $2`,
    [id, workspaceOwnerId],
  );
  const draft = draftResult.rows[0];
  if (!draft) return null;
  const [lines, attempts] = await Promise.all([
    draft.recipe_suggestion_id == null ? Promise.resolve({ rows: [] as SuggestionLine[] }) : db.query<SuggestionLine>(
      `SELECT id, line_order, proposed_base_item_id, proposed_base_item_name, quantity,
              extracted_requirement, match_confidence, source_type, rationale
         FROM recipe_suggestion_lines WHERE suggestion_id = $1 AND workspace_owner_id = $2
         ORDER BY line_order ASC, id ASC`,
      [draft.recipe_suggestion_id, workspaceOwnerId],
    ),
    db.query(`SELECT id, status, model, generation_mode, reference_image_count, output_image_path, error_message, created_at, completed_at
                FROM bloomprint_render_attempts WHERE draft_id = $1 AND workspace_owner_id = $2
                ORDER BY created_at DESC`, [id, workspaceOwnerId]),
  ]);
  return { draft, recipe_lines: lines.rows, render_attempts: attempts.rows };
}

router.get("/bloomprint/style-profiles", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const wreq = workspace(req);
  await ensureDefaultStyleProfile(wreq.workspaceOwnerId, wreq.userId ?? null);
  const profiles = await db.query(
    `SELECT id, name, version, prompt, reference_image_paths, is_default, created_at FROM bloomprint_style_profiles
      WHERE workspace_owner_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ profiles: profiles.rows });
});

router.post("/bloomprint/style-profiles", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid style profile", details: parsed.error.issues }); return; }
  const wreq = workspace(req);
  try {
    assertOwnedImagePaths(parsed.data.reference_image_paths, wreq.workspaceOwnerId);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid reference image paths" });
    return;
  }
  const versionResult = await db.query<{ version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS version FROM bloomprint_style_profiles
      WHERE workspace_owner_id = $1 AND name = $2`,
    [wreq.workspaceOwnerId, parsed.data.name],
  );
  if (parsed.data.make_default) {
    await db.query(`UPDATE bloomprint_style_profiles SET is_default = false WHERE workspace_owner_id = $1`, [wreq.workspaceOwnerId]);
  }
  const created = await db.query(
    `INSERT INTO bloomprint_style_profiles (workspace_owner_id, name, version, prompt, reference_image_paths, is_default, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING id, name, version, prompt, reference_image_paths, is_default, created_at`,
    [wreq.workspaceOwnerId, parsed.data.name, versionResult.rows[0].version, parsed.data.prompt,
      JSON.stringify(parsed.data.reference_image_paths), parsed.data.make_default, wreq.userId ?? null],
  );
  res.status(201).json({ profile: created.rows[0] });
});

router.get("/bloomprint/drafts", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const wreq = workspace(req);
  const result = await db.query(
    `SELECT id, name, status, inspiration_image_path, generated_image_path, approved_product_id, created_at, updated_at
       FROM bloomprint_drafts WHERE workspace_owner_id = $1 AND status != 'discarded'
       ORDER BY updated_at DESC, id DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ drafts: result.rows });
});

router.post("/bloomprint/drafts", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid Bloomprint draft", details: parsed.error.issues }); return; }
  const wreq = workspace(req);
  if (!ownedImagePath(parsed.data.inspiration_image_path, wreq.workspaceOwnerId)) {
    res.status(400).json({ error: "The inspiration image must be a private upload in this workspace" }); return;
  }
  let style = await ensureDefaultStyleProfile(wreq.workspaceOwnerId, wreq.userId ?? null);
  if (parsed.data.style_profile_id) {
    const profile = await db.query<typeof style>(
      `SELECT id, name, version, prompt, reference_image_paths FROM bloomprint_style_profiles WHERE id = $1 AND workspace_owner_id = $2`,
      [parsed.data.style_profile_id, wreq.workspaceOwnerId],
    );
    if (!profile.rows[0]) { res.status(400).json({ error: "Style profile not found in this workspace" }); return; }
    style = profile.rows[0];
  }
  let analysis: Analysis;
  try {
    analysis = await analyzeInspiration(parsed.data.inspiration_image_path, wreq.workspaceOwnerId);
  } catch (error) {
    const failed = await db.query(
      `INSERT INTO bloomprint_drafts (workspace_owner_id, inspiration_image_path, style_profile_id, status, analysis, created_by_user_id)
       VALUES ($1,$2,$3,'analysis_failed',$4::jsonb,$5) RETURNING *`,
      [wreq.workspaceOwnerId, parsed.data.inspiration_image_path, style.id, JSON.stringify({ error: error instanceof Error ? error.message : "Analysis failed" }), wreq.userId ?? null],
    );
    res.status(422).json({ error: error instanceof Error ? error.message : "Analysis failed", draft: failed.rows[0] }); return;
  }
  const baseItems = await activeBaseItems(wreq.workspaceOwnerId);
  const costDerivedPrices = await deriveRecipePrices(wreq.workspaceOwnerId, analysis, baseItems);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const draftResult = await client.query<{ id: number }>(
      `INSERT INTO bloomprint_drafts (
         workspace_owner_id, inspiration_image_path, analysis, name, description, price_usd, price_aed, box_color,
         substitution_notes, status, style_profile_id, created_by_user_id
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,'draft',$10,$11) RETURNING id`,
      [wreq.workspaceOwnerId, parsed.data.inspiration_image_path, JSON.stringify(analysis), analysis.name, analysis.description,
        costDerivedPrices?.priceUsd ?? analysis.suggested_price_usd,
        costDerivedPrices?.priceAed ?? analysis.suggested_price_aed,
        analysis.box_color, analysis.substitution_notes.join("\n"), style.id, wreq.userId ?? null],
    );
    const draftId = draftResult.rows[0].id;
    const suggestionResult = await client.query<{ id: number }>(
      `INSERT INTO recipe_suggestions (workspace_owner_id, product_id, version, status, generation_context, confidence, rationale, created_by_user_id)
       VALUES ($1,NULL,1,'generated',$2::jsonb,0.7,$3,$4) RETURNING id`,
      [wreq.workspaceOwnerId, JSON.stringify({ bloomprint_draft_id: draftId, analysis }), "Bloomprint photo analysis; review each Base Item before approval.", wreq.userId ?? null],
    );
    await insertSuggestionLines(client, wreq.workspaceOwnerId, suggestionResult.rows[0].id, analysis, baseItems);
    await client.query(
      `UPDATE bloomprint_drafts SET recipe_suggestion_id = $1 WHERE id = $2 AND workspace_owner_id = $3`,
      [suggestionResult.rows[0].id, draftId, wreq.workspaceOwnerId],
    );
    await client.query("COMMIT");
    const detail = await draftDetail(draftId, wreq.workspaceOwnerId);
    res.status(201).json(detail);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

router.get("/bloomprint/drafts/:id", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const detail = await draftDetail(id, workspace(req).workspaceOwnerId);
  if (!detail) { res.status(404).json({ error: "Bloomprint draft not found" }); return; }
  res.json(detail);
});

router.patch("/bloomprint/drafts/:id", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const id = parseId(req.params.id);
  const parsed = patchSchema.safeParse(req.body);
  if (!id || !parsed.success) { res.status(400).json({ error: "Invalid Bloomprint draft edit", details: parsed.success ? undefined : parsed.error.issues }); return; }
  const wreq = workspace(req);
  const existing = await draftDetail(id, wreq.workspaceOwnerId);
  if (!existing) { res.status(404).json({ error: "Bloomprint draft not found" }); return; }
  if (["approved", "discarded"].includes(existing.draft.status)) { res.status(409).json({ error: "This Bloomprint draft is no longer editable" }); return; }
  const data = parsed.data;
  await db.query(
    `UPDATE bloomprint_drafts SET name = COALESCE($1,name), description = COALESCE($2,description),
       price_usd = COALESCE($3,price_usd), price_aed = COALESCE($4,price_aed),
       box_color = COALESCE($5,box_color), substitution_notes = COALESCE($6,substitution_notes), updated_at = now()
     WHERE id = $7 AND workspace_owner_id = $8`,
    [data.name ?? null, data.description ?? null, data.price_usd ?? null, data.price_aed ?? null,
      data.box_color ?? null, data.substitution_notes ?? null, id, wreq.workspaceOwnerId],
  );
  if (data.recipe_items && existing.draft.recipe_suggestion_id) {
    const itemIds = [...new Set(data.recipe_items.map((item) => item.base_item_id))];
    const items = await activeBaseItems(wreq.workspaceOwnerId);
    const byId = new Map(items.map((item) => [item.id, item]));
    if (itemIds.some((itemId) => !byId.has(itemId))) { res.status(400).json({ error: "Each recipe item must be an active Base Item in this workspace" }); return; }
  const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM recipe_suggestion_lines WHERE suggestion_id = $1 AND workspace_owner_id = $2`, [existing.draft.recipe_suggestion_id, wreq.workspaceOwnerId]);
      for (const [index, line] of data.recipe_items.entries()) {
        const item = byId.get(line.base_item_id)!;
        await client.query(
          `INSERT INTO recipe_suggestion_lines (
             workspace_owner_id, suggestion_id, line_order, proposed_base_item_id, proposed_base_item_name,
             proposed_base_item_code, extracted_requirement, unit_context, source_evidence, match_confidence,
             quantity, confidence, source_type, rationale
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'high',$10,0.95,'reviewer_edit',$11)`,
          [wreq.workspaceOwnerId, existing.draft.recipe_suggestion_id, index, item.id, item.name, item.code, item.name,
            item.canonical_unit, JSON.stringify([{ type: "reviewer_edit", actor_user_id: wreq.userId ?? null }]), line.quantity,
            line.rationale ?? "Bloomprint recipe reviewed by a workspace manager."],
        );
      }
      await client.query(`UPDATE recipe_suggestions SET status = 'under_review' WHERE id = $1 AND workspace_owner_id = $2`, [existing.draft.recipe_suggestion_id, wreq.workspaceOwnerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  res.json(await draftDetail(id, wreq.workspaceOwnerId));
});

router.post("/bloomprint/drafts/:id/render", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const wreq = workspace(req);
  const detail = await draftDetail(id, wreq.workspaceOwnerId);
  if (!detail) { res.status(404).json({ error: "Bloomprint draft not found" }); return; }
  if (["approved", "discarded"].includes(detail.draft.status)) { res.status(409).json({ error: "This Bloomprint draft cannot be rendered" }); return; }
  if (detail.recipe_lines.length === 0 || detail.recipe_lines.some((line) => line.proposed_base_item_id == null || line.match_confidence === "no_match" || line.source_type === "unresolved")) {
    res.status(422).json({ error: "Resolve every recipe line with an active Base Item before rendering" }); return;
  }
  const selectedBaseItemIds = [...new Set(detail.recipe_lines.map((line) => line.proposed_base_item_id!))];
  const activeBaseItems = await db.query<{ id: number }>(
    `SELECT id FROM base_items WHERE id = ANY($1::int[]) AND workspace_owner_id = $2
      AND COALESCE(status, 'active') = 'active' AND archived_at IS NULL`,
    [selectedBaseItemIds, wreq.workspaceOwnerId],
  );
  if (activeBaseItems.rows.length !== selectedBaseItemIds.length) {
    res.status(422).json({ error: "One or more recipe Base Items are no longer active. Select an active replacement before rendering." }); return;
  }
  const style = await db.query<{ prompt: string; reference_image_paths: unknown }>(
    `SELECT prompt, reference_image_paths FROM bloomprint_style_profiles WHERE id = $1 AND workspace_owner_id = $2`,
    [detail.draft.style_profile_id, wreq.workspaceOwnerId],
  );
  if (!style.rows[0]) {
    res.status(409).json({ error: "The draft's style profile is no longer available. Select or recreate a style profile before rendering." });
    return;
  }
  const referencePaths = Array.isArray(style.rows[0].reference_image_paths)
    ? style.rows[0].reference_image_paths.filter((path): path is string => typeof path === "string")
    : [];
  try {
    assertOwnedImagePaths(referencePaths, wreq.workspaceOwnerId);
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : "Invalid style profile reference images" });
    return;
  }
  const generationMode = referencePaths.length > 0 ? "reference_edit" : "text_only";
  const ingredients = detail.recipe_lines.map((line) => `${line.quantity} × ${line.proposed_base_item_name}`).join(", ");
  const prompt = `${style.rows[0].prompt}
Product: ${detail.draft.name ?? "Floral arrangement"}.
Description: ${detail.draft.description ?? ""}.
Buildable recipe: ${ingredients}.
Visual inspiration: ${String(detail.draft.analysis.visual_summary ?? "")}.
Selected Presentail box colour: ${detail.draft.box_color ?? "black"}.
Render only the finished arrangement as a clean ecommerce product photograph. The Presentail wordmark may appear only as a subtle printed mark on the gift box. Do not add graphic overlays, price labels, watermarks, people, hands, or additional products.`;
  const imageModelCandidate = process.env.BLOOMPRINT_IMAGE_MODEL ?? "gpt-image-1";
  const attempt = await db.query<{ id: number }>(
    `INSERT INTO bloomprint_render_attempts (
       workspace_owner_id, draft_id, status, model, generation_mode, reference_image_count, prompt
     ) VALUES ($1,$2,'started',$3,$4,$5,$6) RETURNING id`,
    [wreq.workspaceOwnerId, id, imageModelCandidate, generationMode, referencePaths.length, prompt],
  );
  try {
    const imageModel = resolveModelId(imageModelCandidate, "image generation");
    const image = await callAI({
      actionKey: referencePaths.length > 0 ? "bloomprint.image_edit" : "bloomprint.image_generation",
      surface: "bloomprint",
      provider: "openai",
      api: "image",
      model: imageModel,
      sessionId: `workspace:${wreq.workspaceOwnerId}`,
      call: async () => referencePaths.length > 0
        ? editImageBuffers(
            await Promise.all(referencePaths.map(loadPrivateReferenceImage)),
            prompt,
            imageModel,
            { size: BLOOMPRINT_IMAGE_SIZE, quality: BLOOMPRINT_IMAGE_QUALITY },
          )
        : generateImageBuffer(prompt, BLOOMPRINT_IMAGE_SIZE, imageModel, {
            quality: BLOOMPRINT_IMAGE_QUALITY,
          }),
    });
    if (image.length === 0) throw new Error("The image generator returned an empty image");
    const imagePath = await objectStorageService.savePrivateObject(wreq.workspaceOwnerId, image, "image/png");
    await db.query(
      `UPDATE bloomprint_render_attempts SET status = 'succeeded', model = $1, output_image_path = $2, completed_at = now()
        WHERE id = $3 AND workspace_owner_id = $4`,
      [imageModel, imagePath, attempt.rows[0].id, wreq.workspaceOwnerId],
    );
    await db.query(
      `UPDATE bloomprint_drafts SET generated_image_path = $1, status = 'rendered', updated_at = now()
        WHERE id = $2 AND workspace_owner_id = $3`,
      [imagePath, id, wreq.workspaceOwnerId],
    );
    res.json(await draftDetail(id, wreq.workspaceOwnerId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Image rendering failed";
    logger.warn({ draftId: id, err: error }, "Bloomprint render attempt failed");
    await db.query(
      `UPDATE bloomprint_render_attempts SET status = 'failed', error_message = $1, completed_at = now()
        WHERE id = $2 AND workspace_owner_id = $3`,
      [message, attempt.rows[0].id, wreq.workspaceOwnerId],
    );
    await db.query(`UPDATE bloomprint_drafts SET status = 'render_failed', updated_at = now() WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
    res.status(502).json({ error: message });
  }
});

router.post("/bloomprint/drafts/:id/approve", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const wreq = workspace(req);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const draftResult = await client.query<DraftRow>(
      `SELECT * FROM bloomprint_drafts WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
      [id, wreq.workspaceOwnerId],
    );
    const draft = draftResult.rows[0];
    if (!draft) { await client.query("ROLLBACK"); res.status(404).json({ error: "Bloomprint draft not found" }); return; }
    if (draft.status === "approved" || draft.approved_product_id) { await client.query("ROLLBACK"); res.status(409).json({ error: "This Bloomprint draft has already been approved" }); return; }
    if (!draft.generated_image_path) { await client.query("ROLLBACK"); res.status(422).json({ error: "Render a catalogue image after completing the recipe before approval" }); return; }
    const lines = await client.query<SuggestionLine>(
      `SELECT id, line_order, proposed_base_item_id, proposed_base_item_name, quantity, extracted_requirement,
              match_confidence, source_type, rationale FROM recipe_suggestion_lines
        WHERE suggestion_id = $1 AND workspace_owner_id = $2 ORDER BY line_order ASC, id ASC`,
      [draft.recipe_suggestion_id, wreq.workspaceOwnerId],
    );
    if (lines.rows.length === 0 || lines.rows.some((line) => line.proposed_base_item_id == null || line.match_confidence === "no_match" || line.source_type === "unresolved")) {
      await client.query("ROLLBACK"); res.status(422).json({ error: "Resolve every recipe line before approval" }); return;
    }
    const ids = [...new Set(lines.rows.map((line) => line.proposed_base_item_id!))];
    const available = await client.query<{ id: number }>(
      `SELECT id FROM base_items WHERE id = ANY($1::int[]) AND workspace_owner_id = $2
        AND COALESCE(status, 'active') = 'active' AND archived_at IS NULL`,
      [ids, wreq.workspaceOwnerId],
    );
    if (available.rows.length !== ids.length) { await client.query("ROLLBACK"); res.status(400).json({ error: "One or more final Base Items are no longer available" }); return; }
    const productResult = await client.query<{ id: number }>(
      `INSERT INTO products (
        workspace_owner_id, name, price_usd, price_aed, main_image_url, description, status, tags, sku,
        express_delivery_enabled, merchant_sync_disabled, inventory_tracked
      ) VALUES ($1,$2,$3,$4,$5,$6,'not_available',ARRAY['bloomprint'], $7, false, true, true) RETURNING id`,
      [wreq.workspaceOwnerId, draft.name ?? "Bloomprint arrangement", Number(draft.price_usd ?? 0), Number(draft.price_aed ?? 0),
        draft.generated_image_path, draft.description, `BP-${id}-${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    const productId = productResult.rows[0].id;
    const publicPath = await objectStorageService.copyPrivateObjectToPublic(draft.generated_image_path, `products/${productId}/main`, wreq.workspaceOwnerId);
    await client.query(`UPDATE products SET image_public_path = $1 WHERE id = $2 AND workspace_owner_id = $3`, [publicPath, productId, wreq.workspaceOwnerId]);
    const consolidated = new Map<number, { quantity: number; sort: number }>();
    for (const line of lines.rows) {
      const baseItemId = line.proposed_base_item_id!;
      const previous = consolidated.get(baseItemId);
      consolidated.set(baseItemId, { quantity: (previous?.quantity ?? 0) + Number(line.quantity), sort: previous?.sort ?? line.line_order });
    }
    for (const [baseItemId, value] of consolidated.entries()) {
      await client.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [wreq.workspaceOwnerId, productId, baseItemId, value.quantity, value.sort],
      );
    }
    await client.query(`UPDATE recipe_suggestions SET product_id = $1, status = 'approved' WHERE id = $2 AND workspace_owner_id = $3`, [productId, draft.recipe_suggestion_id, wreq.workspaceOwnerId]);
    await client.query(
      `UPDATE bloomprint_drafts SET status = 'approved', approved_product_id = $1, generated_image_public_path = $2, updated_at = now()
       WHERE id = $3 AND workspace_owner_id = $4`,
      [productId, publicPath, id, wreq.workspaceOwnerId],
    );
    await client.query("COMMIT");
    res.status(201).json({ product_id: productId, draft: (await draftDetail(id, wreq.workspaceOwnerId))?.draft });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
});

router.delete("/bloomprint/drafts/:id", async (req, res): Promise<void> => {
  if (!requireManagement(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid draft id" }); return; }
  const result = await db.query(
    `UPDATE bloomprint_drafts SET status = 'discarded', updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND status != 'approved' RETURNING id`,
    [id, workspace(req).workspaceOwnerId],
  );
  if (!result.rows[0]) { res.status(409).json({ error: "Draft cannot be discarded" }); return; }
  res.json({ discarded: true });
});

export default router;
