/**
 * Address Book Historical Backfill Job
 *
 * Reads historical order/delivery data and populates:
 *   places, place_aliases, contact_addresses, order_place_links
 *
 * Run via CLI:
 *   ts-node src/jobs/addressBookBackfill.ts --workspace <owner_id> [--dry-run]
 *
 * Or triggered via API:
 *   POST /api/address-book/import/run  { dryRun: boolean }
 *
 * Safety guarantees:
 *   - orders.delivery_address is NEVER mutated
 *   - Coordinate writes are never applied in this job (no coordinates available without geocoding)
 *   - All inserts use ON CONFLICT DO NOTHING / existence checks → safe to rerun
 *   - Already-linked orders (in order_place_links) are skipped
 */

import { db } from "../lib/db";
import { logger } from "../lib/logger";
import {
  normalizePlaceName,
  compactPlaceTitle,
  extractAddressInfo,
  extractAddressArea,
  syncOrderDeliveryContactPlaceLinks,
  upsertOrderPlaceAddressContext,
  qualifySharedAlias,
  stringSimilarity,
} from "../lib/addressBookAutoLink";
import {
  AUH_HOSPITAL_CANONICAL_NAME,
  classifyPlaceType,
  extractClearlyNamedHospitalTitle,
  extractClearlyNamedHotelTitle,
  isAccommodationPlaceName,
  isNamedHotel,
  isOfficialAUHHospitalAlias,
  recognizeAUHHospital,
} from "@workspace/api-zod/place-types";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 500;

/** Orders with ≥ this many entries sharing the same normalized text+city are auto-linked. */
const HIGH_CONFIDENCE_COUNT_THRESHOLD = 3;

/** String similarity ≥ this fraction (compared to existing canonical names) triggers auto-link. */
const HIGH_CONFIDENCE_SIMILARITY_THRESHOLD = 0.9;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BackfillSummary {
  total_orders_scanned: number;
  places_created: number;
  places_skipped_existing: number;
  aliases_added: number;
  order_links_created: number;
  review_queue_added: number;
  errors: Array<{ order_id: string; message: string }>;
}

interface OrderRow {
  id: string;
  workspace_owner_id: string;
  display_order_number: string | null;
  ordered_at: string | null;
  delivery_address: Record<string, unknown> | null;
  contact_phone: string | null;
  delivery_contact_ids: string[] | null;
}

interface CandidateGroup {
  normalizedText: string;
  canonicalText: string;
  area: string | null;
  cityKey: string | null; // stringified cityId or city/cityName from payload
  resolvedCityId: number | null; // matched delivery_cities.id
  orderIds: string[];
  contactIdsByOrder: Map<string, string[]>;
  phoneNumbers: Set<string>;
  rawTexts: Set<string>; // all raw address variants seen
  rawTextByOrder: Map<string, string>;
  recognizedAUH: boolean;
  recognizedHospital: boolean;
  recognizedHotel: boolean;
  isHighConfidence: boolean;
}

// normalizePlaceName, extractAddressInfo, and stringSimilarity are imported
// from ../lib/addressBookAutoLink (canonical implementations live there).

// ── City ID resolution ────────────────────────────────────────────────────────

/**
 * Given a numeric city ID from the payload, validate it belongs to the workspace's
 * city catalog. Returns the id if valid, else null.
 */
async function resolveDeliveryCityId(
  cityId: number,
): Promise<number | null> {
  const r = await db.query<{ id: number }>(
    `SELECT id FROM delivery_cities WHERE id = $1`,
    [cityId],
  );
  return r.rows[0]?.id ?? null;
}

// ── Candidate grouping ────────────────────────────────────────────────────────

type GroupKey = string; // `${normalizedText}||${cityKey}`

function groupKey(normalizedText: string, cityKey: string | null): GroupKey {
  return `${normalizedText}||${cityKey ?? ""}`;
}

// ── Main backfill function ────────────────────────────────────────────────────

export interface RunBackfillOptions {
  workspaceId: string;
  dryRun?: boolean;
}

export async function runBackfill(
  options: RunBackfillOptions,
): Promise<BackfillSummary> {
  const { workspaceId, dryRun = false } = options;

  const summary: BackfillSummary = {
    total_orders_scanned: 0,
    places_created: 0,
    places_skipped_existing: 0,
    aliases_added: 0,
    order_links_created: 0,
    review_queue_added: 0,
    errors: [],
  };

  logger.info({ workspaceId, dryRun }, "addressBookBackfill: starting");

  // Orders linked by an earlier run already have a Place, but may predate
  // contact-to-Place associations. Reconcile those rows first without
  // recalculating or changing their existing canonical Place link.
  if (!dryRun) {
    await syncContactsForExistingLinks(workspaceId);
  }

  // ── Step 1: Load orders not yet linked ──────────────────────────────────────

  const groups = new Map<GroupKey, CandidateGroup>();
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const pageRes = await db.query<OrderRow>(
      `SELECT
           o.id,
           o.workspace_owner_id,
           o.display_order_number,
           o.ordered_at,
           o.delivery_address,
           c.phone AS contact_phone,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM order_contacts recipient_oc
                JOIN contacts recipient_c ON recipient_c.id = recipient_oc.contact_id
               WHERE recipient_oc.order_id = o.id
                 AND recipient_oc.role = 'recipient'
                 AND recipient_c.workspace_owner_id = o.workspace_owner_id
             )
             THEN ARRAY(
               SELECT recipient_oc.contact_id::text
                 FROM order_contacts recipient_oc
                 JOIN contacts recipient_c ON recipient_c.id = recipient_oc.contact_id
                WHERE recipient_oc.order_id = o.id
                  AND recipient_oc.role = 'recipient'
                  AND recipient_c.workspace_owner_id = o.workspace_owner_id
             )
             ELSE ARRAY(
               SELECT customer_oc.contact_id::text
                 FROM order_contacts customer_oc
                 JOIN contacts customer_c ON customer_c.id = customer_oc.contact_id
                WHERE customer_oc.order_id = o.id
                  AND customer_oc.role = 'customer'
                  AND customer_c.workspace_owner_id = o.workspace_owner_id
             )
           END AS delivery_contact_ids
         FROM orders o
         LEFT JOIN order_contacts oc ON oc.order_id = o.id AND oc.role = 'customer'
         LEFT JOIN contacts c ON c.id = oc.contact_id
         WHERE o.workspace_owner_id = $1
           AND o.delivery_address IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM order_place_links opl WHERE opl.order_id = o.id
           )
         ORDER BY o.ordered_at ASC NULLS LAST, o.id ASC
         LIMIT $2 OFFSET $3`,
      [workspaceId, PAGE_SIZE, offset],
    );

    const rows = pageRes.rows;
    hasMore = rows.length === PAGE_SIZE;
    offset += rows.length;
    summary.total_orders_scanned += rows.length;

    for (const row of rows) {
      if (!row.delivery_address) continue;

      const { addressText, cityKey, cityId, phone } = extractAddressInfo(
        row.delivery_address as Record<string, unknown>,
      );

      if (!addressText) continue; // skip orders with no extractable address

      const addressRecord = row.delivery_address as Record<string, unknown>;
      const institutionText = [
        addressText,
        typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
        typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
        typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
      ]
        .filter(Boolean)
        .join(" | ");
      const normalized = normalizePlaceName(addressText);
      if (!normalized) continue;
      const recognizedAUH = recognizeAUHHospital(institutionText) !== null;
      const genericHospitalTitle = [
        typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
        typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
        typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
        addressText,
      ]
        .map(extractClearlyNamedHospitalTitle)
        .find((title): title is string => Boolean(title));
      const compacted = compactPlaceTitle(addressText, {
        area: extractAddressArea(row.delivery_address),
        city: cityKey && !/^\d+$/.test(cityKey) ? cityKey : null,
        placeName: typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
        landmark: typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
        storeName: typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
        privateFragments: [
          typeof addressRecord.recipientName === "string" ? addressRecord.recipientName : null,
          typeof addressRecord.recipient_name === "string" ? addressRecord.recipient_name : null,
          typeof addressRecord.contactName === "string" ? addressRecord.contactName : null,
          typeof addressRecord.contact_name === "string" ? addressRecord.contact_name : null,
          phone,
        ],
      });
      const recognizedHospital =
        recognizedAUH || genericHospitalTitle !== undefined;

      // Hotel recognition — only attempted when not a recognised hospital
      const genericHotelTitle = !recognizedHospital
        ? [
            typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
            typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
            typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
            addressText,
          ]
            .map(extractClearlyNamedHotelTitle)
            .find((title): title is string => Boolean(title))
        : undefined;
      const recognizedHotel = genericHotelTitle !== undefined;

      const canonicalText = recognizedAUH
        ? AUH_HOSPITAL_CANONICAL_NAME
        : genericHospitalTitle ?? genericHotelTitle ?? compacted.title;
      if (!canonicalText) continue;
      const isInstitution = recognizedHospital || recognizedHotel;
      const groupingText = isInstitution ? normalizePlaceName(canonicalText) : normalized;
      const key = groupKey(groupingText, cityKey);
      let group = groups.get(key);

      if (!group) {
        // Validate and resolve cityId on first encounter
        let resolvedCityId: number | null = null;
        if (cityId !== null) {
          resolvedCityId = await resolveDeliveryCityId(cityId);
        }

        group = {
          normalizedText: groupingText,
          canonicalText,
          area: extractAddressArea(row.delivery_address),
          cityKey,
          resolvedCityId,
          orderIds: [],
          contactIdsByOrder: new Map(),
          phoneNumbers: new Set(),
          rawTexts: new Set(),
          rawTextByOrder: new Map(),
          recognizedAUH,
          recognizedHospital,
          recognizedHotel,
          isHighConfidence: false,
        };
        groups.set(key, group);
      }

      group.orderIds.push(row.id);
      group.rawTexts.add(addressText.trim());
      group.rawTextByOrder.set(row.id, addressText.trim());
      group.contactIdsByOrder.set(
        row.id,
        (row.delivery_contact_ids ?? []).filter(Boolean),
      );
      if (phone) group.phoneNumbers.add(phone);
      if (row.contact_phone) group.phoneNumbers.add(row.contact_phone);
    }
  }

  logger.info(
    { workspaceId, candidateGroups: groups.size },
    "addressBookBackfill: grouping complete",
  );

  // ── Institution group consolidation ──────────────────────────────────────────
  // Merge institution groups (hospitals/hotels) with similarity ≥ 0.75 within
  // the same city so that minor name variants ("Rassoul Al Azam Hospital Dept"
  // vs "Rassoul Al Azam Hospital") do not produce separate place records.

  const INSTITUTION_CONSOLIDATION_THRESHOLD = 0.75;
  const institutionKeys = Array.from(groups.keys()).filter((key) => {
    const g = groups.get(key)!;
    return g.recognizedHospital || g.recognizedHotel;
  });

  const mergedKeys = new Set<string>();
  for (let i = 0; i < institutionKeys.length; i++) {
    const keyA = institutionKeys[i];
    if (mergedKeys.has(keyA)) continue;
    const groupA = groups.get(keyA);
    if (!groupA) continue;

    for (let j = i + 1; j < institutionKeys.length; j++) {
      const keyB = institutionKeys[j];
      if (mergedKeys.has(keyB)) continue;
      const groupB = groups.get(keyB);
      if (!groupB) continue;

      if (groupA.cityKey !== groupB.cityKey) continue;

      const sim = stringSimilarity(groupA.normalizedText, groupB.normalizedText);
      if (sim < INSTITUTION_CONSOLIDATION_THRESHOLD) continue;

      const aIsLarger = groupA.orderIds.length >= groupB.orderIds.length;
      const [survivor, loser, loserKey] = aIsLarger
        ? [groupA, groupB, keyB]
        : [groupB, groupA, keyA];

      // Adopt the shorter canonical text as it is less likely to contain
      // department or sub-unit noise.
      if (loser.canonicalText.length < survivor.canonicalText.length) {
        survivor.canonicalText = loser.canonicalText;
        survivor.normalizedText = normalizePlaceName(loser.canonicalText);
      }

      for (const orderId of loser.orderIds) survivor.orderIds.push(orderId);
      for (const [orderId, contacts] of loser.contactIdsByOrder) {
        survivor.contactIdsByOrder.set(orderId, contacts);
      }
      for (const phone of loser.phoneNumbers) survivor.phoneNumbers.add(phone);
      for (const text of loser.rawTexts) survivor.rawTexts.add(text);
      for (const [orderId, text] of loser.rawTextByOrder) {
        survivor.rawTextByOrder.set(orderId, text);
      }

      groups.delete(loserKey);
      mergedKeys.add(loserKey);

      logger.info(
        { loserKey, survivorKey: aIsLarger ? keyA : keyB, sim: sim.toFixed(3) },
        "addressBookBackfill: merged similar institution groups",
      );

      if (!aIsLarger) break; // groupA was the loser; advance outer loop
    }
  }

  if (!dryRun) {
    await reconcileLegacyAutoGeneratedTitles(workspaceId);
  }

  // ── Step 2: Score confidence ─────────────────────────────────────────────────

  // Load existing place canonical names for similarity comparison
  const existingPlaces = await db.query<{ id: string; canonical_name: string; city_id: number | null }>(
    `SELECT id, canonical_name, city_id FROM places
      WHERE workspace_owner_id = $1 AND archived_at IS NULL`,
    [workspaceId],
  );

  const existingByKey = new Map<string, string>(); // canonical+city → place id
  for (const p of existingPlaces.rows) {
    const k = `${normalizePlaceName(p.canonical_name)}||${p.city_id ?? ""}`;
    existingByKey.set(k, p.id);
  }

  for (const [, group] of groups) {
    const countHighConf = group.orderIds.length >= HIGH_CONFIDENCE_COUNT_THRESHOLD;

    // Check similarity against existing places with same city
    let similarityHighConf = false;
    for (const existing of existingPlaces.rows) {
      if (existing.city_id !== group.resolvedCityId) continue; // also handles both-null case via ===
      const sim = stringSimilarity(
        group.normalizedText,
        normalizePlaceName(existing.canonical_name),
      );
      if (sim >= HIGH_CONFIDENCE_SIMILARITY_THRESHOLD) {
        similarityHighConf = true;
        break;
      }
    }

    group.isHighConfidence = countHighConf || similarityHighConf;
  }

  // ── Step 3: Dry-run short-circuit ────────────────────────────────────────────

  if (dryRun) {
    let highConfCount = 0;
    let lowConfCount = 0;

    // Collect duplicate candidate groups (same normalized+city)
    const duplicatePairs: string[] = [];
    const seen = new Map<string, string>();
    for (const [key, group] of groups) {
      const prior = seen.get(group.normalizedText);
      if (prior) {
        duplicatePairs.push(`"${group.canonicalText}" (${group.orderIds.length} orders) conflicts with a prior group`);
      } else {
        seen.set(group.normalizedText, key);
      }

      if (group.isHighConfidence) highConfCount++;
      else lowConfCount++;
    }

    logger.info(
      {
        workspaceId,
        dryRun: true,
        total_orders_scanned: summary.total_orders_scanned,
        candidate_groups: groups.size,
        high_confidence_auto_links: highConfCount,
        ambiguous_needs_review: lowConfCount,
        duplicate_candidate_groups: duplicatePairs.length,
      },
      "addressBookBackfill dry-run report",
    );

    // Return a preview summary (no DB writes)
    return {
      ...summary,
      places_created: highConfCount + lowConfCount, // would-be creates
      review_queue_added: lowConfCount,
      order_links_created: Array.from(groups.values()).reduce(
        (acc, g) => acc + g.orderIds.length,
        0,
      ),
    };
  }

  // ── Step 4: Import (with DB writes) ──────────────────────────────────────────

  for (const [, group] of groups) {
    try {
      const placeId = await upsertPlace(group, workspaceId, summary);
      if (!placeId) continue;

      // Create order_place_links
      for (const orderId of group.orderIds) {
        const linked = await insertOrderLink(orderId, placeId, workspaceId);
        if (linked) summary.order_links_created++;
        const rawAddress = group.rawTextByOrder.get(orderId) ?? group.canonicalText;
        await upsertOrderPlaceAddressContext({
          workspaceId,
          orderId,
          placeId,
          rawAddress,
          cityId: group.resolvedCityId,
        });
        await syncOrderDeliveryContactPlaceLinks({
          workspaceId,
          orderId,
          placeId,
          contactIds: group.contactIdsByOrder.get(orderId) ?? [],
          rawAddress,
          area: group.area,
          cityId: group.resolvedCityId,
        });
      }

      if (!group.isHighConfidence) {
        summary.review_queue_added++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const sampleOrderId = group.orderIds[0] ?? "unknown";
      summary.errors.push({ order_id: sampleOrderId, message: msg });
      logger.error({ err, sampleOrderId, group: group.canonicalText }, "addressBookBackfill: error processing group");
    }
  }

  logger.info({ workspaceId, summary }, "addressBookBackfill: complete");
  return summary;
}

/**
 * Backfill contact associations for orders that already have an order-place
 * link. This is separate from the unlinked-order import so an existing manual
 * Place choice is never replaced by a newly calculated match.
 */
async function syncContactsForExistingLinks(workspaceId: string): Promise<void> {
  const linked = await db.query<{
    order_id: string;
    place_id: string;
    delivery_address: Record<string, unknown> | null;
    delivery_contact_ids: string[] | null;
  }>(
    `SELECT opl.order_id, opl.place_id, o.delivery_address,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM order_contacts recipient_oc
                 JOIN contacts recipient_c ON recipient_c.id = recipient_oc.contact_id
                WHERE recipient_oc.order_id = o.id
                  AND recipient_oc.role = 'recipient'
                  AND recipient_c.workspace_owner_id = o.workspace_owner_id
              )
              THEN ARRAY(
                SELECT recipient_oc.contact_id::text
                  FROM order_contacts recipient_oc
                  JOIN contacts recipient_c ON recipient_c.id = recipient_oc.contact_id
                 WHERE recipient_oc.order_id = o.id
                   AND recipient_oc.role = 'recipient'
                   AND recipient_c.workspace_owner_id = o.workspace_owner_id
              )
              ELSE ARRAY(
                SELECT customer_oc.contact_id::text
                  FROM order_contacts customer_oc
                  JOIN contacts customer_c ON customer_c.id = customer_oc.contact_id
                 WHERE customer_oc.order_id = o.id
                   AND customer_oc.role = 'customer'
                   AND customer_c.workspace_owner_id = o.workspace_owner_id
              )
            END AS delivery_contact_ids
       FROM order_place_links opl
       JOIN orders o ON o.id = opl.order_id
      WHERE opl.workspace_owner_id = $1
        AND o.workspace_owner_id = $1
        AND o.delivery_address IS NOT NULL`,
    [workspaceId],
  );

  const cityCache = new Map<number, number | null>();
  for (const row of linked.rows) {
    if (!row.delivery_address) continue;
    const { addressText, cityId } = extractAddressInfo(row.delivery_address);
    if (!addressText) continue;

    let resolvedCityId: number | null = null;
    if (cityId !== null) {
      if (!cityCache.has(cityId)) {
        cityCache.set(cityId, await resolveDeliveryCityId(cityId));
      }
      resolvedCityId = cityCache.get(cityId) ?? null;
    }

    await syncOrderDeliveryContactPlaceLinks({
      workspaceId,
      orderId: row.order_id,
      placeId: row.place_id,
      contactIds: (row.delivery_contact_ids ?? []).filter(Boolean),
      rawAddress: addressText,
      area: extractAddressArea(row.delivery_address),
      cityId: resolvedCityId,
    });
    await upsertOrderPlaceAddressContext({
      workspaceId,
      orderId: row.order_id,
      placeId: row.place_id,
      rawAddress: addressText,
      cityId: resolvedCityId,
    });
  }
}

/**
 * Idempotently compact legacy system-created titles. Staff-authored names have
 * `canonical_name_source = 'manual'` and are intentionally excluded. Raw order
 * addresses remain in immutable snapshots and the private context ledger.
 */
export async function reconcileLegacyAutoGeneratedTitles(workspaceId: string): Promise<void> {
  const places = await db.query<{
    id: string;
    canonical_name: string;
    place_type: string;
    area: string | null;
    aliases: string[];
    delivery_address: Record<string, unknown> | null;
  }>(
    `SELECT p.id, p.canonical_name, p.place_type, p.area,
            ARRAY(
              SELECT pa.alias_text
                FROM place_aliases pa
               WHERE pa.place_id = p.id
                 AND pa.deleted_at IS NULL
            ) AS aliases,
            (
              SELECT o.delivery_address
                FROM order_place_links opl
                JOIN orders o ON o.id = opl.order_id
               WHERE opl.place_id = p.id
                 AND o.workspace_owner_id = p.workspace_owner_id
               ORDER BY opl.linked_at ASC
               LIMIT 1
            ) AS delivery_address
       FROM places p
      WHERE p.workspace_owner_id = $1
        AND p.archived_at IS NULL
        AND p.canonical_name_source = 'auto'`,
    [workspaceId],
  );

  for (const place of places.rows) {
    const rawAddress = place.delivery_address
      ? extractAddressInfo(place.delivery_address).addressText
      : null;
    const hospitalEvidence = [place.canonical_name, rawAddress]
      .filter(Boolean)
      .join(" | ");
    const recognizedAUH = recognizeAUHHospital(hospitalEvidence);
    const genericHospitalTitle = [place.canonical_name, rawAddress]
      .map(extractClearlyNamedHospitalTitle)
      .find((title): title is string => Boolean(title));
    const compacted = recognizedAUH
      ? { title: AUH_HOSPITAL_CANONICAL_NAME, removedFragments: [] }
      : genericHospitalTitle
        ? { title: genericHospitalTitle, removedFragments: [] }
      : compactPlaceTitle(rawAddress ?? place.canonical_name, {
          area: place.area,
        });
    const recognizedHospital =
      recognizedAUH !== null || genericHospitalTitle !== undefined;
    if (compacted.title && compacted.title !== place.canonical_name) {
      const updated = await db.query<{ id: string }>(
        `UPDATE places
            SET canonical_name = $1, updated_at = now()
          WHERE id = $2
            AND workspace_owner_id = $3
            AND canonical_name_source = 'auto'
            AND canonical_name = $4
            AND NOT EXISTS (
              SELECT 1
                FROM places existing
               WHERE existing.workspace_owner_id = $3
                 AND existing.id <> $2
                 AND existing.archived_at IS NULL
                 AND lower(existing.canonical_name) = lower($1)
                 AND (
                   existing.city_id = (
                     SELECT city_id FROM places WHERE id = $2
                   )
                   OR (
                     existing.city_id IS NULL
                     AND (SELECT city_id FROM places WHERE id = $2) IS NULL
                   )
                 )
            )
          RETURNING id`,
        [compacted.title, place.id, workspaceId, place.canonical_name],
      );
      if (updated.rows[0]) {
        await db.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, source, notes)
           VALUES ($1, $2, 'historical_reconciliation', $3)`,
          [
            place.id,
            recognizedAUH ? "institution_recognized" : "title_compacted",
            recognizedAUH
              ? "Recognized AUH Hospital and removed delivery-specific text from the automatic title."
              : "Compacted auto-generated title; original delivery text remains private to linked orders.",
          ],
        );
      }
    }

    if (recognizedHospital && place.place_type?.trim().toLowerCase() === "residence") {
      const promoted = await db.query<{ id: string }>(
        `UPDATE places
            SET place_type = 'hospital', updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $2
            AND canonical_name_source = 'auto'
            AND lower(trim(place_type)) = 'residence'
          RETURNING id`,
        [place.id, workspaceId],
      );
      if (promoted.rows[0]) {
        await db.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, source, notes)
           VALUES ($1, 'place_type_corrected', 'historical_reconciliation', $2)`,
          [
            place.id,
            "Promoted an automatic Residence to Hospital after deterministic hospital recognition; linked orders and aliases were preserved.",
          ],
        );
      }
    }
  }

  // Old order ingestion used raw delivery text as an alias. Legacy aliases on
  // auto-created places are untrusted until there is explicit post-migration
  // owner approval provenance. Never infer that approval from alias-shaped
  // delivery text.
  const aliases = await db.query<{
    id: string;
    place_id: string;
    canonical_name: string;
    alias_text: string;
    source: string;
    approval_state: string;
  }>(
    `SELECT pa.id, pa.place_id, p.canonical_name, pa.alias_text, pa.source, pa.approval_state
       FROM place_aliases pa
       JOIN places p ON p.id = pa.place_id
      WHERE p.workspace_owner_id = $1
        AND p.canonical_name_source = 'auto'
        AND p.archived_at IS NULL
        AND pa.deleted_at IS NULL`,
    [workspaceId],
  );
  for (const alias of aliases.rows) {
    const qualification = qualifySharedAlias(alias.alias_text);
    const explicitlyApproved =
      alias.approval_state === "approved" &&
      ["manual", "approved_landmark", "approved_transliteration"].includes(alias.source);
    const isReusableAUHIdentity =
      isOfficialAUHHospitalAlias(alias.alias_text) && qualification.accepted;
    if ((qualification.accepted && explicitlyApproved) || isReusableAUHIdentity) continue;
    await db.query(
      `UPDATE place_aliases
          SET deleted_at = now(), source = 'historical_reconciliation'
        WHERE id = $1 AND deleted_at IS NULL`,
      [alias.id],
    );
  }
}
/**
 * Upsert a place for a candidate group.
 * - If a place with the same normalized canonical_name + city_id already exists → skip, return existing id.
 * - Otherwise insert and record a verification event.
 * Returns the place UUID, or null on unrecoverable error.
 */
async function upsertPlace(
  group: CandidateGroup,
  workspaceId: string,
  summary: BackfillSummary,
): Promise<string | null> {
  const canonicalName = group.canonicalText;
  const cityId = group.resolvedCityId;

  // Check existence first (handles NULL city_id case where ON CONFLICT won't fire)
  const existing = await db.query<{ id: string; place_type: string }>(
    `SELECT id, place_type FROM places
      WHERE workspace_owner_id = $1
        AND lower(canonical_name) = lower($2)
        AND (city_id = $3 OR (city_id IS NULL AND $3::integer IS NULL))
        AND archived_at IS NULL`,
    [workspaceId, canonicalName, cityId],
  );

  if (existing.rows[0]) {
    if (group.recognizedHospital && existing.rows[0].place_type.trim().toLowerCase() === "residence") {
      const promoted = await db.query<{ id: string }>(
        `UPDATE places
            SET place_type = 'hospital', updated_at = now()
          WHERE id = $1
            AND lower(trim(place_type)) = 'residence'
            AND canonical_name_source = 'auto'
         RETURNING id`,
        [existing.rows[0].id],
      );
      if (promoted.rows[0]) {
        await db.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, source, notes)
           VALUES ($1, 'place_type_corrected', 'historical_reconciliation', $2)`,
          [
            existing.rows[0].id,
            "Promoted an automatic Residence to Hospital after deterministic hospital recognition; order delivery details remain private.",
          ],
        );
      }
    }
    if (
      group.recognizedHotel &&
      existing.rows[0].place_type.trim().toLowerCase() === "residence"
    ) {
      const promoted = await db.query<{ id: string }>(
        `UPDATE places
            SET place_type = 'hotel', updated_at = now()
          WHERE id = $1
            AND lower(trim(place_type)) = 'residence'
            AND canonical_name_source = 'auto'
         RETURNING id`,
        [existing.rows[0].id],
      );
      if (promoted.rows[0]) {
        await db.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, source, notes)
           VALUES ($1, 'place_type_corrected', 'historical_reconciliation', $2)`,
          [
            existing.rows[0].id,
            "Promoted an automatic Residence to Hotel after deterministic hotel recognition; order delivery details remain private.",
          ],
        );
      }
    }
    if (
      existing.rows[0].place_type.trim().toLowerCase() === "residence" &&
      Array.from(group.rawTexts).some((name) => isAccommodationPlaceName(name))
    ) {
      await db.query(
        `UPDATE places
            SET place_type = 'hotel', updated_at = now()
          WHERE id = $1 AND lower(trim(place_type)) = 'residence'`,
        [existing.rows[0].id],
      );
    }
    summary.places_skipped_existing++;
    return existing.rows[0].id;
  }

  if (group.recognizedAUH) {
    const aliasExisting = await db.query<{ id: string; place_type: string }>(
      `SELECT p.id, p.place_type
         FROM places p
         JOIN place_aliases pa ON pa.place_id = p.id
        WHERE p.workspace_owner_id = $1
          AND p.archived_at IS NULL
          AND (p.city_id = $2 OR (p.city_id IS NULL AND $2::integer IS NULL))
          AND pa.deleted_at IS NULL
          AND pa.normalized_alias = ANY($3::text[])
        ORDER BY pa.created_at ASC
        LIMIT 1`,
      [
        workspaceId,
        cityId,
        [
          normalizePlaceName("AUH"),
          normalizePlaceName("AUH Hospital"),
          normalizePlaceName("American University Hospital"),
          normalizePlaceName("American University of Beirut Hospital"),
        ],
      ],
    );
    if (aliasExisting.rows[0]) {
      if (aliasExisting.rows[0].place_type.trim().toLowerCase() === "residence") {
        const promoted = await db.query<{ id: string }>(
          `UPDATE places
              SET place_type = 'hospital', updated_at = now()
            WHERE id = $1
              AND lower(trim(place_type)) = 'residence'
              AND canonical_name_source = 'auto'
           RETURNING id`,
          [aliasExisting.rows[0].id],
        );
        if (promoted.rows[0]) {
          await db.query(
            `INSERT INTO place_verification_events
               (place_id, event_type, source, notes)
             VALUES ($1, 'place_type_corrected', 'historical_reconciliation', $2)`,
            [
              aliasExisting.rows[0].id,
              "Promoted an automatic Residence to Hospital after deterministic hospital recognition; order delivery details remain private.",
            ],
          );
        }
      }
      summary.places_skipped_existing++;
      return aliasExisting.rows[0].id;
    }
  }

  // Insert new place
  const insertRes = await db.query<{ id: string }>(
    `INSERT INTO places
        (workspace_owner_id, canonical_name, canonical_name_source, place_type, city_id,
        verification_state, created_at, updated_at)
       VALUES ($1, $2, 'auto', $3, $4, 'unverified', now(), now())
     ON CONFLICT (workspace_owner_id, city_id, canonical_name) DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      canonicalName,
      classifyPlaceType(
        group.recognizedHospital ? "hospital" : group.recognizedHotel ? "hotel" : "residence",
        [canonicalName, ...Array.from(group.rawTexts)],
      ),
      cityId,
    ],
  );

  if (!insertRes.rows[0]) {
    // Race: was inserted by another concurrent run or the ON CONFLICT fired
    const retryRes = await db.query<{ id: string }>(
      `SELECT id FROM places
        WHERE workspace_owner_id = $1
          AND lower(canonical_name) = lower($2)
          AND (city_id = $3 OR (city_id IS NULL AND $3::integer IS NULL))
          AND archived_at IS NULL`,
      [workspaceId, canonicalName, cityId],
    );
    if (retryRes.rows[0]) {
      summary.places_skipped_existing++;
      return retryRes.rows[0].id;
    }
    return null; // truly could not upsert
  }

  const placeId = insertRes.rows[0].id;
  summary.places_created++;

  // Record creation event
  await db.query(
    `INSERT INTO place_verification_events
       (place_id, event_type, to_state, source, notes)
     VALUES ($1, 'created', 'unverified', 'historical_import', $2)`,
    [
      placeId,
      group.isHighConfidence
        ? `Auto-imported: ${group.orderIds.length} historical orders`
        : `Queued for review: ${group.orderIds.length} historical order(s), low confidence`,
    ],
  );

  return placeId;
}

/**
 * Insert a place alias if not already present for this place.
 * Returns true if a new row was inserted.
 */
async function insertAliasIfNew(
  placeId: string,
  aliasText: string,
  normalizedAlias: string,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO place_aliases (place_id, alias_text, normalized_alias)
     VALUES ($1, $2, $3)
     ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
    [placeId, aliasText, normalizedAlias],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Insert an order_place_link row if one doesn't exist yet.
 * Returns true if a new row was inserted.
 */
async function insertOrderLink(
  orderId: string,
  placeId: string,
  workspaceId: string,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id) DO NOTHING`,
    [workspaceId, orderId, placeId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const workspaceIdx = args.indexOf("--workspace");
  const workspaceId =
    workspaceIdx >= 0 ? args[workspaceIdx + 1] : undefined;

  const dryRun = args.includes("--dry-run");

  if (!workspaceId) {
    console.error("Usage: ts-node src/jobs/addressBookBackfill.ts --workspace <owner_id> [--dry-run]");
    process.exit(1);
  }

  console.log(
    JSON.stringify({ status: "starting", workspaceId, dryRun }, null, 2),
  );

  try {
    const summary = await runBackfill({ workspaceId, dryRun });
    console.log(JSON.stringify({ status: "complete", summary }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ status: "error", message: String(err) }, null, 2));
    process.exit(1);
  } finally {
    await db.end();
  }
}

// Run main() only when explicitly invoked as a CLI script.
// import.meta.url is unreliable inside a bundle (it points to the bundle, not this file),
// so we gate on an env var instead.
if (process.env.ADDRESS_BOOK_BACKFILL_CLI === "1") {
  main();
}
