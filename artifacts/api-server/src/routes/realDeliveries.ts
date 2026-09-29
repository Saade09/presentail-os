import { Router, type Request, type Response } from "express";
import { db } from "../lib/db";
import { requireApiKey } from "../lib/apiKeyAuth";
import { buildPublicObjectUrl } from "../lib/objectStorage";

const router = Router();
function safeProductImageUrl(key: string | null): string | null {
  if (!key || !/^products\/[a-z0-9][a-z0-9/_-]*\.(jpg|jpeg|png|webp|avif)$/i.test(key)) return null;
  return buildPublicObjectUrl(key);
}

/**
 * Public website feed. This deliberately has its own mandatory API-key gate
 * rather than relying on apiKeyReadAuth, so an unauthenticated request can
 * never accidentally receive published delivery imagery.
 */
router.get("/storefront/real-deliveries", requireApiKey, async (req: Request, res: Response) => {
  const country = typeof req.query.country === "string" ? req.query.country.trim().toUpperCase() : "";
  const city = typeof req.query.city === "string" ? req.query.city.trim() : "";
  if ((country && !/^[A-Z]{2}$/.test(country)) || city.length > 120) {
    res.status(400).json({ error: "country must be ISO alpha-2 and city must be at most 120 characters" });
    return;
  }
  const ownerId = (req as Request & { userId: string }).userId;
  const rows = await db.query<{
    photo_id: string;
    asset_key: string;
    capture_at: string;
    products: Array<{ id: number; name: string; image_key: string | null }> | null;
    city: string | null;
    country: string | null;
  }>(
    `SELECT fpp.id::text AS photo_id, fpp.public_asset_key AS asset_key, fpp.capture_at,
            product_links.products,
            COALESCE(dc.name,
                     NULLIF(btrim(o.delivery_address->>'cityName'), ''),
                     NULLIF(btrim(o.delivery_address->>'city'), ''),
                     NULLIF(btrim(o.delivery_address->>'district'), '')) AS city,
            COALESCE(NULLIF(upper(btrim(o.delivery_address->>'countryCode')), ''),
                     NULLIF(upper(btrim(o.delivery_address->>'country_code')), ''),
                     dc.country_code,
                     NULLIF(btrim(o.delivery_address->>'country'), '')) AS country
       FROM florist_photo_publications fpp
       JOIN order_florist_assignments ofa ON ofa.id=fpp.assignment_id
       JOIN orders o ON o.id=ofa.order_id AND o.workspace_owner_id=ofa.workspace_owner_id
  LEFT JOIN LATERAL (
         SELECT dc_match.name, dc_match.country_code
           FROM delivery_cities dc_match
          WHERE dc_match.workspace_owner_id=o.workspace_owner_id
            AND dc_match.is_active=true
            AND (
              dc_match.id::text = NULLIF(btrim(o.delivery_address->>'cityId'), '')
              OR lower(dc_match.slug) = lower(NULLIF(btrim(o.delivery_address->>'cityId'), ''))
              OR dc_match.id::text = NULLIF(btrim(o.delivery_address->>'city_id'), '')
              OR lower(dc_match.slug) = lower(NULLIF(btrim(o.delivery_address->>'city_id'), ''))
              OR lower(dc_match.name) = lower(NULLIF(btrim(o.delivery_address->>'cityName'), ''))
              OR lower(dc_match.name) = lower(NULLIF(btrim(o.delivery_address->>'city'), ''))
              OR lower(dc_match.name) = lower(NULLIF(btrim(o.delivery_address->>'district'), ''))
            )
          ORDER BY dc_match.id
          LIMIT 1
       ) dc ON true
  LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', linked.id,
                    'name', linked.name,
                    'image_key', linked.image_public_path
                  )
                  ORDER BY linked.first_line_id
                ) AS products
           FROM (
             SELECT DISTINCT ON (p.id)
                    p.id, p.name, p.image_public_path, oli.id::text AS first_line_id
               FROM order_line_items oli
               JOIN products p
                 ON p.id=oli.product_id
                AND p.workspace_owner_id=o.workspace_owner_id
              WHERE oli.order_id=o.id
                AND p.is_archived=false
                AND p.status='available'
              ORDER BY p.id, oli.id::text
           ) linked
       ) product_links ON true
       WHERE fpp.workspace_owner_id=$1
        AND fpp.publication_status='ready'
        AND fpp.enabled=true
        AND fpp.public_asset_key ~ '^real-deliveries/[0-9a-f-]+\\.(jpg|jpeg|png|webp)$'
        AND fpp.photo_set_rev=ofa.photo_set_rev
        AND fpp.source_photo_path=ofa.photo_items_path
        AND ofa.verification_status='approved'
        AND o.status='completed'
        AND ($2::text IS NULL OR upper(COALESCE(
              NULLIF(btrim(o.delivery_address->>'countryCode'), ''),
              NULLIF(btrim(o.delivery_address->>'country_code'), ''),
              dc.country_code
            ))=$2)
        AND ($3::text IS NULL OR lower(COALESCE(
              dc.name,
              NULLIF(btrim(o.delivery_address->>'cityName'), ''),
              NULLIF(btrim(o.delivery_address->>'city'), ''),
              NULLIF(btrim(o.delivery_address->>'district'), '')
            ))=lower($3))
      ORDER BY fpp.capture_at DESC, fpp.id DESC`,
    [ownerId, country || null, city || null],
  );
  const safeRows = rows.rows.filter((row) =>
    /^real-deliveries\/[0-9a-f-]+\.(jpg|jpeg|png|webp)$/i.test(row.asset_key),
  );
  res.json({
    // Keep a runtime guard in addition to the SQL predicate. This protects the
    // contract if a future query changes and ensures a null/unsafe key can
    // never be converted into an apparently public URL.
    photos: safeRows.flatMap((row) => {
      const assetUrl = buildPublicObjectUrl(row.asset_key);
      if (!assetUrl || !/^https:\/\/os\.presentail\.com\/api\/storage\/public-objects\/real-deliveries\//.test(assetUrl)) {
        return [];
      }
      const products = (row.products ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        image_url: safeProductImageUrl(product.image_key),
      }));
      return [{
        photo_id: row.photo_id,
        asset_id: row.photo_id,
        asset_url: assetUrl,
        captured_at: row.capture_at,
        product: products[0] ?? null,
        products,
        location: { country: row.country, city: row.city },
        eligibility: { approved: true, completed: true },
      }];
    }),
    view_more_url: process.env.REAL_DELIVERIES_VIEW_MORE_URL ?? null,
  });
});

export default router;