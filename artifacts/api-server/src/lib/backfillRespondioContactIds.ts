/**
 * One-time idempotent backfill: link all contacts that have a phone number
 * but no respondio_contact_id to respond.io.
 *
 * Safe to run on every startup — already-synced contacts are skipped by the
 * WHERE clause, and the function exits early when nothing needs doing.
 * Contacts with invalid phone formats are counted as skipped (they keep
 * respondio_contact_id IS NULL but never trigger network calls, so re-runs
 * don't retry-loop them against the API).
 *
 * Rate limit: respond.io allows ~10 req/sec on the Developer API. We process
 * contacts in batches of 5 with a 600 ms pause between batches, staying
 * comfortably under the limit even when a lookup needs the follow-up GET.
 */

import { db } from "./db.js";
import { findOrCreateContactByPhone, isRespondIoEnabled } from "./respondio.js";
import { logger } from "./logger.js";

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 600;

type ContactRow = {
  id: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill respond.io contact IDs for all contacts that have a phone number
 * but no respond.io contact ID yet. Logs a summary when done. No-ops silently
 * when respond.io is not configured or all contacts are already synced.
 */
export async function backfillRespondioContactIds(): Promise<void> {
  if (!isRespondIoEnabled()) {
    logger.debug("backfillRespondioContactIds: respond.io not configured, skipping");
    return;
  }

  let total: number;
  try {
    const countRes = await db.query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM contacts
        WHERE phone IS NOT NULL AND phone <> ''
          AND respondio_contact_id IS NULL
          AND archived_at IS NULL`,
    );
    total = parseInt(countRes.rows[0]?.total ?? "0", 10);
  } catch (err) {
    logger.error({ err }, "backfillRespondioContactIds: failed to count contacts");
    return;
  }

  if (total === 0) {
    logger.debug("backfillRespondioContactIds: all contacts already synced, nothing to do");
    return;
  }

  logger.info({ total }, "backfillRespondioContactIds: starting backfill");

  let processed = 0;
  let synced = 0;
  let skipped = 0; // phone_format_invalid
  let failed = 0; // null returned from respond.io

  // Cursor-based pagination: walk contacts ordered by id so re-runs pick up
  // from where they left off without needing an offset.
  let cursor = "00000000-0000-0000-0000-000000000000";

  while (true) {
    let batch: { rows: ContactRow[] };
    try {
      batch = await db.query<ContactRow>(
        `SELECT id, phone, first_name, last_name FROM contacts
          WHERE phone IS NOT NULL AND phone <> ''
            AND respondio_contact_id IS NULL
            AND archived_at IS NULL
            AND id > $1
          ORDER BY id ASC
          LIMIT $2`,
        [cursor, BATCH_SIZE],
      );
    } catch (err) {
      logger.error({ err, cursor }, "backfillRespondioContactIds: batch query failed, aborting");
      break;
    }

    if (batch.rows.length === 0) break;

    for (const contact of batch.rows) {
      processed++;
      try {
        const result = await findOrCreateContactByPhone(
          contact.phone,
          contact.first_name,
          contact.last_name,
        );

        if (!result) {
          failed++;
          logger.warn(
            { contactId: contact.id, phone: contact.phone, processed, total },
            "backfillRespondioContactIds: respond.io returned null",
          );
        } else if (result === "phone_format_invalid") {
          skipped++;
          logger.debug(
            { contactId: contact.id, phone: contact.phone },
            "backfillRespondioContactIds: skipped (bad phone format)",
          );
          await db
            .query(
              `UPDATE contacts SET respondio_sync_status = 'phone_format_invalid'
                WHERE id = $1 AND respondio_contact_id IS NULL`,
              [contact.id],
            )
            .catch((e: unknown) =>
              logger.warn(
                { e, contactId: contact.id },
                "backfillRespondioContactIds: failed to persist phone_format_invalid status",
              ),
            );
        } else {
          await db.query(
            `UPDATE contacts
                SET respondio_contact_id = $1,
                    respondio_sync_status = 'synced'
              WHERE id = $2 AND respondio_contact_id IS NULL`,
            [result, contact.id],
          );
          synced++;
          logger.info(
            { contactId: contact.id, respondioContactId: result, processed, total },
            "backfillRespondioContactIds: synced",
          );
        }
      } catch (err) {
        failed++;
        logger.warn(
          { err, contactId: contact.id, phone: contact.phone },
          "backfillRespondioContactIds: unexpected error processing contact",
        );
      }
    }

    cursor = batch.rows[batch.rows.length - 1]!.id;

    // Pause between batches to respect respond.io rate limits.
    if (batch.rows.length === BATCH_SIZE) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  logger.info(
    { synced, skipped, failed, total: processed },
    "backfillRespondioContactIds: done",
  );
}
