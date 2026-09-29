/**
 * Address Book English translation backfill.
 *
 * Translates Arabic text already stored in Address Book display fields:
 *   places.canonical_name, places.canonical_address,
 *   contact_addresses.raw_address
 *
 * Run via CLI:
 *   pnpm exec tsx src/jobs/addressBookTranslationBackfill.ts --workspace <owner_id> [--dry-run]
 *
 * The job is intentionally separate from the historical order import. It only
 * touches active Address Book rows, never mutates private order snapshots, and
 * is idempotent because translated values no longer match the Arabic scan.
 */

import { db, withTransaction } from "../lib/db";
import { logger } from "../lib/logger";
import { detectScript, translateAddressToEnglish } from "../lib/translation";
import { normalizePlaceName } from "../lib/addressBookAutoLink";

const ARABIC_ALIAS_SOURCE = "approved_transliteration";

export interface TranslationBackfillSummary {
  workspace_id: string;
  dry_run: boolean;
  places_scanned: number;
  place_names_updated: number;
  place_addresses_updated: number;
  contact_addresses_scanned: number;
  contact_addresses_updated: number;
  aliases_added: number;
  skipped_translation: number;
  errors: Array<{ table: string; id: string; field: string; message: string }>;
}

interface PlaceRow {
  id: string;
  canonical_name: string | null;
  canonical_address: string | null;
}

interface ContactAddressRow {
  id: string;
  raw_address: string | null;
}

type TranslationCache = Map<string, Promise<string | null>>;

function translatedText(
  text: string,
  cache: TranslationCache,
  workspaceId: string,
): Promise<string | null> {
  const trimmed = text.trim();
  const cached = cache.get(trimmed);
  if (cached) return cached;

  const pending = translateAddressToEnglish(trimmed, {
    workspaceOwnerId: workspaceId,
  });
  cache.set(trimmed, pending);
  return pending;
}

async function preserveOriginalAsAlias(
  placeId: string,
  originalText: string,
  query: (
    sql: string,
    params: unknown[],
  ) => Promise<{ rowCount: number | null }>,
): Promise<boolean> {
  const normalizedAlias = normalizePlaceName(originalText);
  if (!normalizedAlias) return false;

  const result = await query(
    `INSERT INTO place_aliases
       (place_id, alias_text, normalized_alias, language, source, approval_state)
     VALUES ($1, $2, $3, 'ar', $4, 'approved')
     ON CONFLICT (place_id, normalized_alias) DO UPDATE
       SET alias_text = EXCLUDED.alias_text,
           language = EXCLUDED.language,
           source = EXCLUDED.source,
           approval_state = EXCLUDED.approval_state,
           deleted_at = NULL
       WHERE place_aliases.deleted_at IS NOT NULL
     RETURNING id`,
    [placeId, originalText, normalizedAlias, ARABIC_ALIAS_SOURCE],
  );
  return (result.rowCount ?? 0) > 0;
}

function logTranslationChange(input: {
  workspaceId: string;
  table: "places" | "contact_addresses";
  id: string;
  field: string;
  before: string;
  after: string;
  dryRun: boolean;
}): void {
  logger.info(
    input,
    "addressBookTranslationBackfill: translated Address Book field",
  );
}

function isUsableTranslation(original: string, translated: string | null): translated is string {
  // The shared helper returns null on failure. Keep this guard as a second
  // safety net in case a model answers in Arabic instead of translating.
  return Boolean(
    translated &&
      translated.trim() &&
      detectScript(translated) !== "arabic" &&
      translated.trim() !== original.trim(),
  );
}

export async function runTranslationBackfill(options: {
  workspaceId: string;
  dryRun?: boolean;
}): Promise<TranslationBackfillSummary> {
  const { workspaceId, dryRun = false } = options;
  const summary: TranslationBackfillSummary = {
    workspace_id: workspaceId,
    dry_run: dryRun,
    places_scanned: 0,
    place_names_updated: 0,
    place_addresses_updated: 0,
    contact_addresses_scanned: 0,
    contact_addresses_updated: 0,
    aliases_added: 0,
    skipped_translation: 0,
    errors: [],
  };
  const cache: TranslationCache = new Map();

  logger.info({ workspaceId, dryRun }, "addressBookTranslationBackfill: starting");

  const places = await db.query<PlaceRow>(
    `SELECT id, canonical_name, canonical_address
       FROM places
      WHERE workspace_owner_id = $1
        AND archived_at IS NULL`,
    [workspaceId],
  );
  summary.places_scanned = places.rows.length;

  for (const place of places.rows) {
    for (const [field, original] of [
      ["canonical_name", place.canonical_name],
      ["canonical_address", place.canonical_address],
    ] as const) {
      if (!original || detectScript(original) !== "arabic") continue;

      let translated: string | null;
      try {
        translated = await translatedText(original, cache, workspaceId);
      } catch (err) {
        translated = null;
        summary.errors.push({
          table: "places",
          id: place.id,
          field,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!isUsableTranslation(original, translated)) {
        summary.skipped_translation++;
        continue;
      }

      if (dryRun) {
        logTranslationChange({
          workspaceId,
          table: "places",
          id: place.id,
          field,
          before: original,
          after: translated.trim(),
          dryRun: true,
        });
        if (field === "canonical_name") summary.place_names_updated++;
        else summary.place_addresses_updated++;
        continue;
      }

      const client = await db.connect();
      try {
        const result = await withTransaction(client, async () => {
          const updated = await client.query(
            `UPDATE places
                SET ${field} = $1, updated_at = now()
              WHERE id = $2
                AND workspace_owner_id = $3
                AND archived_at IS NULL
                AND ${field} = $4
             RETURNING id`,
            [translated.trim(), place.id, workspaceId, original],
          );
          if (!updated.rowCount) return { updated: false, aliasAdded: false };

          const aliasAdded = await preserveOriginalAsAlias(
            place.id,
            original,
            (sql, params) => client.query(sql, params),
          );
          return { updated: true, aliasAdded };
        });
        if (!result.updated) continue;

        const translatedValue = translated.trim();
        logTranslationChange({
          workspaceId,
          table: "places",
          id: place.id,
          field,
          before: original,
          after: translatedValue,
          dryRun: false,
        });
        if (field === "canonical_name") summary.place_names_updated++;
        else summary.place_addresses_updated++;
        if (result.aliasAdded) summary.aliases_added++;
      } catch (err) {
        summary.errors.push({
          table: "places",
          id: place.id,
          field,
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        client.release();
      }
    }
  }

  const contactAddresses = await db.query<ContactAddressRow>(
    `SELECT id, raw_address
       FROM contact_addresses
      WHERE workspace_owner_id = $1
        AND archived_at IS NULL`,
    [workspaceId],
  );
  summary.contact_addresses_scanned = contactAddresses.rows.length;

  for (const address of contactAddresses.rows) {
    const original = address.raw_address;
    if (!original || detectScript(original) !== "arabic") continue;

    let translated: string | null;
    try {
      translated = await translatedText(original, cache, workspaceId);
    } catch (err) {
      translated = null;
      summary.errors.push({
        table: "contact_addresses",
        id: address.id,
        field: "raw_address",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    if (!isUsableTranslation(original, translated)) {
      summary.skipped_translation++;
      continue;
    }
    if (dryRun) {
      logTranslationChange({
        workspaceId,
        table: "contact_addresses",
        id: address.id,
        field: "raw_address",
        before: original,
        after: translated.trim(),
        dryRun: true,
      });
      summary.contact_addresses_updated++;
      continue;
    }

    try {
      const updated = await db.query(
        `UPDATE contact_addresses
            SET raw_address = $1, updated_at = now()
          WHERE id = $2
            AND workspace_owner_id = $3
            AND archived_at IS NULL
            AND raw_address = $4
         RETURNING id`,
        [translated.trim(), address.id, workspaceId, original],
      );
      if (updated.rowCount) {
        logTranslationChange({
          workspaceId,
          table: "contact_addresses",
          id: address.id,
          field: "raw_address",
          before: original,
          after: translated.trim(),
          dryRun: false,
        });
        summary.contact_addresses_updated++;
      }
    } catch (err) {
      summary.errors.push({
        table: "contact_addresses",
        id: address.id,
        field: "raw_address",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info({ summary }, "addressBookTranslationBackfill: complete");
  return summary;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspaceIndex = args.indexOf("--workspace");
  const workspaceId =
    workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  const dryRun = args.includes("--dry-run");

  if (!workspaceId) {
    console.error(
      "Usage: tsx src/jobs/addressBookTranslationBackfill.ts --workspace <owner_id> [--dry-run]",
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "starting", workspaceId, dryRun }, null, 2));
  try {
    const summary = await runTranslationBackfill({ workspaceId, dryRun });
    console.log(JSON.stringify({ status: "complete", summary }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: String(err) }, null, 2));
    process.exit(1);
  } finally {
    await db.end();
  }
}

const invokedScript = process.argv[1] ?? "";
if (
  process.env.ADDRESS_BOOK_TRANSLATION_BACKFILL_CLI === "1" ||
  /addressBookTranslationBackfill\.(?:ts|js|mjs)$/.test(invokedScript)
) {
  main();
}