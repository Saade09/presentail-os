import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import {
  requireApiKey,
  resolveApiKeyWorkspace,
  type ApiKeyAuthedRequest,
} from "../lib/apiKeyAuth";

const router = Router();

/**
 * Typed failure codes returned to the storefront. Always paired with HTTP 200.
 */
type CouponError =
  | "not_found"
  | "inactive"
  | "expired"
  | "not_started_yet"
  | "below_minimum"
  | "no_eligible_items"
  | "usage_limit_reached"
  | "usage_limit_per_user_reached";

const ERROR_MESSAGES: Record<CouponError, string> = {
  not_found: "This coupon code is not valid.",
  inactive: "This coupon is no longer active.",
  expired: "This coupon has expired.",
  not_started_yet: "This coupon is not active yet.",
  below_minimum: "Your order does not meet the minimum amount for this coupon.",
  no_eligible_items: "No items in your cart are eligible for this coupon.",
  usage_limit_reached: "This coupon has reached its usage limit.",
  usage_limit_per_user_reached: "You have already used this coupon the maximum number of times.",
};

const cartItemSchema = z.object({
  productId: z.union([z.number(), z.string()]).nullish(),
  slug: z.string().nullish(),
  categoryIds: z.array(z.number().int()).optional(),
  quantity: z.number().positive().optional(),
  // `priceUsd` is the spec field name; `unitPriceUsd`/`lineTotalUsd` are accepted aliases.
  priceUsd: z.number().nonnegative().optional(),
  unitPriceUsd: z.number().nonnegative().optional(),
  lineTotalUsd: z.number().nonnegative().optional(),
});

const validateRequestSchema = z.object({
  code: z.string().trim().min(1),
  cartTotalUsd: z.number().nonnegative(),
  customerEmail: z.string().trim().email().nullish(),
  // `cartItems` is the spec field name; `items` is an accepted backward-compatible alias.
  cartItems: z.array(cartItemSchema).optional(),
  items: z.array(cartItemSchema).optional(),
});

type ValidateItem = z.infer<typeof cartItemSchema>;

type CouponRow = {
  id: string;
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
};

function fail(error: CouponError) {
  return { valid: false as const, error, message: ERROR_MESSAGES[error] };
}

function lineTotal(item: ValidateItem): number {
  if (typeof item.lineTotalUsd === "number") return item.lineTotalUsd;
  const unit =
    typeof item.priceUsd === "number"
      ? item.priceUsd
      : typeof item.unitPriceUsd === "number"
        ? item.unitPriceUsd
        : undefined;
  if (typeof unit === "number") return unit * (item.quantity ?? 1);
  return 0;
}

// ---------------------------------------------------------------------------
// GET /api/coupons — external (API-key) coupon rules list
// ---------------------------------------------------------------------------

const ATTRIBUTE_TABLES = {
  occasion: "occasions",
  category: "catalog_categories",
  brand: "catalog_brands",
  recipient: "recipients",
} as const;

type AttributeType = keyof typeof ATTRIBUTE_TABLES;

type AttributeRef = { id: number; slug: string; name: string };

type ExternalCoupon = {
  id: string;
  code: string;
  description: string | null;
  discountType: "percentage" | "fixed";
  discountValue: number;
  minOrderUsd: number | null;
  scope: "all" | "restricted";
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  perUserLimit: number | null;
  globalLimit: number | null;
  usedCount: number;
  restrictions: {
    products: { id: number; slug: string | null }[];
    occasions: AttributeRef[];
    categories: AttributeRef[];
    brands: AttributeRef[];
    recipients: AttributeRef[];
  } | null;
};

function toIsoOrNull(v: string | Date | null): string | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * GET /api/coupons  (API-key authenticated variant)
 *
 * Returns the workspace's currently usable coupons with full rule data so an
 * external storefront can match entered codes and apply discounts client-side.
 * Only active, non-expired coupons are returned. Restricted coupons include
 * the allowed product ids/slugs and the allowed catalog attributes
 * (occasion/category/brand/recipient) resolved to ids + slugs + names.
 *
 * Falls through (calls next()) when no API key is present so the
 * Clerk-authenticated dashboard route (`GET /api/coupons`) handles the request
 * — same integration pattern as the external products endpoint.
 *
 * Note: the returned rules are for display / client-side application only.
 * The storefront must still call `POST /api/coupons/validate` before checkout
 * as the authoritative check, then pass `couponId` + `couponDiscountUsd` on
 * `POST /api/orders`.
 */
router.get("/coupons", async (req, res, next) => {
  const ownerId = await resolveApiKeyWorkspace(req);
  if (!ownerId) {
    next();
    return;
  }

  const couponsResult = await db.query<
    CouponRow & { created_at: string }
  >(
    `SELECT id, code, description, discount_type, discount_value, min_order_usd, scope,
            starts_at, expires_at, per_user_limit, global_limit, is_active
       FROM coupons
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC`,
    [ownerId],
  );
  const rows = couponsResult.rows;

  const usageMap = new Map<string, number>();
  const productsMap = new Map<string, { id: number; slug: string | null }[]>();
  const attrsMap = new Map<string, Record<AttributeType, AttributeRef[]>>();

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const usage = await db.query<{ coupon_id: string; used_count: string }>(
      `SELECT coupon_id, COUNT(*)::text AS used_count
         FROM coupon_redemptions
        WHERE coupon_id = ANY($1) AND status = 'confirmed'
        GROUP BY coupon_id`,
      [ids],
    );
    for (const r of usage.rows) usageMap.set(r.coupon_id, Number(r.used_count));

    const restrictedIds = rows.filter((r) => r.scope === "restricted").map((r) => r.id);
    if (restrictedIds.length > 0) {
      const products = await db.query<{ coupon_id: string; id: number; sku: string | null }>(
        `SELECT cp.coupon_id, p.id, p.sku
           FROM coupon_products cp
           JOIN products p ON p.id = cp.product_id
          WHERE cp.coupon_id = ANY($1)`,
        [restrictedIds],
      );
      for (const r of products.rows) {
        const arr = productsMap.get(r.coupon_id) ?? [];
        arr.push({ id: r.id, slug: r.sku });
        productsMap.set(r.coupon_id, arr);
      }

      // One lookup per attribute type, joined to its catalog table for slugs.
      for (const type of Object.keys(ATTRIBUTE_TABLES) as AttributeType[]) {
        const table = ATTRIBUTE_TABLES[type];
        const attrRows = await db.query<{
          coupon_id: string;
          id: number;
          slug: string;
          name: string;
        }>(
          `SELECT ca.coupon_id, t.id, t.slug, t.name
             FROM coupon_attributes ca
             JOIN ${table} t ON t.id = ca.attribute_id
            WHERE ca.coupon_id = ANY($1) AND ca.attribute_type = $2`,
          [restrictedIds, type],
        );
        for (const r of attrRows.rows) {
          const entry =
            attrsMap.get(r.coupon_id) ??
            ({ occasion: [], category: [], brand: [], recipient: [] } as Record<
              AttributeType,
              AttributeRef[]
            >);
          entry[type].push({ id: r.id, slug: r.slug, name: r.name });
          attrsMap.set(r.coupon_id, entry);
        }
      }
    }
  }

  const coupons: ExternalCoupon[] = rows.map((r) => {
    const scope = r.scope === "restricted" ? ("restricted" as const) : ("all" as const);
    const attrs = attrsMap.get(r.id) ?? {
      occasion: [],
      category: [],
      brand: [],
      recipient: [],
    };
    return {
      id: r.id,
      code: r.code,
      description: r.description,
      discountType: r.discount_type === "fixed" ? "fixed" : "percentage",
      discountValue: Number(r.discount_value),
      minOrderUsd: r.min_order_usd === null ? null : Number(r.min_order_usd),
      scope,
      startsAt: toIsoOrNull(r.starts_at),
      expiresAt: toIsoOrNull(r.expires_at),
      isActive: r.is_active,
      perUserLimit: r.per_user_limit,
      globalLimit: r.global_limit,
      usedCount: usageMap.get(r.id) ?? 0,
      restrictions:
        scope === "restricted"
          ? {
              products: productsMap.get(r.id) ?? [],
              occasions: attrs.occasion,
              categories: attrs.category,
              brands: attrs.brand,
              recipients: attrs.recipient,
            }
          : null,
    };
  });

  res.json({ coupons });
});

router.post("/coupons/validate", requireApiKey, async (req, res) => {
  const ownerId = (req as ApiKeyAuthedRequest).userId;

  const parsed = validateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
    return;
  }
  const { code, cartTotalUsd, customerEmail } = parsed.data;
  const items = parsed.data.cartItems ?? parsed.data.items ?? [];

  const couponResult = await db.query<CouponRow>(
    `SELECT id, code, description, discount_type, discount_value, min_order_usd, scope,
            starts_at, expires_at, per_user_limit, global_limit, is_active
       FROM coupons
      WHERE workspace_owner_id = $1 AND lower(code) = lower($2)
      LIMIT 1`,
    [ownerId, code],
  );
  if (couponResult.rowCount === 0) {
    res.json(fail("not_found"));
    return;
  }
  const coupon = couponResult.rows[0];

  if (!coupon.is_active) {
    res.json(fail("inactive"));
    return;
  }

  const now = Date.now();
  if (coupon.expires_at && now > new Date(coupon.expires_at).getTime()) {
    res.json(fail("expired"));
    return;
  }
  if (coupon.starts_at && now < new Date(coupon.starts_at).getTime()) {
    res.json(fail("not_started_yet"));
    return;
  }

  const minOrder = coupon.min_order_usd === null ? null : Number(coupon.min_order_usd);
  if (minOrder !== null && cartTotalUsd < minOrder) {
    res.json(fail("below_minimum"));
    return;
  }

  // ── Exclusions — always load; filter applies to all scopes ───────────────
  const [exclProductsRes, exclAttrsRes] = await Promise.all([
    db.query<{ product_id: number }>(
      `SELECT product_id FROM coupon_excluded_products WHERE coupon_id = $1`,
      [coupon.id],
    ),
    db.query<{ attribute_type: string; attribute_id: number }>(
      `SELECT attribute_type, attribute_id FROM coupon_excluded_attributes WHERE coupon_id = $1`,
      [coupon.id],
    ),
  ]);
  const excludedProductIds = new Set(exclProductsRes.rows.map((r) => r.product_id));
  const excludedByType: Record<string, Set<number>> = {
    occasion: new Set(),
    category: new Set(),
    brand: new Set(),
    recipient: new Set(),
  };
  for (const r of exclAttrsRes.rows) {
    if (excludedByType[r.attribute_type]) excludedByType[r.attribute_type].add(r.attribute_id);
  }
  const hasExclusions = excludedProductIds.size > 0 || exclAttrsRes.rows.length > 0;

  // ── Eligibility ─────────────────────────────────────────────────────────
  let eligibleSubtotal = cartTotalUsd;

  if (coupon.scope === "restricted" || hasExclusions) {
    // Resolve cart items to OS products (shared by both inclusion + exclusion checks).
    const numericIds = items
      .map((i) => (typeof i.productId === "number" ? i.productId : parseInt(String(i.productId ?? ""), 10)))
      .filter((n) => Number.isInteger(n));
    const slugs = items.map((i) => i.slug).filter((s): s is string => typeof s === "string" && s.length > 0);

    const productMatch = new Map<string, number>(); // key (id or slug) -> product.id
    const resolvedProductIds = new Set<number>();
    if (numericIds.length > 0 || slugs.length > 0) {
      const r = await db.query<{ id: number; sku: string | null }>(
        `SELECT id, sku FROM products
          WHERE workspace_owner_id = $1 AND (id = ANY($2) OR sku = ANY($3))`,
        [ownerId, numericIds, slugs],
      );
      for (const row of r.rows) {
        resolvedProductIds.add(row.id);
        productMatch.set(`id:${row.id}`, row.id);
        if (row.sku) productMatch.set(`slug:${row.sku}`, row.id);
      }
    }

    // Read catalog associations for the resolved products.
    const productAttrs = new Map<number, Record<string, Set<number>>>();
    if (resolvedProductIds.size > 0) {
      const pids = [...resolvedProductIds];
      const [occ, cat, brn, rec] = await Promise.all([
        db.query<{ product_id: number; attribute_id: number }>(
          `SELECT product_id, attribute_id FROM product_occasions WHERE product_id = ANY($1)`,
          [pids],
        ),
        db.query<{ product_id: number; attribute_id: number }>(
          `SELECT product_id, attribute_id FROM product_catalog_categories WHERE product_id = ANY($1)`,
          [pids],
        ),
        db.query<{ product_id: number; attribute_id: number }>(
          `SELECT product_id, attribute_id FROM product_catalog_brands WHERE product_id = ANY($1)`,
          [pids],
        ),
        db.query<{ product_id: number; attribute_id: number }>(
          `SELECT product_id, attribute_id FROM product_recipients WHERE product_id = ANY($1)`,
          [pids],
        ),
      ]);
      const ensure = (pid: number) => {
        let e = productAttrs.get(pid);
        if (!e) {
          e = { occasion: new Set(), category: new Set(), brand: new Set(), recipient: new Set() };
          productAttrs.set(pid, e);
        }
        return e;
      };
      for (const row of occ.rows) ensure(row.product_id).occasion.add(row.attribute_id);
      for (const row of cat.rows) ensure(row.product_id).category.add(row.attribute_id);
      for (const row of brn.rows) ensure(row.product_id).brand.add(row.attribute_id);
      for (const row of rec.rows) ensure(row.product_id).recipient.add(row.attribute_id);
    }

    const intersects = (a: Set<number>, b: Set<number>): boolean => {
      if (a.size === 0 || b.size === 0) return false;
      for (const v of a) if (b.has(v)) return true;
      return false;
    };

    /** Resolve an item to its OS product id. */
    const getItemPid = (item: ValidateItem): number | undefined => {
      let pid: number | undefined;
      if (item.productId != null) {
        const n = typeof item.productId === "number" ? item.productId : parseInt(String(item.productId), 10);
        if (Number.isInteger(n)) pid = productMatch.get(`id:${n}`);
      }
      if (pid === undefined && item.slug) pid = productMatch.get(`slug:${item.slug}`);
      return pid;
    };

    // ── Apply exclusion filter (both scopes) ─────────────────────────────
    const isItemExcluded = (item: ValidateItem): boolean => {
      const pid = getItemPid(item);
      if (pid !== undefined) {
        if (excludedProductIds.has(pid)) return true;
        const attrs = productAttrs.get(pid);
        if (attrs) {
          if (intersects(attrs.occasion, excludedByType.occasion)) return true;
          if (intersects(attrs.category, excludedByType.category)) return true;
          if (intersects(attrs.brand, excludedByType.brand)) return true;
          if (intersects(attrs.recipient, excludedByType.recipient)) return true;
        }
      }
      // Fall back to category ids sent directly by the storefront.
      if (item.categoryIds && item.categoryIds.length > 0) {
        if (intersects(new Set(item.categoryIds), excludedByType.category)) return true;
      }
      return false;
    };

    const workingItems = hasExclusions ? items.filter((i) => !isItemExcluded(i)) : items;

    if (coupon.scope === "restricted") {
      // ── Inclusion filter ───────────────────────────────────────────────
      const [restrictProducts, restrictAttrs] = await Promise.all([
        db.query<{ product_id: number }>(
          `SELECT product_id FROM coupon_products WHERE coupon_id = $1`,
          [coupon.id],
        ),
        db.query<{ attribute_type: string; attribute_id: number }>(
          `SELECT attribute_type, attribute_id FROM coupon_attributes WHERE coupon_id = $1`,
          [coupon.id],
        ),
      ]);
      const allowedProductIds = new Set(restrictProducts.rows.map((r) => r.product_id));
      const allowedByType: Record<string, Set<number>> = {
        occasion: new Set(),
        category: new Set(),
        brand: new Set(),
        recipient: new Set(),
      };
      for (const r of restrictAttrs.rows) {
        if (allowedByType[r.attribute_type]) allowedByType[r.attribute_type].add(r.attribute_id);
      }

      const isItemEligible = (item: ValidateItem): boolean => {
        const pid = getItemPid(item);
        if (pid !== undefined) {
          if (allowedProductIds.has(pid)) return true;
          const attrs = productAttrs.get(pid);
          if (attrs) {
            if (intersects(attrs.occasion, allowedByType.occasion)) return true;
            if (intersects(attrs.category, allowedByType.category)) return true;
            if (intersects(attrs.brand, allowedByType.brand)) return true;
            if (intersects(attrs.recipient, allowedByType.recipient)) return true;
          }
        }
        // Fall back to category ids sent directly by the storefront.
        if (item.categoryIds && item.categoryIds.length > 0) {
          if (intersects(new Set(item.categoryIds), allowedByType.category)) return true;
        }
        return false;
      };

      const eligibleItems = workingItems.filter(isItemEligible);
      if (eligibleItems.length === 0) {
        res.json(fail("no_eligible_items"));
        return;
      }
      eligibleSubtotal = eligibleItems.reduce((sum, i) => sum + lineTotal(i), 0);
    } else {
      // scope=all with exclusions — recalculate subtotal from non-excluded items.
      if (items.length > 0) {
        if (workingItems.length === 0) {
          res.json(fail("no_eligible_items"));
          return;
        }
        eligibleSubtotal = workingItems.reduce((sum, i) => sum + lineTotal(i), 0);
      }
      // If the storefront sent no line items, fall back to cartTotalUsd as-is.
    }
  }

  // ── Usage limits ──────────────────────────────────────────────────────────
  if (coupon.global_limit !== null) {
    const r = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM coupon_redemptions
        WHERE coupon_id = $1 AND status = 'confirmed'`,
      [coupon.id],
    );
    if (Number(r.rows[0]?.count ?? 0) >= coupon.global_limit) {
      res.json(fail("usage_limit_reached"));
      return;
    }
  }
  if (coupon.per_user_limit !== null && customerEmail) {
    const r = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM coupon_redemptions
        WHERE coupon_id = $1 AND status = 'confirmed' AND lower(customer_email) = lower($2)`,
      [coupon.id, customerEmail],
    );
    if (Number(r.rows[0]?.count ?? 0) >= coupon.per_user_limit) {
      res.json(fail("usage_limit_per_user_reached"));
      return;
    }
  }

  // ── Discount math ─────────────────────────────────────────────────────────
  const value = Number(coupon.discount_value);
  let discount = coupon.discount_type === "fixed" ? value : (eligibleSubtotal * value) / 100;
  if (discount > cartTotalUsd) discount = cartTotalUsd;
  if (discount < 0) discount = 0;
  const discountAmountUsd = Math.round(discount * 100) / 100;

  res.json({
    valid: true as const,
    discountAmountUsd,
    couponId: coupon.id,
    description: coupon.description,
  });
});

export default router;
