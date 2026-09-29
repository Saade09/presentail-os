/**
 * Address Book Public router — API-key-only landmark search for storefronts.
 *
 * Mounted BEFORE apiKeyReadAuth (and Clerk-gated routers) so it is unaffected
 * by Clerk middleware. Uses resolveApiKeyWorkspace directly, matching the
 * pattern of externalProductsRouter and deliveryLocationsRouter.
 */
import { Router, type Request, type Response } from "express";
import { db } from "../lib/db";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";

const router = Router();

/**
 * GET /api/address-book/places/search?q=<term>
 *
 * Lightweight landmark suggestion endpoint for external storefronts.
 * Requires a valid pk_live_… API key via x-api-key header or
 * Authorization: Bearer pk_live_… — no Clerk session needed.
 *
 * - Without `q` the response is always { places: [] } (defined no-op).
 * - With `q`, returns up to 20 non-archived places whose canonical_name or
 *   any active alias matches the search term (case-insensitive ILIKE).
 *
 * Response shape:
 *   { places: [{ id, canonicalName, area, type, cityName,
 *               latitude, longitude, verificationState }] }
 */
router.get("/address-book/places/search", async (req: Request, res: Response): Promise<void> => {
  const ownerId = await resolveApiKeyWorkspace(req);
  if (!ownerId) {
    res.status(401).json({ error: "API key required" });
    return;
  }

  const rawQ = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!rawQ) {
    // Defined no-op: storefront always gets a valid, empty response.
    res.json({ places: [] });
    return;
  }

  const like = `%${rawQ.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const result = await db.query<{
    id: string;
    canonical_name: string;
    area: string | null;
    place_type: string;
    city_name: string | null;
    latitude: string | null;
    longitude: string | null;
    verification_state: string;
  }>(
    `SELECT
       p.id, p.canonical_name, p.area, p.place_type,
       dc.name AS city_name,
       p.latitude, p.longitude, p.verification_state
     FROM places p
     LEFT JOIN delivery_cities dc ON dc.id = p.city_id
     WHERE p.workspace_owner_id = $1
       AND p.archived_at IS NULL
       AND (
         p.canonical_name ILIKE $2 ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM place_aliases pa
            WHERE pa.place_id = p.id AND pa.deleted_at IS NULL
              AND pa.alias_text ILIKE $2 ESCAPE '\\'
         )
       )
     ORDER BY p.canonical_name ASC
     LIMIT 20`,
    [ownerId, like],
  );

  res.json({
    places: result.rows.map((r) => ({
      id: r.id,
      canonicalName: r.canonical_name,
      area: r.area,
      type: r.place_type,
      cityName: r.city_name,
      latitude: r.latitude != null ? parseFloat(r.latitude) : null,
      longitude: r.longitude != null ? parseFloat(r.longitude) : null,
      verificationState: r.verification_state,
    })),
  });
});

export default router;
