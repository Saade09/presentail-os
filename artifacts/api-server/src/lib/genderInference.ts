import { db } from "./db";
import { logger } from "./logger";
import { findCountryByCode, findCountryByPhone } from "./defaults";
import { callAI } from "./ai/callAI";
import { aiUsageAttribution, type AiUsageAttribution } from "./aiUsageRecorder";

/**
 * AI contact gender inference.
 *
 * Every contact created/updated through the shared contact pool gets a
 * best-effort, non-blocking gender inference from its first name, with the
 * contact's country (phone-derived, metadata fallback) and preferred language
 * as disambiguation context. Results below the confidence threshold are
 * stored as "unknown". Manual edits (gender_source = 'manual') always win and
 * permanently stop re-inference; results are cached per normalized first name
 * + country + language + prompt version so repeat names never re-call the AI.
 */

const MODEL = process.env.AI_GENDER_MODEL ?? "gpt-5-mini";

/** Bump when the prompt or model semantics change — busts the cache. */
export const GENDER_PROMPT_VERSION = `v2:${MODEL}`;

const DEFAULT_THRESHOLD = 0.9;

export type InferredGender = "male" | "female" | "unknown";

export function genderConfidenceThreshold(): number {
  const raw = Number(process.env.GENDER_CONFIDENCE_THRESHOLD);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return DEFAULT_THRESHOLD;
}

/**
 * Extract and normalize the first name used for inference + cache keying:
 * prefer first_name, else the first whitespace token of display_name.
 * Lowercased + whitespace-collapsed (works for non-Latin scripts too).
 */
export function normalizeFirstName(
  firstName: string | null | undefined,
  displayName: string | null | undefined,
): string | null {
  const primary = (firstName ?? "").trim();
  const fromDisplay = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  const candidate = primary || fromDisplay;
  const normalized = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return null;
  // Skip clearly non-name inputs (pure digits/punctuation).
  if (!/\p{L}/u.test(normalized)) return null;
  return normalized;
}

type CacheRow = { gender: string; confidence: string | null };

type InferenceResult = {
  gender: InferredGender;
  confidence: number | null;
};

function coerceResult(raw: unknown): InferenceResult {
  if (!raw || typeof raw !== "object") return { gender: "unknown", confidence: null };
  const o = raw as { gender?: unknown; confidence?: unknown };
  const g = typeof o.gender === "string" ? o.gender.toLowerCase() : "";
  const gender: InferredGender = g === "male" || g === "female" ? g : "unknown";
  const c = typeof o.confidence === "number" ? o.confidence : Number(o.confidence);
  const confidence = Number.isFinite(c) && c >= 0 && c <= 1 ? c : null;
  return { gender, confidence };
}

const MODEL_TIMEOUT_MS = 10_000;
const MODEL_MAX_ATTEMPTS = 2;

async function callModel(
  firstName: string,
  countryContext: string,
  language: string,
  orderContext?: string,
  attribution?: AiUsageAttribution,
): Promise<InferenceResult> {
  const contextParts: string[] = [];
  if (countryContext) contextParts.push(`country: ${countryContext}`);
  if (language) contextParts.push(`preferred language: ${language}`);
  if (orderContext) contextParts.push(`gift card context: ${orderContext}`);
  const context = contextParts.length > 0 ? ` (${contextParts.join(", ")})` : "";

  let completion: Awaited<ReturnType<typeof requestCompletion>>;
  let lastErr: unknown;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      completion = await requestCompletion(firstName, context, attribution);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt >= MODEL_MAX_ATTEMPTS) throw lastErr;
      logger.warn({ err, attempt }, "Gender inference: model call failed, retrying");
    }
  }

  const content = completion.choices?.[0]?.message?.content ?? "";
  try {
    return coerceResult(JSON.parse(content));
  } catch {
    logger.warn({ content }, "Gender inference: unparseable model response");
    return { gender: "unknown", confidence: null };
  }
}

async function requestCompletion(firstName: string, context: string, attribution?: AiUsageAttribution) {
  return callAI({
    actionKey: "contacts.gender_inference",
    surface: "contacts",
    provider: "openai",
    model: MODEL,
    ...aiUsageAttribution(attribution),
    messages: [
      {
        role: "system",
        content:
          "You classify the most likely gender associated with a person's first name for gift personalization. " +
          "Names can be in any script (Latin, Arabic, etc.) and are mostly Middle Eastern / Arabic names. " +
          "Be decisive: well-known unambiguous names (e.g. Fadi, Ahmad, Omar → male; Elissa, Fatima, Layla → female) " +
          "deserve high confidence (0.95+). Use the country and language context when provided — " +
          "the same name can skew differently by country (e.g. Andrea in Italy vs the US). " +
          "If gift card context is provided (a card message written to or by this person), use gendered words in it " +
          "(mom, habibi/habibti, wife, brother, etc.) as strong evidence. " +
          'Respond with ONLY a JSON object: {"gender": "male"|"female"|"unknown", "confidence": number between 0 and 1}. ' +
          'Return "unknown" with low confidence only when the name is genuinely ambiguous, unisex, or not a personal name.',
      },
      { role: "user", content: `First name: ${firstName}${context}` },
    ],
    maxTokens: 8192,
    response_format: { type: "json_object" },
    requestOptions: { timeout: MODEL_TIMEOUT_MS },
  });
}

/**
 * Cache-first inference for a normalized first name + context. Never throws;
 * failures return unknown/null and are NOT cached (so a later retry can work).
 */
export async function inferGenderFromName(opts: {
  normalizedFirstName: string;
  countryContext?: string | null;
  language?: string | null;
  /** Extra order-derived context (card message excerpt); results with this set are never cached. */
  orderContext?: string | null;
  attribution?: AiUsageAttribution;
}): Promise<InferenceResult & { fromCache: boolean }> {
  const countryContext = (opts.countryContext ?? "").trim();
  const language = (opts.language ?? "").trim().toLowerCase();
  const name = opts.normalizedFirstName;

  const cached = await db.query<CacheRow>(
    `SELECT gender, confidence FROM gender_inference_cache
      WHERE normalized_first_name = $1 AND country_context = $2
        AND language = $3 AND prompt_version = $4
      LIMIT 1`,
    [name, countryContext, language, GENDER_PROMPT_VERSION],
  );
  const hit = cached.rows[0];
  if (hit) {
    return {
      ...coerceResult({ gender: hit.gender, confidence: hit.confidence }),
      fromCache: true,
    };
  }

  let result: InferenceResult;
  try {
    result = await callModel(name, countryContext, language, opts.orderContext ?? undefined, opts.attribution);
  } catch (err) {
    logger.warn({ err, name }, "Gender inference: model call failed");
    return { gender: "unknown", confidence: null, fromCache: false };
  }

  // Context-specific results are not cached — the cache is keyed by name only.
  if (opts.orderContext) return { ...result, fromCache: false };

  await db.query(
    `INSERT INTO gender_inference_cache
       (normalized_first_name, country_context, language, prompt_version, gender, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (normalized_first_name, country_context, language, prompt_version)
       DO NOTHING`,
    [name, countryContext, language, GENDER_PROMPT_VERSION, result.gender, result.confidence],
  );
  return { ...result, fromCache: false };
}

type ContactGenderRow = {
  workspace_owner_id: string;
  first_name: string | null;
  display_name: string | null;
  phone: string | null;
  gender_source: string | null;
  preferred_language: string | null;
  metadata_country_code: string | null;
};

/**
 * Resolve the contact's country context for inference: phone dial code first
 * (matches the dashboard's phone-derived country), then metadata country_code.
 */
export function resolveCountryContext(
  phone: string | null,
  metadataCountryCode: string | null,
): string {
  const byPhone = findCountryByPhone(phone);
  if (byPhone) return byPhone.name;
  const byMeta = findCountryByCode((metadataCountryCode ?? "").trim().toLowerCase());
  return byMeta?.name ?? "";
}

/**
 * Pull card-message context from the contact's most recent order: if the
 * contact was the recipient, the message was written TO them; if the customer,
 * it may be signed BY them. Returns a short model-ready string or null.
 */
async function loadOrderContext(contactId: string): Promise<string | null> {
  const r = await db.query<{
    role: string;
    card_to: string | null;
    card_from: string | null;
    card_message: string | null;
  }>(
    `SELECT oc.role, o.card_to, o.card_from, o.card_message
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
       JOIN orders o ON o.id = oc.order_id
        AND o.workspace_owner_id = c.workspace_owner_id
      WHERE oc.contact_id = $1
        AND (o.card_message IS NOT NULL AND btrim(o.card_message) <> '')
      ORDER BY o.created_at DESC
      LIMIT 1`,
    [contactId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const message = (row.card_message ?? "").trim().slice(0, 300);
  if (!message) return null;
  const direction =
    row.role === "recipient"
      ? "this person RECEIVED a gift with this card message"
      : "this person SENT a gift with this card message";
  const to = (row.card_to ?? "").trim();
  const from = (row.card_from ?? "").trim();
  const parts = [direction, to ? `to: ${to}` : "", from ? `from: ${from}` : "", `message: "${message}"`];
  return parts.filter(Boolean).join("; ");
}

/**
 * Load a contact, run cache-first inference, and persist the result. Skips
 * contacts whose gender was set manually or by import. Never throws.
 */
export async function applyGenderInference(contactId: string): Promise<boolean> {
  try {
    const r = await db.query<ContactGenderRow>(
      `SELECT workspace_owner_id, first_name, display_name, phone, gender_source,
              metadata->>'preferred_language' AS preferred_language,
              metadata->>'country_code' AS metadata_country_code
         FROM contacts WHERE id = $1`,
      [contactId],
    );
    const row = r.rows[0];
    if (!row) return true;
    if (row.gender_source === "manual" || row.gender_source === "imported") return true;

    const name = normalizeFirstName(row.first_name, row.display_name);
    if (!name) {
      // Stamp non-inferable contacts so the backfill never re-selects them.
      await db.query(
        `UPDATE contacts SET
           gender = 'unknown', gender_source = 'ai', gender_confidence = NULL,
           gender_inferred_at = now(), gender_model_version = $2
         WHERE id = $1 AND (gender_source IS NULL OR gender_source = 'ai')`,
        [contactId, GENDER_PROMPT_VERSION],
      );
      return true;
    }

    const countryContext = resolveCountryContext(row.phone, row.metadata_country_code);
    let result = await inferGenderFromName({
      normalizedFirstName: name,
      countryContext,
      language: row.preferred_language,
      attribution: { workspaceOwnerId: row.workspace_owner_id },
    });

    const threshold = genderConfidenceThreshold();
    let confident =
      result.gender !== "unknown" && result.confidence != null && result.confidence >= threshold;

    // Name alone was unclear — retry once with card-message context from the
    // contact's latest order (message written to a recipient / from a customer).
    if (!confident) {
      const orderContext = await loadOrderContext(contactId);
      if (orderContext) {
        const withContext = await inferGenderFromName({
          normalizedFirstName: name,
          countryContext,
          language: row.preferred_language,
          orderContext,
          attribution: { workspaceOwnerId: row.workspace_owner_id },
        });
        if (
          withContext.gender !== "unknown" &&
          withContext.confidence != null &&
          withContext.confidence >= threshold
        ) {
          result = withContext;
          confident = true;
        }
      }
    }

    const finalGender: InferredGender = confident ? result.gender : "unknown";

    // Guard against a manual edit that landed while we were inferring.
    await db.query(
      `UPDATE contacts SET
         gender = $2,
         gender_source = 'ai',
         gender_confidence = $3,
         gender_context_country = $4,
         gender_inferred_at = now(),
         gender_model_version = $5
       WHERE id = $1
         AND (gender_source IS NULL OR gender_source = 'ai')`,
      [contactId, finalGender, result.confidence, countryContext || null, GENDER_PROMPT_VERSION],
    );
    return true;
  } catch (err) {
    logger.warn({ err, contactId }, "Gender inference: failed for contact");
    return false;
  }
}

/**
 * Fire-and-forget entry point — never blocks or fails the calling request.
 */
export function queueGenderInference(contactId: string | null | undefined): void {
  if (!contactId) return;
  setImmediate(() => {
    void applyGenderInference(contactId);
  });
}

const BACKFILL_BATCH_SIZE = 25;
const BACKFILL_INTERVAL_MS = 60_000;

/**
 * One backfill tick: pick contacts that never went through inference
 * (no gender_inferred_at, no manual/imported source, has a name) and run
 * inference sequentially. Returns the number processed.
 */
const backfillFailedIds = new Set<string>();

export async function runGenderBackfillTick(): Promise<number> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM contacts
      WHERE gender_inferred_at IS NULL
        AND (gender_source IS NULL OR gender_source = 'ai')
        AND (COALESCE(btrim(first_name), '') <> '' OR COALESCE(btrim(display_name), '') <> '')
        AND NOT (id = ANY($2::uuid[]))
      ORDER BY created_at DESC
      LIMIT $1`,
    [BACKFILL_BATCH_SIZE, Array.from(backfillFailedIds)],
  );
  for (const row of r.rows) {
    const ok = await applyGenderInference(row.id);
    // Don't retry failures every minute — they'll be re-attempted on next boot.
    if (!ok) backfillFailedIds.add(row.id);
  }
  return r.rows.length;
}

/**
 * Background backfill for contacts created before gender inference existed.
 * Processes small batches once a minute and stops itself when nothing is left
 * (newly created contacts are handled inline by queueGenderInference).
 */
export function startGenderBackfillJob(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const processed = await runGenderBackfillTick();
      if (processed > 0) {
        logger.info({ processed }, "Gender inference backfill: processed batch");
      }
      if (processed < BACKFILL_BATCH_SIZE) {
        clearInterval(timer);
        logger.info("Gender inference backfill: complete");
      }
    } catch (err) {
      logger.warn({ err }, "Gender inference backfill: tick failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), BACKFILL_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
}
