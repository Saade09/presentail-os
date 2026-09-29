import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * Returns true if the caller is a workspace owner OR has "coupons" in their
 * allowed pages.
 */
function canManageCoupons(wreq: ReturnType<typeof workspace>): boolean {
  if (wreq.workspaceRole === "owner") return true;
  return Array.isArray(wreq.allowedPages) && wreq.allowedPages.includes("coupons");
}

const ATTRIBUTE_TABLES = {
  occasion: "occasions",
  category: "catalog_categories",
  brand: "catalog_brands",
  recipient: "recipients",
} as const;

type AttributeType = keyof typeof ATTRIBUTE_TABLES;

type CouponRow = {
  id: string;
  workspace_owner_id: string;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: string;
  min_order_usd: string | null;
  scope: string;
  starts_at: string | null;
  expires_at: string | null;
  per_user_limit: number | null;
  global_limit: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const couponResponseSchema = z.object({
  id: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  discountType: z.enum(["percentage", "fixed"]),
  discountValue: z.number(),
  minOrderUsd: z.number().nullable(),
  scope: z.enum(["all", "restricted"]),
  startsAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  perUserLimit: z.number().int().nullable(),
  globalLimit: z.number().int().nullable(),
  isActive: z.boolean(),
  usedCount: z.number().int(),
  productIds: z.array(z.number().int()),
  occasionIds: z.array(z.number().int()),
  categoryIds: z.array(z.number().int()),
  brandIds: z.array(z.number().int()),
  recipientIds: z.array(z.number().int()),
  excludedProductIds: z.array(z.number().int()),
  excludedOccasionIds: z.array(z.number().int()),
  excludedCategoryIds: z.array(z.number().int()),
  excludedBrandIds: z.array(z.number().int()),
  excludedRecipientIds: z.array(z.number().int()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const couponsListResponseSchema = z.object({
  coupons: z.array(couponResponseSchema),
});

const singleCouponResponseSchema = z.object({
  coupon: couponResponseSchema,
});

type CouponResponse = z.infer<typeof couponResponseSchema>;

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error({ err: parsed.error.issues, route }, "Response validation failed");
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

function toNumberOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Assembles full coupon response objects (with restrictions + usage counts) for
 * the given coupon rows. Issues batched lookups across all coupon ids.
 */
async function assembleCoupons(rows: CouponRow[]): Promise<CouponResponse[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [products, attrs, exclProducts, exclAttrs, usage] = await Promise.all([
    db.query<{ coupon_id: string; product_id: number }>(
      `SELECT coupon_id, product_id FROM coupon_products WHERE coupon_id = ANY($1)`,
      [ids],
    ),
    db.query<{ coupon_id: string; attribute_type: string; attribute_id: number }>(
      `SELECT coupon_id, attribute_type, attribute_id FROM coupon_attributes WHERE coupon_id = ANY($1)`,
      [ids],
    ),
    db.query<{ coupon_id: string; product_id: number }>(
      `SELECT coupon_id, product_id FROM coupon_excluded_products WHERE coupon_id = ANY($1)`,
      [ids],
    ),
    db.query<{ coupon_id: string; attribute_type: string; attribute_id: number }>(
      `SELECT coupon_id, attribute_type, attribute_id FROM coupon_excluded_attributes WHERE coupon_id = ANY($1)`,
      [ids],
    ),
    db.query<{ coupon_id: string; used_count: string }>(
      `SELECT coupon_id, COUNT(*)::text AS used_count
         FROM coupon_redemptions
        WHERE coupon_id = ANY($1) AND status = 'confirmed'
        GROUP BY coupon_id`,
      [ids],
    ),
  ]);

  const productMap = new Map<string, number[]>();
  for (const r of products.rows) {
    const arr = productMap.get(r.coupon_id) ?? [];
    arr.push(r.product_id);
    productMap.set(r.coupon_id, arr);
  }
  const attrMap = new Map<string, Record<AttributeType, number[]>>();
  for (const r of attrs.rows) {
    const entry =
      attrMap.get(r.coupon_id) ?? { occasion: [], category: [], brand: [], recipient: [] };
    if (r.attribute_type in ATTRIBUTE_TABLES) {
      entry[r.attribute_type as AttributeType].push(r.attribute_id);
    }
    attrMap.set(r.coupon_id, entry);
  }
  const exclProductMap = new Map<string, number[]>();
  for (const r of exclProducts.rows) {
    const arr = exclProductMap.get(r.coupon_id) ?? [];
    arr.push(r.product_id);
    exclProductMap.set(r.coupon_id, arr);
  }
  const exclAttrMap = new Map<string, Record<AttributeType, number[]>>();
  for (const r of exclAttrs.rows) {
    const entry =
      exclAttrMap.get(r.coupon_id) ?? { occasion: [], category: [], brand: [], recipient: [] };
    if (r.attribute_type in ATTRIBUTE_TABLES) {
      entry[r.attribute_type as AttributeType].push(r.attribute_id);
    }
    exclAttrMap.set(r.coupon_id, entry);
  }
  const usageMap = new Map<string, number>();
  for (const r of usage.rows) usageMap.set(r.coupon_id, Number(r.used_count));

  return rows.map((r) => {
    const attr = attrMap.get(r.id) ?? { occasion: [], category: [], brand: [], recipient: [] };
    const exclAttr = exclAttrMap.get(r.id) ?? { occasion: [], category: [], brand: [], recipient: [] };
    return {
      id: r.id,
      code: r.code,
      description: r.description,
      discountType: r.discount_type === "fixed" ? "fixed" : "percentage",
      discountValue: Number(r.discount_value),
      minOrderUsd: toNumberOrNull(r.min_order_usd),
      scope: r.scope === "restricted" ? "restricted" : "all",
      startsAt: toIso(r.starts_at),
      expiresAt: toIso(r.expires_at),
      perUserLimit: r.per_user_limit,
      globalLimit: r.global_limit,
      isActive: r.is_active,
      usedCount: usageMap.get(r.id) ?? 0,
      productIds: productMap.get(r.id) ?? [],
      occasionIds: attr.occasion,
      categoryIds: attr.category,
      brandIds: attr.brand,
      recipientIds: attr.recipient,
      excludedProductIds: exclProductMap.get(r.id) ?? [],
      excludedOccasionIds: exclAttr.occasion,
      excludedCategoryIds: exclAttr.category,
      excludedBrandIds: exclAttr.brand,
      excludedRecipientIds: exclAttr.recipient,
      createdAt: toIso(r.created_at) ?? new Date(0).toISOString(),
      updatedAt: toIso(r.updated_at) ?? new Date(0).toISOString(),
    } satisfies CouponResponse;
  });
}

/**
 * Filters the given attribute ids down to those that actually exist in the
 * matching attribute table for this workspace.
 */
async function validateAttributeIds(
  type: AttributeType,
  ids: number[],
  ownerId: string,
): Promise<number[]> {
  if (ids.length === 0) return [];
  const table = ATTRIBUTE_TABLES[type];
  const r = await db.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE id = ANY($1) AND workspace_owner_id = $2`,
    [ids, ownerId],
  );
  return r.rows.map((x) => x.id);
}

/**
 * Replaces the product + attribute restriction rows for a coupon. Only touches
 * a restriction set when its field is present (non-null) in the parsed body.
 */
async function writeRestrictions(
  couponId: string,
  ownerId: string,
  body: CouponWriteBody,
): Promise<void> {
  if (body.productIds !== undefined) {
    let valid: number[] = [];
    if (body.productIds.length > 0) {
      const r = await db.query<{ id: number }>(
        `SELECT id FROM products WHERE id = ANY($1) AND workspace_owner_id = $2`,
        [body.productIds, ownerId],
      );
      valid = r.rows.map((x) => x.id);
    }
    await db.query(`DELETE FROM coupon_products WHERE coupon_id = $1`, [couponId]);
    for (const pid of valid) {
      await db.query(
        `INSERT INTO coupon_products (coupon_id, product_id) VALUES ($1, $2)
         ON CONFLICT (coupon_id, product_id) DO NOTHING`,
        [couponId, pid],
      );
    }
  }

  const attrFields: [AttributeType, number[] | undefined][] = [
    ["occasion", body.occasionIds],
    ["category", body.categoryIds],
    ["brand", body.brandIds],
    ["recipient", body.recipientIds],
  ];
  for (const [type, ids] of attrFields) {
    if (ids === undefined) continue;
    const valid = await validateAttributeIds(type, ids, ownerId);
    await db.query(
      `DELETE FROM coupon_attributes WHERE coupon_id = $1 AND attribute_type = $2`,
      [couponId, type],
    );
    for (const aid of valid) {
      await db.query(
        `INSERT INTO coupon_attributes (coupon_id, attribute_type, attribute_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (coupon_id, attribute_type, attribute_id) DO NOTHING`,
        [couponId, type, aid],
      );
    }
  }
}

const idArray = z.array(z.number().int().positive()).transform((arr) => Array.from(new Set(arr)));

const createCouponSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    description: z.string().trim().max(500).nullish(),
    discountType: z.enum(["percentage", "fixed"]),
    discountValue: z.number().positive(),
    minOrderUsd: z.number().nonnegative().nullish(),
    scope: z.enum(["all", "restricted"]).default("all"),
    startsAt: z.string().datetime().nullish(),
    expiresAt: z.string().datetime().nullish(),
    perUserLimit: z.number().int().positive().nullish(),
    globalLimit: z.number().int().positive().nullish(),
    isActive: z.boolean().default(true),
    productIds: idArray.optional(),
    occasionIds: idArray.optional(),
    categoryIds: idArray.optional(),
    brandIds: idArray.optional(),
    recipientIds: idArray.optional(),
    excludedProductIds: idArray.optional(),
    excludedOccasionIds: idArray.optional(),
    excludedCategoryIds: idArray.optional(),
    excludedBrandIds: idArray.optional(),
    excludedRecipientIds: idArray.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.discountType === "percentage" && val.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Percentage discount cannot exceed 100",
      });
    }
    if (val.startsAt && val.expiresAt && new Date(val.expiresAt) <= new Date(val.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Expiry must be after the start date",
      });
    }
  });

const updateCouponSchema = z
  .object({
    code: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().max(500).nullish(),
    discountType: z.enum(["percentage", "fixed"]).optional(),
    discountValue: z.number().positive().optional(),
    minOrderUsd: z.number().nonnegative().nullish(),
    scope: z.enum(["all", "restricted"]).optional(),
    startsAt: z.string().datetime().nullish(),
    expiresAt: z.string().datetime().nullish(),
    perUserLimit: z.number().int().positive().nullish(),
    globalLimit: z.number().int().positive().nullish(),
    isActive: z.boolean().optional(),
    productIds: idArray.optional(),
    occasionIds: idArray.optional(),
    categoryIds: idArray.optional(),
    brandIds: idArray.optional(),
    recipientIds: idArray.optional(),
    excludedProductIds: idArray.optional(),
    excludedOccasionIds: idArray.optional(),
    excludedCategoryIds: idArray.optional(),
    excludedBrandIds: idArray.optional(),
    excludedRecipientIds: idArray.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.discountType === "percentage" && val.discountValue !== undefined && val.discountValue > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discountValue"],
        message: "Percentage discount cannot exceed 100",
      });
    }
    if (val.startsAt && val.expiresAt && new Date(val.expiresAt) <= new Date(val.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Expiry must be after the start date",
      });
    }
  });

type CouponWriteBody = {
  productIds?: number[];
  occasionIds?: number[];
  categoryIds?: number[];
  brandIds?: number[];
  recipientIds?: number[];
  excludedProductIds?: number[];
  excludedOccasionIds?: number[];
  excludedCategoryIds?: number[];
  excludedBrandIds?: number[];
  excludedRecipientIds?: number[];
};

/**
 * Replaces the exclusion rows for a coupon. Only touches a set when its field
 * is present (non-undefined) in the parsed body — same pattern as writeRestrictions.
 */
async function writeExclusions(
  couponId: string,
  ownerId: string,
  body: CouponWriteBody,
): Promise<void> {
  if (body.excludedProductIds !== undefined) {
    let valid: number[] = [];
    if (body.excludedProductIds.length > 0) {
      const r = await db.query<{ id: number }>(
        `SELECT id FROM products WHERE id = ANY($1) AND workspace_owner_id = $2`,
        [body.excludedProductIds, ownerId],
      );
      valid = r.rows.map((x) => x.id);
    }
    await db.query(`DELETE FROM coupon_excluded_products WHERE coupon_id = $1`, [couponId]);
    for (const pid of valid) {
      await db.query(
        `INSERT INTO coupon_excluded_products (coupon_id, product_id) VALUES ($1, $2)
         ON CONFLICT (coupon_id, product_id) DO NOTHING`,
        [couponId, pid],
      );
    }
  }

  const exclAttrFields: [AttributeType, number[] | undefined][] = [
    ["occasion", body.excludedOccasionIds],
    ["category", body.excludedCategoryIds],
    ["brand", body.excludedBrandIds],
    ["recipient", body.excludedRecipientIds],
  ];
  for (const [type, ids] of exclAttrFields) {
    if (ids === undefined) continue;
    const valid = await validateAttributeIds(type, ids, ownerId);
    await db.query(
      `DELETE FROM coupon_excluded_attributes WHERE coupon_id = $1 AND attribute_type = $2`,
      [couponId, type],
    );
    for (const aid of valid) {
      await db.query(
        `INSERT INTO coupon_excluded_attributes (coupon_id, attribute_type, attribute_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (coupon_id, attribute_type, attribute_id) DO NOTHING`,
        [couponId, type, aid],
      );
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * GET /api/coupons — list all coupons for the workspace.
 */
router.get("/coupons", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCoupons(wreq)) {
    res.status(403).json({ error: "Access denied: coupons not in your role permissions" });
    return;
  }
  const result = await db.query<CouponRow>(
    `SELECT * FROM coupons WHERE workspace_owner_id = $1 ORDER BY created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  const coupons = await assembleCoupons(result.rows);
  sendValidated(req, res, couponsListResponseSchema, { coupons }, "GET /coupons");
});

/**
 * GET /api/coupons/:id — single coupon detail.
 */
router.get("/coupons/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCoupons(wreq)) {
    res.status(403).json({ error: "Access denied: coupons not in your role permissions" });
    return;
  }
  const result = await db.query<CouponRow>(
    `SELECT * FROM coupons WHERE id = $1 AND workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }
  const [coupon] = await assembleCoupons(result.rows);
  sendValidated(req, res, singleCouponResponseSchema, { coupon }, "GET /coupons/:id");
});

/**
 * POST /api/coupons — create a coupon.
 */
router.post("/coupons", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCoupons(wreq)) {
    res.status(403).json({ error: "Access denied: coupons not in your role permissions" });
    return;
  }
  const parsed = createCouponSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
    return;
  }
  const b = parsed.data;

  let inserted: CouponRow;
  try {
    const r = await db.query<CouponRow>(
      `INSERT INTO coupons
         (workspace_owner_id, code, description, discount_type, discount_value,
          min_order_usd, scope, starts_at, expires_at, per_user_limit, global_limit, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        b.code,
        b.description ?? null,
        b.discountType,
        b.discountValue,
        b.minOrderUsd ?? null,
        b.scope,
        b.startsAt ?? null,
        b.expiresAt ?? null,
        b.perUserLimit ?? null,
        b.globalLimit ?? null,
        b.isActive,
      ],
    );
    inserted = r.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    throw err;
  }

  await writeRestrictions(inserted.id, wreq.workspaceOwnerId, b);
  await writeExclusions(inserted.id, wreq.workspaceOwnerId, b);
  const [coupon] = await assembleCoupons([inserted]);
  res.status(201).json({ coupon });
});

/**
 * PATCH /api/coupons/:id — update a coupon (also used to toggle active).
 */
router.patch("/coupons/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCoupons(wreq)) {
    res.status(403).json({ error: "Access denied: coupons not in your role permissions" });
    return;
  }
  const parsed = updateCouponSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
    return;
  }
  const b = parsed.data;

  const existing = await db.query<CouponRow>(
    `SELECT * FROM coupons WHERE id = $1 AND workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (b.code !== undefined) add("code", b.code);
  if (b.description !== undefined) add("description", b.description ?? null);
  if (b.discountType !== undefined) add("discount_type", b.discountType);
  if (b.discountValue !== undefined) add("discount_value", b.discountValue);
  if (b.minOrderUsd !== undefined) add("min_order_usd", b.minOrderUsd ?? null);
  if (b.scope !== undefined) add("scope", b.scope);
  if (b.startsAt !== undefined) add("starts_at", b.startsAt ?? null);
  if (b.expiresAt !== undefined) add("expires_at", b.expiresAt ?? null);
  if (b.perUserLimit !== undefined) add("per_user_limit", b.perUserLimit ?? null);
  if (b.globalLimit !== undefined) add("global_limit", b.globalLimit ?? null);
  if (b.isActive !== undefined) add("is_active", b.isActive);
  sets.push(`updated_at = now()`);

  params.push(req.params.id);
  params.push(wreq.workspaceOwnerId);
  let updated: CouponRow;
  try {
    const r = await db.query<CouponRow>(
      `UPDATE coupons SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
        RETURNING *`,
      params,
    );
    updated = r.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "A coupon with this code already exists" });
      return;
    }
    throw err;
  }

  await writeRestrictions(updated.id, wreq.workspaceOwnerId, b);
  await writeExclusions(updated.id, wreq.workspaceOwnerId, b);
  const [coupon] = await assembleCoupons([updated]);
  sendValidated(req, res, singleCouponResponseSchema, { coupon }, "PATCH /coupons/:id");
});

/**
 * DELETE /api/coupons/:id — delete a coupon (restrictions + redemptions cascade).
 */
router.delete("/coupons/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageCoupons(wreq)) {
    res.status(403).json({ error: "Access denied: coupons not in your role permissions" });
    return;
  }
  const result = await db.query(
    `DELETE FROM coupons WHERE id = $1 AND workspace_owner_id = $2`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Coupon not found" });
    return;
  }
  res.json({ success: true });
});

export default router;
