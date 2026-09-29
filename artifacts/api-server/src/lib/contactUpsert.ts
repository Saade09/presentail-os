import { db, withTransaction } from "./db";
import { queueGenderInference } from "./genderInference";
import { buildPhoneSearchTokens } from "./contactSearchNormalize";
import {
  isRespondIoEnabled,
  findOrCreateContactByPhone,
  updateContactName,
} from "./respondio";
import { logger } from "./logger";
import { normalizePersonName } from "./personName";

export type RespondIoContactSyncResult =
  | { status: "synced"; contactId: string }
  | { status: "already_synced"; contactId: string }
  | { status: "disabled" | "contact_not_found" | "phone_required" | "phone_format_invalid" }
  | { status: "provider_unavailable" | "persistence_failed" | "lookup_failed" };

const respondIoSyncInFlight = new Map<string, Promise<RespondIoContactSyncResult>>();

/**
 * Schedule a best-effort respond.io link for a persisted OS contact.
 *
 * The persisted contact is checked immediately before the provider call, so
 * callers can safely request a sync after either creating a contact or adding
 * its first phone number. Concurrent requests for the same contact share one
 * provider attempt. All failures are contained here and never affect the OS
 * write that scheduled the sync.
 */
export function syncContactToRespondIo(
  contactId: string,
): Promise<RespondIoContactSyncResult> {
  if (!isRespondIoEnabled()) return Promise.resolve({ status: "disabled" });

  const inFlight = respondIoSyncInFlight.get(contactId);
  if (inFlight) return inFlight;

  const sync = (async (): Promise<RespondIoContactSyncResult> => {
    try {
      const existing = await db.query<{
        phone: string | null;
        first_name: string | null;
        last_name: string | null;
        respondio_contact_id: string | null;
      }>(
        `SELECT phone, first_name, last_name, respondio_contact_id
           FROM contacts
          WHERE id = $1
          LIMIT 1`,
        [contactId],
      );
      const contact = existing.rows[0];
      if (!contact) return { status: "contact_not_found" };
      if (contact.respondio_contact_id) {
        return { status: "already_synced", contactId: contact.respondio_contact_id };
      }
      if (!contact.phone) return { status: "phone_required" };

      let respondioContactId: string | "phone_format_invalid" | null;
      try {
        respondioContactId = await findOrCreateContactByPhone(
          contact.phone,
          contact.first_name,
          contact.last_name,
        );
      } catch (err) {
        logger.warn({ err, contactId }, "respondio: provider request failed");
        await db
          .query(
            `UPDATE contacts SET respondio_sync_status = 'provider_unavailable'
              WHERE id = $1`,
            [contactId],
          )
          .catch((e: unknown) =>
            logger.warn({ e, contactId }, "respondio: failed to persist sync status"),
          );
        return { status: "provider_unavailable" };
      }
      if (!respondioContactId) {
        await db
          .query(
            `UPDATE contacts SET respondio_sync_status = 'provider_unavailable'
              WHERE id = $1`,
            [contactId],
          )
          .catch((e: unknown) =>
            logger.warn({ e, contactId }, "respondio: failed to persist sync status"),
          );
        return { status: "provider_unavailable" };
      }
      if (respondioContactId === "phone_format_invalid") {
        await db
          .query(
            `UPDATE contacts SET respondio_sync_status = 'phone_format_invalid'
              WHERE id = $1`,
            [contactId],
          )
          .catch((e: unknown) =>
            logger.warn({ e, contactId }, "respondio: failed to persist sync status"),
          );
        return { status: "phone_format_invalid" };
      }

      try {
        await db.query(
          `UPDATE contacts
              SET respondio_contact_id = $1,
                  respondio_sync_status = 'synced'
            WHERE id = $2
              AND respondio_contact_id IS NULL`,
          [respondioContactId, contactId],
        );
        return { status: "synced", contactId: respondioContactId };
      } catch (err) {
        logger.warn({ err, contactId }, "respondio: failed to persist contact id");
        return { status: "persistence_failed" };
      }
    } catch (err) {
      logger.warn({ err, contactId }, "respondio: contact sync failed");
      return { status: "lookup_failed" };
    }
  })();

  respondIoSyncInFlight.set(contactId, sync);
  void sync.finally(() => {
    if (respondIoSyncInFlight.get(contactId) === sync) {
      respondIoSyncInFlight.delete(contactId);
    }
  });
  return sync;
}

export type ContactInput = {
  workspaceOwnerId: string;
  source?: string | null;
  externalContactId?: string | null;
  accountId?: string | null;
  isGuest?: boolean;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  addresses?: unknown;
  metadata?: unknown;
  /**
   * When `true`, atomically sets `whatsapp_consent = TRUE` on the contact row
   * as part of the upsert. A false/absent value never revokes existing consent.
   */
  whatsappConsent?: boolean;
};

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) return null;
  return trimmed;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hasLeadingPlus = raw.trimStart().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return hasLeadingPlus ? `+${digits}` : digits;
}

function normalizedNameValue(raw: string | null | undefined): string | null {
  return normalizePersonName(raw);
}

/**
 * A contact can be created from WhatsApp before checkout, in which case the
 * phone number may be stored as its name. Compare digits so formatting and a
 * leading "+" do not prevent the repair, but do not accept labels or other
 * text as a placeholder.
 */
export function isPhoneNumberPlaceholderName(
  name: string | null | undefined,
  phone: string | null | undefined,
): boolean {
  if (!name || !phone) return false;
  // A phone placeholder may use common formatting punctuation, but must not
  // contain a label or any other alphabetic/text content.
  if (/[^\d\s+().-]/.test(name)) return false;
  const nameDigits = name.replace(/\D/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  return name.trim() !== "" && phoneDigits.length > 0 && nameDigits === phoneDigits;
}

export type FirstOrderBuyerName = {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
};

type ContactRepairRow = {
  id: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  respondio_contact_id: string | null;
};

function buyerNameParts(
  buyer: FirstOrderBuyerName,
): { firstName: string | null; lastName: string | null; displayName: string | null } {
  let firstName = normalizedNameValue(buyer.firstName);
  let lastName = normalizedNameValue(buyer.lastName);
  let displayName = normalizedNameValue(buyer.displayName);

  if (!displayName) {
    displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
  }
  if (!firstName && displayName) {
    const parts = displayName.split(" ");
    firstName = parts[0] ?? null;
    lastName = parts.slice(1).join(" ") || null;
  }
  return { firstName, lastName, displayName };
}

/**
 * Repair a phone-only customer name after a newly-created first order.
 *
 * The current order must already be linked with role "customer", and there
 * must be no other customer order for the contact. This makes the function
 * safe to call from every ingest path while keeping retries and later orders
 * from broadening the rename. Every provider operation is best-effort.
 */
export async function refreshPhonePlaceholderContactAfterFirstOrder(opts: {
  workspaceOwnerId: string;
  contactId: string;
  orderId: string;
  buyer: FirstOrderBuyerName;
}): Promise<boolean> {
  const buyerName = buyerNameParts(opts.buyer);
  if (!buyerName.displayName) return false;

  try {
    const result = await db.query<ContactRepairRow>(
      `SELECT c.id, c.phone, c.first_name, c.last_name, c.display_name,
              c.respondio_contact_id
         FROM contacts c
        WHERE c.id = $1
          AND c.workspace_owner_id = $2
          AND EXISTS (
                SELECT 1
                  FROM order_contacts current_oc
                 WHERE current_oc.order_id = $3
                   AND current_oc.contact_id = c.id
                   AND current_oc.role = 'customer'
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM order_contacts prior_oc
                  JOIN orders prior_order ON prior_order.id = prior_oc.order_id
                 WHERE prior_oc.contact_id = c.id
                   AND prior_oc.role = 'customer'
                   AND prior_order.id <> $3
              )
        LIMIT 1`,
      [opts.contactId, opts.workspaceOwnerId, opts.orderId],
    );
    const contact = result.rows[0];
    if (!contact || !contact.phone) return false;

    const currentNames = [contact.first_name, contact.last_name, contact.display_name]
      .map(normalizedNameValue)
      .filter((name): name is string => Boolean(name));
    const hasPhonePlaceholder = currentNames.some((name) =>
      isPhoneNumberPlaceholderName(name, contact.phone),
    );
    const hasMeaningfulName = currentNames.some(
      (name) => !isPhoneNumberPlaceholderName(name, contact.phone),
    );
    if (!hasPhonePlaceholder || hasMeaningfulName) return false;
    if (isPhoneNumberPlaceholderName(buyerName.displayName, contact.phone)) return false;

    const repairedFirstName = isPhoneNumberPlaceholderName(contact.first_name, contact.phone)
      ? buyerName.firstName
      : contact.first_name;
    const repairedLastName = isPhoneNumberPlaceholderName(contact.last_name, contact.phone)
      ? buyerName.lastName
      : contact.last_name;
    const repairedDisplayName = isPhoneNumberPlaceholderName(contact.display_name, contact.phone)
      ? buyerName.displayName
      : contact.display_name;

    await db.query(
      `UPDATE contacts
          SET first_name = $1,
              last_name = $2,
              display_name = $3,
              updated_at = now()
        WHERE id = $4
          AND workspace_owner_id = $5`,
      [
        repairedFirstName,
        repairedLastName,
        repairedDisplayName,
        opts.contactId,
        opts.workspaceOwnerId,
      ],
    );

    if (contact.respondio_contact_id) {
      await updateContactName(
        contact.respondio_contact_id,
        buyerName.firstName,
        buyerName.lastName,
      );
    } else {
      const syncResult = await syncContactToRespondIo(opts.contactId);
      if (
        syncResult.status === "provider_unavailable" ||
        syncResult.status === "persistence_failed" ||
        syncResult.status === "lookup_failed"
      ) {
        return false;
      }
    }
    return true;
  } catch (err) {
    logger.warn(
      { err, contactId: opts.contactId, orderId: opts.orderId },
      "contact first-order phone-placeholder repair failed",
    );
    return false;
  }
}

/** Format a string[] as a Postgres array literal. */
function pgTextArray(arr: string[]): string {
  return `{${arr.map((t) => `"${t.replace(/"/g, '\\"')}"`)}}`;
}

type ContactRow = { id: string };

type ContactResolutionRow = ContactRow & {
  email: string | null;
  phone: string | null;
  archived_at: Date | null;
  phone_match: boolean;
  email_match: boolean;
};

export type ContactCreateResolution = {
  contactId: string;
  existing: boolean;
};

/**
 * Returns true if the error is a Postgres unique-violation (23505) whose
 * constraint name contains `constraintSubstr` (e.g. "phone" / "email").
 */
function isUniqueViolation(err: unknown, constraintSubstr: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string };
  return (
    e.code === "23505" &&
    typeof e.constraint === "string" &&
    e.constraint.includes(constraintSubstr)
  );
}

function isAnyUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

function scheduleContactEnrichment(contactId: string): void {
  queueGenderInference(contactId);
  void syncContactToRespondIo(contactId).catch((err: unknown) => {
    logger.warn({ err, contactId }, "respondio sync error");
  });
}

/**
 * Deterministically create or resolve an interactive contact.
 *
 * Wizard requests are serialized per workspace so phone/email matching,
 * unarchiving, and insertion are one authoritative decision. Phone identity
 * wins when submitted phone and email belong to different historical rows.
 * Existing values are never overwritten; missing values are enriched only
 * when they are not owned by another contact.
 */
export async function createOrResolveContact(
  input: ContactInput,
): Promise<ContactCreateResolution | null> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (!email && !phone) return null;

  const phoneDigits = phone?.replace(/\D/g, "") ?? "";
  const phoneTokens = buildPhoneSearchTokens(phone);
  const phoneTokensLiteral = pgTextArray(phoneTokens);
  const tagsLiteral = pgTextArray(input.tags ?? []);
  const fName = normalizedNameValue(input.firstName);
  const lName = normalizedNameValue(input.lastName);
  const dName = normalizedNameValue(input.displayName);
  const whatsappConsent = input.whatsappConsent === true ? true : null;

  // The advisory lock prevents races between wizard requests. A short retry
  // also covers a concurrent writer using one of the older ingestion paths.
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await db.connect();
    try {
      const result = await withTransaction(client, async () => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [input.workspaceOwnerId],
        );

        const matches = await client.query<ContactResolutionRow>(
          `SELECT c.id, c.email, c.phone, c.archived_at,
                  (
                    $2 <> '' AND (
                      (c.phone_search_tokens IS NOT NULL
                       AND c.phone_search_tokens && $3::text[])
                      OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $2
                    )
                  ) AS phone_match,
                  ($4::text IS NOT NULL AND lower(COALESCE(c.email, '')) = $4) AS email_match
             FROM contacts c
            WHERE c.workspace_owner_id = $1
              AND (
                (
                  $2 <> '' AND (
                    (c.phone_search_tokens IS NOT NULL
                     AND c.phone_search_tokens && $3::text[])
                    OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $2
                  )
                )
                OR ($4::text IS NOT NULL AND lower(COALESCE(c.email, '')) = $4)
              )
            ORDER BY
              CASE WHEN (
                $2 <> '' AND (
                  (c.phone_search_tokens IS NOT NULL
                   AND c.phone_search_tokens && $3::text[])
                  OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') = $2
                )
              ) THEN 0 ELSE 1 END,
              CASE WHEN c.archived_at IS NULL THEN 0 ELSE 1 END,
              c.created_at ASC,
              c.id ASC
            FOR UPDATE`,
          [input.workspaceOwnerId, phoneDigits, phoneTokensLiteral, email],
        );

        const winner = matches.rows[0];
        if (winner) {
          const emailOwnedByOther = !!email && matches.rows.some(
            (row) => row.id !== winner.id && row.email_match,
          );
          const phoneOwnedByOther = !!phone && matches.rows.some(
            (row) => row.id !== winner.id && row.phone_match,
          );
          const mayAddEmail = !emailOwnedByOther;
          const mayAddPhone = !phoneOwnedByOther;

          await client.query(
            `UPDATE contacts
                SET source              = COALESCE(source, $2),
                    external_contact_id = COALESCE(external_contact_id, $3),
                    account_id          = COALESCE(account_id, $4),
                    is_guest            = CASE WHEN $5 THEN is_guest ELSE false END,
                    first_name          = COALESCE(first_name, $6),
                    last_name           = COALESCE(last_name, $7),
                    display_name        = COALESCE(display_name, $8),
                    email               = CASE
                                            WHEN email IS NULL AND $9::boolean THEN $10
                                            ELSE email
                                          END,
                    phone               = CASE
                                            WHEN phone IS NULL AND $11::boolean THEN $12
                                            ELSE phone
                                          END,
                    phone_search_tokens = CASE
                                            WHEN $11::boolean AND $12::text IS NOT NULL
                                            THEN $13::text[]
                                            ELSE phone_search_tokens
                                          END,
                    tags                = (
                      SELECT array(
                        SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || $14::text[])
                      )
                    ),
                    whatsapp_consent    = CASE
                                            WHEN $15 IS TRUE THEN TRUE
                                            ELSE whatsapp_consent
                                          END,
                    consent_updated_at  = CASE
                                            WHEN $15 IS TRUE THEN now()
                                            ELSE consent_updated_at
                                          END,
                    archived_at         = NULL,
                    updated_at          = now()
              WHERE id = $1`,
            [
              winner.id,
              input.source ?? null,
              input.externalContactId ?? null,
              input.accountId ?? null,
              input.isGuest ?? true,
              fName,
              lName,
              dName,
              mayAddEmail,
              email,
              mayAddPhone,
              phone,
              phoneTokensLiteral,
              tagsLiteral,
              whatsappConsent,
            ],
          );
          return { contactId: winner.id, existing: true };
        }

        const inserted = await client.query<ContactRow>(
          `INSERT INTO contacts
             (workspace_owner_id, source, external_contact_id, account_id, is_guest,
              first_name, last_name, display_name, email, phone, phone_search_tokens, tags,
              whatsapp_consent, consent_updated_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],
                   COALESCE($13, FALSE), CASE WHEN $13 IS TRUE THEN now() END, now())
           RETURNING id`,
          [
            input.workspaceOwnerId,
            input.source ?? null,
            input.externalContactId ?? null,
            input.accountId ?? null,
            input.isGuest ?? true,
            fName,
            lName,
            dName,
            email,
            phone,
            phoneTokensLiteral,
            tagsLiteral,
            whatsappConsent,
          ],
        );
        const contactId = inserted.rows[0]?.id;
        if (!contactId) throw new Error("Contact insert returned no id");
        return { contactId, existing: false };
      });

      scheduleContactEnrichment(result.contactId);
      return result;
    } catch (err) {
      if (attempt < 2 && isAnyUniqueViolation(err)) continue;
      throw err;
    } finally {
      client.release();
    }
  }

  throw new Error("Contact resolution retry limit exceeded");
}

/**
 * Upsert a contact using priority-based matching:
 * 1. source + external_contact_id (highest priority)
 * 2. account_id
 * 3. normalized email
 * 4. normalized phone
 *
 * Returns the contact UUID, or null if no identifier is available.
 *
 * After every successful upsert, a non-blocking AI gender inference is queued
 * for the contact (skipped internally when gender was set manually/imported).
 */
export async function upsertContact(input: ContactInput): Promise<string | null> {
  const id = await upsertContactCore(input);
  if (id) scheduleContactEnrichment(id);
  return id;
}

async function upsertContactCore(input: ContactInput): Promise<string | null> {
  const {
    workspaceOwnerId,
    source,
    externalContactId,
    accountId,
    isGuest = true,
    firstName,
    lastName,
    displayName,
    tags = [],
  } = input;

  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const phoneTokens = buildPhoneSearchTokens(phone);
  const phoneTokensLiteral = pgTextArray(phoneTokens);

  const trimName = (v: string | null | undefined) => v?.trim() || null;
  const fName = trimName(firstName);
  const lName = trimName(lastName);
  const dName = trimName(displayName);

  const hasSourceKey = source && externalContactId;
  const hasAccountId = !!accountId;
  const hasEmail = !!email;
  const hasPhone = !!phone;

  if (!hasSourceKey && !hasAccountId && !hasEmail && !hasPhone) {
    return null;
  }

  const tagsLiteral = pgTextArray(tags);
  // null means "no change to existing consent"; TRUE means grant it atomically.
  const whatsappConsent = input.whatsappConsent === true ? true : null;

  if (hasSourceKey) {
    const r = await db.query<ContactRow>(
      `INSERT INTO contacts
         (workspace_owner_id, source, external_contact_id, account_id, is_guest,
          first_name, last_name, display_name, email, phone, phone_search_tokens, tags,
          whatsapp_consent, consent_updated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],
               COALESCE($13, FALSE), CASE WHEN $13 IS TRUE THEN now() END, now())
       ON CONFLICT (workspace_owner_id, source, external_contact_id)
         WHERE source IS NOT NULL AND external_contact_id IS NOT NULL
         DO UPDATE SET
           account_id          = COALESCE(EXCLUDED.account_id,          contacts.account_id),
           is_guest            = CASE WHEN NOT EXCLUDED.is_guest THEN false ELSE contacts.is_guest END,
           first_name          = COALESCE(contacts.first_name,          EXCLUDED.first_name),
           last_name           = COALESCE(contacts.last_name,           EXCLUDED.last_name),
           display_name        = COALESCE(contacts.display_name,        EXCLUDED.display_name),
           email               = COALESCE(contacts.email,               EXCLUDED.email),
           phone               = COALESCE(contacts.phone,               EXCLUDED.phone),
           phone_search_tokens = CASE
             WHEN EXCLUDED.phone IS NOT NULL THEN EXCLUDED.phone_search_tokens
             ELSE contacts.phone_search_tokens
           END,
           tags                = (SELECT array(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags))),
           whatsapp_consent    = CASE WHEN EXCLUDED.whatsapp_consent IS TRUE THEN TRUE ELSE contacts.whatsapp_consent END,
           consent_updated_at  = CASE WHEN EXCLUDED.whatsapp_consent IS TRUE THEN now() ELSE contacts.consent_updated_at END,
           updated_at          = now()
       RETURNING id`,
      [
        workspaceOwnerId, source, externalContactId, accountId ?? null, isGuest,
        fName, lName, dName, email, phone,
        phoneTokensLiteral,
        tagsLiteral,
        whatsappConsent,
      ],
    );
    return r.rows[0]?.id ?? null;
  }

  if (hasAccountId) {
    const existing = await db.query<ContactRow>(
      `SELECT id FROM contacts WHERE workspace_owner_id = $1 AND account_id = $2 LIMIT 1`,
      [workspaceOwnerId, accountId],
    );
    if (existing.rows[0]) {
      await db.query(
        `UPDATE contacts SET
           is_guest            = CASE WHEN $2 THEN is_guest ELSE false END,
           first_name          = COALESCE(first_name, $3),
           last_name           = COALESCE(last_name,  $4),
           display_name        = COALESCE(display_name, $5),
           email               = COALESCE(email, $6),
           phone               = COALESCE(phone, $7),
           phone_search_tokens = CASE WHEN $7 IS NOT NULL THEN $8::text[] ELSE phone_search_tokens END,
           tags                = (SELECT array(SELECT DISTINCT unnest(tags || $9::text[]))),
           whatsapp_consent    = CASE WHEN $10 IS TRUE THEN TRUE ELSE whatsapp_consent END,
           consent_updated_at  = CASE WHEN $10 IS TRUE THEN now() ELSE consent_updated_at END,
           updated_at          = now()
         WHERE id = $1`,
        [existing.rows[0].id, isGuest, fName, lName, dName, email, phone,
          phoneTokensLiteral,
          tagsLiteral,
          whatsappConsent,
        ],
      );
      return existing.rows[0].id;
    }
  }

  if (hasEmail) {
    try {
      const r = await db.query<ContactRow>(
        `INSERT INTO contacts
           (workspace_owner_id, source, external_contact_id, account_id, is_guest,
            first_name, last_name, display_name, email, phone, phone_search_tokens, tags,
            whatsapp_consent, consent_updated_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],
                 COALESCE($13, FALSE), CASE WHEN $13 IS TRUE THEN now() END, now())
         ON CONFLICT (workspace_owner_id, email)
           WHERE email IS NOT NULL
           DO UPDATE SET
             account_id          = COALESCE(EXCLUDED.account_id,          contacts.account_id),
             is_guest            = CASE WHEN NOT EXCLUDED.is_guest THEN false ELSE contacts.is_guest END,
             first_name          = COALESCE(contacts.first_name,          EXCLUDED.first_name),
             last_name           = COALESCE(contacts.last_name,           EXCLUDED.last_name),
             display_name        = COALESCE(contacts.display_name,        EXCLUDED.display_name),
             phone               = COALESCE(contacts.phone,               EXCLUDED.phone),
             phone_search_tokens = CASE
               WHEN contacts.phone IS NULL AND EXCLUDED.phone IS NOT NULL
               THEN EXCLUDED.phone_search_tokens
               ELSE contacts.phone_search_tokens
             END,
             tags                = (SELECT array(SELECT DISTINCT unnest(contacts.tags || EXCLUDED.tags))),
             whatsapp_consent    = CASE WHEN EXCLUDED.whatsapp_consent IS TRUE THEN TRUE ELSE contacts.whatsapp_consent END,
             consent_updated_at  = CASE WHEN EXCLUDED.whatsapp_consent IS TRUE THEN now() ELSE contacts.consent_updated_at END,
             updated_at          = now()
         RETURNING id`,
        [
          workspaceOwnerId, source ?? null, externalContactId ?? null, accountId ?? null, isGuest,
          fName, lName, dName, email, phone,
          phoneTokensLiteral,
          tagsLiteral,
          whatsappConsent,
        ],
      );
      return r.rows[0]?.id ?? null;
    } catch (err) {
      // The new/updated email is unique, but this contact's phone may already
      // belong to a *different* contact — violating contacts_workspace_phone_unique,
      // a constraint the email ON CONFLICT target does not cover. In that case
      // fall through to phone-based matching below (update the existing
      // phone-owning contact, merging in the email). Re-throw anything else.
      if (!hasPhone || !isUniqueViolation(err, "phone")) {
        console.error("[contactUpsert] unexpected constraint on email upsert", err);
        throw err;
      }
    }
  }

  const existingPhone = await db.query<ContactRow>(
    `SELECT id FROM contacts
      WHERE workspace_owner_id = $1 AND phone = $2
      ORDER BY created_at ASC LIMIT 1`,
    [workspaceOwnerId, phone],
  );
  if (existingPhone.rows[0]) {
    try {
      await db.query(
        `UPDATE contacts SET
           account_id          = COALESCE(account_id, $2),
           is_guest            = CASE WHEN $3 THEN is_guest ELSE false END,
           first_name          = COALESCE(first_name, $4),
           last_name           = COALESCE(last_name,  $5),
           display_name        = COALESCE(display_name, $6),
           email               = COALESCE(email, $7),
           phone_search_tokens = COALESCE(phone_search_tokens, $8::text[]),
           tags                = (SELECT array(SELECT DISTINCT unnest(tags || $9::text[]))),
           whatsapp_consent    = CASE WHEN $10 IS TRUE THEN TRUE ELSE whatsapp_consent END,
           consent_updated_at  = CASE WHEN $10 IS TRUE THEN now() ELSE consent_updated_at END,
           updated_at          = now()
         WHERE id = $1`,
        [existingPhone.rows[0].id, accountId ?? null, isGuest, fName, lName, dName, email,
          phoneTokensLiteral,
          tagsLiteral,
          whatsappConsent,
        ],
      );
    } catch (err) {
      // The email we'd merge onto the phone-owner already belongs to a different
      // contact (cross-constraint conflict: email + phone each owned separately).
      // Return the phone-owner as-is — best-effort merge without the email field.
      if (!isUniqueViolation(err, "email")) throw err;
    }
    return existingPhone.rows[0].id;
  }

  try {
    const inserted = await db.query<ContactRow>(
      `INSERT INTO contacts
         (workspace_owner_id, source, external_contact_id, account_id, is_guest,
          first_name, last_name, display_name, email, phone, phone_search_tokens, tags,
          whatsapp_consent, consent_updated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],
               COALESCE($13, FALSE), CASE WHEN $13 IS TRUE THEN now() END, now())
       RETURNING id`,
      [
        workspaceOwnerId, source ?? null, externalContactId ?? null, accountId ?? null, isGuest,
        fName, lName, dName, email, phone,
        phoneTokensLiteral,
        tagsLiteral,
        whatsappConsent,
      ],
    );
    return inserted.rows[0]?.id ?? null;
  } catch (err) {
    // A concurrent request may have inserted the same phone between our SELECT
    // and this INSERT, triggering contacts_workspace_phone_unique (23505). In
    // that case the contact was successfully created by the other request — just
    // look it up by phone and return the winner's id. Re-throw anything else.
    if (!hasPhone || !isUniqueViolation(err, "phone")) throw err;
    const race = await db.query<ContactRow>(
      `SELECT id FROM contacts
        WHERE workspace_owner_id = $1 AND phone = $2
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceOwnerId, phone],
    );
    return race.rows[0]?.id ?? null;
  }
}
