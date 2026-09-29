import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { DEFAULT_COUNTRIES, isExcludedCountry } from "../lib/defaults";
import { decorateCountryNames, resolveCatalogueWithOverrides } from "../lib/countryResolver";
import { fireDeliveryWebhook } from "../lib/deliveryWebhook";
import { assertPublicStoreUrl } from "../lib/urlValidator";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const VALID_THRESHOLDS = [5, 15, 60];
const VALID_UNDO_DURATIONS = [3, 5, 10, 15, 30];

router.get("/settings", async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;

  const result = await db.query(
    `SELECT offline_alert_threshold_minutes, offline_alert_email_enabled, available_countries,
            undo_duration_seconds, delivery_webhook_url, workspace_slug,
            trustpilot_invitations_enabled,
            inventory_recipe_consumption_enabled, inventory_allow_negative_stock
     FROM workspace_settings
     WHERE workspace_owner_id = $1`,
    [ownerId],
  );

  const row = result.rowCount === 0
    ? null
    : (result.rows[0] as {
        offline_alert_threshold_minutes: number;
        offline_alert_email_enabled: boolean;
        available_countries: string[] | null;
        undo_duration_seconds: number | null;
        delivery_webhook_url: string | null;
        workspace_slug: string | null;
        trustpilot_invitations_enabled: boolean | null;
        inventory_recipe_consumption_enabled: boolean | null;
        inventory_allow_negative_stock: boolean | null;
      });

  const rawNames = row?.available_countries ?? null;
  const source = rawNames && rawNames.length > 0 ? rawNames : DEFAULT_COUNTRIES;
  const filtered = source.filter((n) => !isExcludedCountry(n));
  const names = filtered.length > 0 ? filtered : DEFAULT_COUNTRIES.filter((n) => !isExcludedCountry(n));

  const details = await decorateCountryNames(ownerId, names);
  const catalogue = await resolveCatalogueWithOverrides(ownerId);

  res.json({
    offline_alert_threshold_minutes: row?.offline_alert_threshold_minutes ?? 5,
    offline_alert_email_enabled: row?.offline_alert_email_enabled ?? false,
    available_countries: names,
    available_country_details: details,
    country_catalogue: catalogue,
    undo_duration_seconds: row?.undo_duration_seconds ?? 5,
    delivery_webhook_url: row?.delivery_webhook_url ?? null,
    workspace_slug: row?.workspace_slug ?? null,
    trustpilot_invitations_enabled: row?.trustpilot_invitations_enabled ?? true,
    inventory_recipe_consumption_enabled: row?.inventory_recipe_consumption_enabled ?? false,
    inventory_allow_negative_stock: row?.inventory_allow_negative_stock ?? false,
    respondio_enabled: !!process.env.RESPONDIO_API_TOKEN,
  });
});

router.put("/settings", async (req, res) => {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;
  const body = req.body || {};

  const threshold = typeof body.offline_alert_threshold_minutes === "number"
    ? body.offline_alert_threshold_minutes
    : parseInt(String(body.offline_alert_threshold_minutes), 10);

  if (!VALID_THRESHOLDS.includes(threshold)) {
    res.status(400).json({ error: "offline_alert_threshold_minutes must be 5, 15, or 60" });
    return;
  }

  const emailEnabled = body.offline_alert_email_enabled === true || body.offline_alert_email_enabled === "true";

  let availableCountries: string[] = DEFAULT_COUNTRIES;
  if ("available_countries" in body) {
    if (!Array.isArray(body.available_countries)) {
      res.status(400).json({ error: "available_countries must be an array of strings" });
      return;
    }
    const trimmed = (body.available_countries as unknown[])
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      .map((c) => c.trim());
    const excluded = trimmed.filter((c) => isExcludedCountry(c));
    if (excluded.length > 0) {
      res.status(400).json({ error: "country is not supported" });
      return;
    }
    if (trimmed.length > 0) {
      availableCountries = trimmed;
    }
  }

  const rawUndoDuration = typeof body.undo_duration_seconds === "number"
    ? body.undo_duration_seconds
    : parseInt(String(body.undo_duration_seconds ?? "5"), 10);
  const undoDuration = VALID_UNDO_DURATIONS.includes(rawUndoDuration) ? rawUndoDuration : 5;

  // Absent fields preserve stored values; fetch in ONE query so the
  // overall query count matches the pre-Trustpilot shape.
  const hasWebhookField = "delivery_webhook_url" in body;
  const hasTrustpilotField = "trustpilot_invitations_enabled" in body;
  const hasRecipeFlag = "inventory_recipe_consumption_enabled" in body;
  const hasNegativeFlag = "inventory_allow_negative_stock" in body;
  let storedRow: {
    delivery_webhook_url: string | null;
    trustpilot_invitations_enabled: boolean | null;
    inventory_recipe_consumption_enabled: boolean | null;
    inventory_allow_negative_stock: boolean | null;
  } | null = null;
  if (!hasWebhookField || !hasTrustpilotField || !hasRecipeFlag || !hasNegativeFlag) {
    const existing = await db.query<{
      delivery_webhook_url: string | null;
      trustpilot_invitations_enabled: boolean | null;
      inventory_recipe_consumption_enabled: boolean | null;
      inventory_allow_negative_stock: boolean | null;
    }>(
      `SELECT delivery_webhook_url, trustpilot_invitations_enabled,
              inventory_recipe_consumption_enabled, inventory_allow_negative_stock
         FROM workspace_settings WHERE workspace_owner_id = $1`,
      [ownerId],
    );
    storedRow = existing.rows[0] ?? null;
  }

  let deliveryWebhookUrl: string | null = null;
  if (hasWebhookField) {
    const raw = body.delivery_webhook_url;
    if (raw === null || raw === "") {
      deliveryWebhookUrl = null;
    } else if (typeof raw === "string") {
      const parsed = z.string().url().safeParse(raw.trim());
      if (!parsed.success) {
        res.status(400).json({ error: "delivery_webhook_url must be a valid URL" });
        return;
      }
      try {
        await assertPublicStoreUrl(parsed.data);
      } catch {
        res.status(400).json({ error: "delivery_webhook_url must be a public HTTPS address" });
        return;
      }
      deliveryWebhookUrl = parsed.data;
    } else {
      res.status(400).json({ error: "delivery_webhook_url must be a string or null" });
      return;
    }
  } else {
    deliveryWebhookUrl = storedRow?.delivery_webhook_url ?? null;
  }

  // Trustpilot toggle: absent field preserves the stored value (default true).
  let trustpilotEnabled: boolean;
  if (hasTrustpilotField) {
    trustpilotEnabled =
      body.trustpilot_invitations_enabled === true ||
      body.trustpilot_invitations_enabled === "true";
  } else {
    trustpilotEnabled = storedRow?.trustpilot_invitations_enabled ?? true;
  }

  // Inventory feature flags: absent fields preserve stored values (default false).
  const recipeConsumptionEnabled = hasRecipeFlag
    ? body.inventory_recipe_consumption_enabled === true || body.inventory_recipe_consumption_enabled === "true"
    : (storedRow?.inventory_recipe_consumption_enabled ?? false);
  const allowNegativeStock = hasNegativeFlag
    ? body.inventory_allow_negative_stock === true || body.inventory_allow_negative_stock === "true"
    : (storedRow?.inventory_allow_negative_stock ?? false);

  await db.query(
    `INSERT INTO workspace_settings
       (workspace_owner_id, offline_alert_threshold_minutes, offline_alert_email_enabled,
        available_countries, undo_duration_seconds, delivery_webhook_url,
        trustpilot_invitations_enabled,
        inventory_recipe_consumption_enabled, inventory_allow_negative_stock)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_owner_id) DO UPDATE
       SET offline_alert_threshold_minutes = EXCLUDED.offline_alert_threshold_minutes,
           offline_alert_email_enabled = EXCLUDED.offline_alert_email_enabled,
           available_countries = EXCLUDED.available_countries,
           undo_duration_seconds = EXCLUDED.undo_duration_seconds,
           delivery_webhook_url = EXCLUDED.delivery_webhook_url,
           trustpilot_invitations_enabled = EXCLUDED.trustpilot_invitations_enabled,
           inventory_recipe_consumption_enabled = EXCLUDED.inventory_recipe_consumption_enabled,
           inventory_allow_negative_stock = EXCLUDED.inventory_allow_negative_stock`,
    [ownerId, threshold, emailEnabled, availableCountries, undoDuration, deliveryWebhookUrl,
     trustpilotEnabled, recipeConsumptionEnabled, allowNegativeStock],
  );

  const slugResult = await db.query<{ workspace_slug: string | null }>(
    `SELECT workspace_slug FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const currentSlug = slugResult.rows[0]?.workspace_slug ?? null;

  const filtered = availableCountries.filter((n) => !isExcludedCountry(n));
  const names = filtered.length > 0 ? filtered : DEFAULT_COUNTRIES.filter((n) => !isExcludedCountry(n));
  const details = await decorateCountryNames(ownerId, names);
  const catalogue = await resolveCatalogueWithOverrides(ownerId);
  res.json({
    offline_alert_threshold_minutes: threshold,
    offline_alert_email_enabled: emailEnabled,
    available_countries: names,
    available_country_details: details,
    country_catalogue: catalogue,
    undo_duration_seconds: undoDuration,
    delivery_webhook_url: deliveryWebhookUrl,
    workspace_slug: currentSlug,
    trustpilot_invitations_enabled: trustpilotEnabled,
    inventory_recipe_consumption_enabled: recipeConsumptionEnabled,
    inventory_allow_negative_stock: allowNegativeStock,
  });
});

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$|^[a-z0-9]$/;

/**
 * PATCH /settings/workspace-slug
 * Owner-only. Sets or clears the workspace public slug.
 */
router.patch("/settings/workspace-slug", async (req, res) => {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;
  const body = req.body || {};

  const raw: unknown = body.workspace_slug;

  if (raw === null || raw === "") {
    await db.query(
      `INSERT INTO workspace_settings (workspace_owner_id, workspace_slug)
       VALUES ($1, NULL)
       ON CONFLICT (workspace_owner_id) DO UPDATE SET workspace_slug = NULL`,
      [ownerId],
    );
    res.json({ workspace_slug: null });
    return;
  }

  if (typeof raw !== "string") {
    res.status(400).json({ error: "workspace_slug must be a string or null" });
    return;
  }

  const slug = raw.trim().toLowerCase();

  if (slug.length > 80) {
    res.status(400).json({ error: "workspace_slug must be 80 characters or fewer" });
    return;
  }

  if (!SLUG_REGEX.test(slug)) {
    res.status(400).json({
      error: "workspace_slug may only contain lowercase letters, numbers, and hyphens, and must not start or end with a hyphen",
    });
    return;
  }

  const conflict = await db.query<{ workspace_owner_id: string }>(
    `SELECT workspace_owner_id FROM workspace_settings WHERE workspace_slug = $1 AND workspace_owner_id != $2 LIMIT 1`,
    [slug, ownerId],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "workspace_slug is already taken" });
    return;
  }

  try {
    await db.query(
      `INSERT INTO workspace_settings (workspace_owner_id, workspace_slug)
       VALUES ($1, $2)
       ON CONFLICT (workspace_owner_id) DO UPDATE SET workspace_slug = EXCLUDED.workspace_slug`,
      [ownerId, slug],
    );
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      res.status(409).json({ error: "workspace_slug is already taken" });
      return;
    }
    throw err;
  }

  res.json({ workspace_slug: slug });
});

/**
 * POST /settings/delivery-webhook/test
 * Owner-only. Fires a test ping to the configured delivery webhook URL.
 */
router.post("/settings/delivery-webhook/test", async (req, res) => {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const ok = await fireDeliveryWebhook(ownerId, "delivery.config.test");
  if (ok) {
    res.json({ success: true });
  } else {
    res.status(502).json({ success: false, error: "Webhook delivery failed" });
  }
});

export default router;
