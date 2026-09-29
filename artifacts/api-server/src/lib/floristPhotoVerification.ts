import { z } from "zod";
import sharp from "sharp";
import { openai } from "@workspace/integrations-openai-ai-server/image";
import { logger } from "./logger";
import { callAI } from "./ai/callAI";
import type { AiUsageAttribution } from "./aiUsageRecorder";

/**
 * AI vision verification of the florist "order items" photo (Photo 1).
 *
 * The model compares the products visible in the photo against the order's
 * line items (names, quantities, descriptions, and recipe/base-item
 * composition), using labeled product reference images when available.
 * The printed card / envelope is explicitly ignored.
 *
 * The gate is fair but fails closed: anything consistent with an ordered
 * product (visible in its reference image or mentioned in its description or
 * recipe) counts as part of that product; genuine failures — a clearly
 * missing item, a wrong quantity, an object unrelated to every ordered
 * product, or an unjudgeable photo — are still rejected, and unreadable
 * model responses always reject.
 */

export type ExpectedItemComponent = {
  name: string;
  quantity: string;
};

export type ExpectedItem = {
  name: string;
  quantity: number;
  /** Catalog description of the linked product, when available. */
  description?: string | null;
  /** Recipe / base-item composition of the linked product, when available. */
  recipe?: ExpectedItemComponent[];
};

export type DetectedItem = {
  name: string;
  quantity: number;
};

export type ItemAssessmentStatus = "present" | "absent" | "uncertain";

export type ItemAssessment = {
  /** Zero-based index into the expected-items list. */
  itemIndex: number;
  name: string;
  status: ItemAssessmentStatus;
  /** Short description of the visible cue (or why no cue was found). */
  cue: string;
};

export type FloristVerificationOutcome = {
  approved: boolean;
  /** Categorized reason when rejected (missing_item, wrong_quantity, unidentifiable_item, unclear_photo, other). */
  reasonCode: string | null;
  /** Human-readable rejection reason (null when approved). */
  reason: string | null;
  detectedItems: DetectedItem[];
  /** Per-line evidence returned by the model, used before any missing-item rejection. */
  itemAssessments: ItemAssessment[];
  /** Raw parsed model JSON, persisted for auditing. */
  raw: Record<string, unknown> | null;
};

const REASON_CODES = [
  "missing_item",
  "wrong_quantity",
  "unidentifiable_item",
  "unclear_photo",
  "other",
] as const;

const resultSchema = z.object({
  approved: z.boolean().catch(false),
  reason_code: z
    .string()
    .nullable()
    .catch(null)
    .transform((v) => {
      if (v == null) return null;
      const norm = v.trim().toLowerCase();
      return (REASON_CODES as readonly string[]).includes(norm) ? norm : "other";
    }),
  reason: z.string().nullable().catch(null),
  detected_items: z
    .array(
      z.object({
        name: z.string().catch(""),
        quantity: z.coerce.number().catch(0),
      }),
    )
    .catch([]),
  item_assessments: z
    .array(
      z.object({
        item_number: z.coerce.number().int(),
        name: z.string(),
        status: z.enum(["present", "absent", "uncertain"]),
        cue: z.string().trim().min(1),
      }),
    )
    .catch([]),
});

/** Association of an attached reference image with an expected-item index. */
export type ReferenceImageLabel = {
  /** Zero-based index into the expected-items list, or null when unknown. */
  itemIndex: number | null;
};

export function buildFloristVerificationPrompt(
  expected: ExpectedItem[],
  references: ReferenceImageLabel[] = [],
): string {
  const lines = expected.map((e, i) => {
    const parts = [`${i + 1}. ${e.quantity} × ${e.name}`];
    const description = e.description?.trim();
    if (description) parts.push(`   Description: ${description}`);
    if (e.recipe && e.recipe.length > 0) {
      parts.push(
        `   Contains: ${e.recipe.map((c) => `${c.quantity} × ${c.name}`).join(", ")}`,
      );
    }
    return parts.join("\n");
  });

  const referenceLines = references.map((ref, i) => {
    const imageNumber = i + 2;
    if (ref.itemIndex != null && expected[ref.itemIndex]) {
      return `- Image ${imageNumber} is the catalog reference photo of item ${ref.itemIndex + 1} (${expected[ref.itemIndex].name}).`;
    }
    return `- Image ${imageNumber} is a catalog reference photo of one of the expected items.`;
  });
  const labeledIndexes = new Set(
    references.map((r) => r.itemIndex).filter((v): v is number => v != null),
  );
  const withoutReference = expected
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => !labeledIndexes.has(i));

  const referenceSection =
    references.length > 0
      ? `Reference images:\n${referenceLines.join("\n")}`
      : "No catalog reference images are available for this order.";
  const noReferenceNote =
    withoutReference.length > 0
      ? `The following items have NO reference image — do not guess their exact appearance; judge them by their name, description, and contents, and accept a plausible match: ${withoutReference
          .map(({ e, i }) => `item ${i + 1} (${e.name})`)
          .join(", ")}.`
      : "";

  return `You are a fair but thorough quality-control inspector for a flower & gift shop.

The FIRST image is a photo taken by the florist of a prepared order, ready to ship.

${referenceSection}
${noReferenceNote ? `${noReferenceNote}\n` : ""}
The order must contain these items:
${lines.join("\n")}

Rules:
- Assess every expected line item separately. For each item, record one status in "item_assessments": "present" when there is plausible visual evidence, "absent" only when no plausible candidate can be found after re-examining the photo, or "uncertain" when the photo leaves room for a reasonable match. Include a short visible cue for each assessment.
- Compare the PRODUCTS visible in the first photo against the expected list, using each item's reference image, description, and "Contains" list to understand what the item looks like and what it includes.
- Bundles and composite products include EVERYTHING shown in their reference image or listed in their description or "Contains" list. Any object visible in an item's reference image, or mentioned in its description or contents, is PART of that item — NEVER count it as an extra item (e.g. a wine bottle shown in a bundle's catalog photo belongs to the bundle).
- IGNORE any printed card, greeting card, or envelope in the photo — it is expected to be present and is NOT a product.
- Give the florist the benefit of the doubt: if an object plausibly matches an expected item or one of its components (exact flower varieties, colors, wrapping, or arrangement may differ slightly from the catalog photo), treat it as that item.
- For bundle and recipe COMPONENTS, judge by general object type only — do NOT require reading a label, identifying a brand, or confirming an exact variety. A bottle of any wine counts as the listed wine component; a box of chocolates counts as the listed chocolates; a candle counts as the listed candle. If the general object type is visible, the component is present.
- Cakes and similar gifts may be inside an open bakery, pastry, or gift box. A visible cake-like product, even if packaged, viewed from an angle, partly hidden, topped differently, or partly obstructed, counts as present when its general product type is plausible. Do not require exact flavor, topping, decoration, or packaging identification (for example, an open box containing a chocolate cake is enough evidence for a chocolate cake line).
- Items may be partially hidden inside gift bags, tissue paper, wrapping, or behind other items. A partially visible or wrapped object that is consistent with an expected item or component counts as present — do not flag it as missing.
- Before concluding that any item or component is missing, re-examine every visible object in the photo and check whether it could plausibly account for that item or component. Only report "missing_item" when no visible object in the photo is a plausible match — not merely when the exact brand, label, or variety cannot be confirmed.
- Only flag an EXTRA item (reason_code "other") when an object is clearly unrelated to EVERY expected item — not visible in any reference image, not mentioned in any description or contents, and not plausibly a component or packaging of any expected item.
- Reject with "missing_item" when an expected item is clearly ABSENT from the photo, and with "wrong_quantity" when it is clearly present in the wrong quantity.
- Reject with "unclear_photo" ONLY when the photo is genuinely too dark, blurry, or cropped to judge the order.
- When rejecting, be specific and actionable: name the exact item that is missing, has the wrong quantity, or is extra, so the florist knows what to fix.
- An "uncertain" assessment is not a missing item: treat it as present for approval. Reject for "missing_item" only when the item is "absent" and no plausible candidate remains after the full re-examination.

Return ONLY a valid JSON object (no markdown, no extra text) with exactly these fields:
{
  "approved": true or false,
  "reason_code": null when approved, otherwise one of "missing_item", "wrong_quantity", "unidentifiable_item", "unclear_photo", "other",
  "reason": null when approved, otherwise one short sentence explaining what is wrong (e.g. which item is missing or has the wrong quantity),
  "detected_items": [{ "name": "product you can see", "quantity": 1 }],
  "item_assessments": [
    { "item_number": 1, "name": "expected line item", "status": "present", "cue": "short visible cue" }
  ]
}`;
}

/**
 * Parse the raw model output. Any parse failure is a rejection with
 * reason_code "unclear_photo"-adjacent "other" — the gate fails closed.
 */
export function parseFloristVerificationResponse(
  rawText: string,
  expectedItems?: ExpectedItem[],
): FloristVerificationOutcome {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      approved: false,
      reasonCode: "other",
      reason: "The verification service returned an unreadable result. Please retry.",
      detectedItems: [],
      itemAssessments: [],
      raw: null,
    };
  }
  let rawJson: Record<string, unknown>;
  try {
    rawJson = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return {
      approved: false,
      reasonCode: "other",
      reason: "The verification service returned an unreadable result. Please retry.",
      detectedItems: [],
      itemAssessments: [],
      raw: null,
    };
  }
  const parsed = resultSchema.safeParse(rawJson);
  if (!parsed.success) {
    return {
      approved: false,
      reasonCode: "other",
      reason: "The verification service returned an unexpected result. Please retry.",
      detectedItems: [],
      itemAssessments: [],
      raw: rawJson,
    };
  }
  const d = parsed.data;
  let itemAssessments = d.item_assessments
    .filter(
      (item) =>
        Number.isInteger(item.item_number) &&
        item.item_number >= 1 &&
        item.name.trim().length > 0,
    )
    .map((item) => ({
      itemIndex: item.item_number - 1,
      name: item.name.trim(),
      status: item.status,
      cue: item.cue.trim(),
    }));

  if (expectedItems) {
    const byIndex = new Map<number, ItemAssessment>();
    let assessmentsValid = d.item_assessments.length === expectedItems.length;
    for (const assessment of d.item_assessments) {
      const itemIndex = assessment.item_number - 1;
      if (
        !Number.isInteger(assessment.item_number) ||
        itemIndex < 0 ||
        itemIndex >= expectedItems.length ||
        byIndex.has(itemIndex)
      ) {
        assessmentsValid = false;
        continue;
      }
      byIndex.set(itemIndex, {
        itemIndex,
        name: expectedItems[itemIndex].name,
        status: assessment.status,
        cue: assessment.cue.trim(),
      });
    }
    if (byIndex.size !== expectedItems.length) assessmentsValid = false;
    itemAssessments = [...byIndex.values()].sort(
      (left, right) => left.itemIndex - right.itemIndex,
    );

    if (!assessmentsValid) {
      return {
        approved: false,
        reasonCode: "other",
        reason: "The verification did not provide one valid assessment for every order item. Please retry.",
        detectedItems: d.detected_items.filter((item) => item.name.trim().length > 0),
        itemAssessments,
        raw: rawJson,
      };
    }

    const absent = itemAssessments.filter((assessment) => assessment.status === "absent");
    if (absent.length > 0) {
      const missingNames = absent.map((assessment) => assessment.name);
      d.approved = false;
      d.reason_code = "missing_item";
      d.reason =
        missingNames.length === 1
          ? `${missingNames[0]} appears to be missing from the photo.`
          : `${missingNames.join(", ")} appear to be missing from the photo.`;
    } else if (
      d.reason_code === "missing_item" ||
      (d.reason_code === "unidentifiable_item" &&
        itemAssessments.some((assessment) => assessment.status === "uncertain"))
    ) {
      d.approved = true;
      d.reason_code = null;
      d.reason = null;
    }
  }
  if (!d.approved && !d.reason) {
    d.reason = "The photo could not be verified against the order items.";
  }
  return {
    approved: d.approved,
    reasonCode: d.approved ? null : (d.reason_code ?? "other"),
    reason: d.approved ? null : d.reason,
    detectedItems: d.detected_items.filter((i) => i.name.trim().length > 0),
    itemAssessments,
    raw: rawJson,
  };
}

export function buildFloristFocusedItemPrompt(expected: ExpectedItem): string {
  const context = [`Expected item: ${expected.quantity} × ${expected.name}`];
  if (expected.description?.trim()) {
    context.push(`Description: ${expected.description.trim()}`);
  }
  if (expected.recipe && expected.recipe.length > 0) {
    context.push(
      `Contains: ${expected.recipe.map((c) => `${c.quantity} × ${c.name}`).join(", ")}`,
    );
  }

  return `You are doing a focused second look for a florist quality-control check.

The first image is the original high-detail prepared-order photo. Any images after it are trusted catalog reference photos for this item. Re-examine the entire first image for this one expected item:
${context.join("\n")}

Mark the item "present" if any plausible candidate is visible, including a packaged or partially obscured product. Cakes and similar gifts may be inside an open bakery, pastry, or gift box; general product type is enough. Do not require exact flavor, toppings, decoration, angle, label, or packaging. Mark "uncertain" if the photo is ambiguous but a reasonable match is possible. Mark "absent" only when you can find no plausible candidate anywhere after this focused second look. Include a short visible cue.

Return ONLY a valid JSON object (no markdown, no extra text):
{ "status": "present", "cue": "short visible cue" }`;
}

const focusedItemSchema = z.object({
  status: z.enum(["present", "absent", "uncertain"]).catch("uncertain"),
  cue: z.string().trim().min(1),
});

export function parseFloristFocusedItemResponse(
  rawText: string,
  itemIndex: number,
  name: string,
): ItemAssessment {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { itemIndex, name, status: "uncertain", cue: "The focused check returned no readable evidence." };
  }
  try {
    const parsed = focusedItemSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) {
      return { itemIndex, name, status: "uncertain", cue: "The focused check returned unexpected evidence." };
    }
    return {
      itemIndex,
      name,
      status: parsed.data.status,
      cue: parsed.data.cue.trim(),
    };
  } catch {
    return { itemIndex, name, status: "uncertain", cue: "The focused check returned unreadable evidence." };
  }
}

export type ReferenceImage = {
  buffer: Buffer;
  mime: string;
  /** Zero-based index of the expected item this reference image belongs to. */
  itemIndex?: number | null;
};

/**
 * Re-check one apparently absent line item against the original high-detail
 * photo. A malformed model response is uncertainty (benefit of the doubt);
 * transport failures still throw so the route can release its claim for retry.
 */
export async function runFloristFocusedItemVerification(args: {
  photo: { buffer: Buffer; mime: string };
  expectedItem: ExpectedItem;
  itemIndex: number;
  referenceImages: ReferenceImage[];
  attribution?: AiUsageAttribution;
}): Promise<ItemAssessment> {
  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const response = await callAI({
    actionKey: "florist.focused_item_verification",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 2048,
    orderId: args.attribution?.orderId == null ? null : String(args.attribution.orderId),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildFloristFocusedItemPrompt(args.expectedItem) },
          {
            type: "image_url",
            image_url: {
              url: `data:${args.photo.mime};base64,${args.photo.buffer.toString("base64")}`,
              detail: "high",
            },
          },
          ...args.referenceImages.map((ref) => ({
            type: "image_url" as const,
            image_url: {
              url: `data:${ref.mime};base64,${ref.buffer.toString("base64")}`,
              detail: "low" as const,
            },
          })),
        ],
      },
    ],
  });
  const rawText = response.choices[0]?.message?.content ?? "";
  const assessment = parseFloristFocusedItemResponse(
    rawText,
    args.itemIndex,
    args.expectedItem.name,
  );
  logger.info(
    {
      itemIndex: assessment.itemIndex,
      itemName: assessment.name,
      status: assessment.status,
    },
    "floristPhotoVerification: focused item check completed",
  );
  return assessment;
}

/**
 * Lenient AI vision check for the card-on-box photo (Photo 3).
 *
 * The check is intentionally permissive: any image where a card, envelope,
 * or piece of paper is visible anywhere near a box or gift arrangement
 * passes. Only images that clearly contain NO card whatsoever fail.
 */
const cardOnBoxSchema = z.object({
  approved: z.boolean().catch(false),
  reason: z.string().nullable().catch(null),
});

export type CardOnBoxOutcome = {
  approved: boolean;
  reason: string | null;
};

const CARD_ON_BOX_PROMPT = `You are checking whether a gift card (or envelope) is physically attached to a floral arrangement or gift box.

Look at the photo and answer ONLY whether any card, envelope, or piece of paper is visible somewhere near or on the arrangement/box.

Rules:
- APPROVE if you can see any card, envelope, or piece of paper anywhere in the image, even if it is partially hidden, not fully readable, or not perfectly positioned.
- REJECT only if the image clearly shows NO card at all (e.g. a bare box with nothing attached).
- Give the florist the benefit of the doubt; the exact position, orientation, or readability of the card does not matter.

Return ONLY a valid JSON object (no markdown, no extra text) with exactly these fields:
{
  "approved": true or false,
  "reason": null when approved, otherwise one short sentence explaining why no card is visible
}`;

export async function runCardOnBoxVerification(args: {
  photo: { buffer: Buffer; mime: string };
  attribution?: AiUsageAttribution;
}): Promise<CardOnBoxOutcome> {
  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const response = await callAI({
    actionKey: "florist.card_on_box_verification",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 512,
    orderId: args.attribution?.orderId == null ? null : String(args.attribution.orderId),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CARD_ON_BOX_PROMPT },
          {
            type: "image_url",
            image_url: {
              url: `data:${args.photo.mime};base64,${args.photo.buffer.toString("base64")}`,
              detail: "low",
            },
          },
        ],
      },
    ],
  });
  const rawText = response.choices[0]?.message?.content ?? "";
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    logger.warn("runCardOnBoxVerification: unparseable response; failing closed");
    return { approved: false, reason: "The card-on-box verification returned an unreadable result. Please retry." };
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(jsonMatch[0]);
  } catch {
    return { approved: false, reason: "The card-on-box verification returned an unreadable result. Please retry." };
  }
  const parsed = cardOnBoxSchema.safeParse(rawJson);
  if (!parsed.success) {
    return { approved: false, reason: "The card-on-box verification returned an unexpected result. Please retry." };
  }
  const { approved, reason } = parsed.data;
  logger.info({ approved, reason }, "runCardOnBoxVerification: verification completed");
  return { approved, reason: approved ? null : (reason ?? "No card was visible in the photo.") };
}

/**
 * Run the vision verification: Photo 1 + up to a handful of labeled product
 * reference images. Throws only on transport-level failures (the caller maps
 * those to a retryable error); model-level uncertainty comes back as a
 * rejection.
 */
export async function runFloristPhotoVerification(args: {
  photo: { buffer: Buffer; mime: string };
  expectedItems: ExpectedItem[];
  referenceImages: ReferenceImage[];
  attribution?: AiUsageAttribution;
}): Promise<FloristVerificationOutcome> {
  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const prompt = buildFloristVerificationPrompt(
    args.expectedItems,
    args.referenceImages.map((ref) => ({ itemIndex: ref.itemIndex ?? null })),
  );

  const imageContents = [
    {
      type: "image_url" as const,
      image_url: {
        url: `data:${args.photo.mime};base64,${args.photo.buffer.toString("base64")}`,
        detail: "high" as const,
      },
    },
    ...args.referenceImages.map((ref) => ({
      type: "image_url" as const,
      image_url: {
        url: `data:${ref.mime};base64,${ref.buffer.toString("base64")}`,
        detail: "low" as const,
      },
    })),
  ];

  const response = await callAI({
    actionKey: "florist.order_photo_verification",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 8192,
    orderId: args.attribution?.orderId == null ? null : String(args.attribution.orderId),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, ...imageContents],
      },
    ],
  });
  const rawText = response.choices[0]?.message?.content ?? "";
  const outcome = parseFloristVerificationResponse(rawText, args.expectedItems);
  logger.info(
    {
      approved: outcome.approved,
      reasonCode: outcome.reasonCode,
      detected: outcome.detectedItems.length,
      expected: args.expectedItems.length,
    },
    "floristPhotoVerification: verification completed",
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// Staged card reading
// ---------------------------------------------------------------------------

type CardPhoto = { buffer: Buffer; mime: string };
type CardPhotoSource = "original" | "enhanced";

export type CardVerificationEvidence = {
  pass: "transcription" | "comparison" | "confirmation";
  source: CardPhotoSource | "text";
  valid: boolean;
  legible?: boolean;
  approved?: boolean;
  detectedText: string | null;
  confidence: number;
  reason: string | null;
  raw: Record<string, unknown> | null;
};

export type CardTextVerificationResult = {
  legible: boolean;
  approved: boolean;
  detectedText: string | null;
  confidence: number;
  reason: string | null;
  decisionPath: string[];
  evidence: CardVerificationEvidence[];
};

const cardTranscriptionSchema = z.object({
  legible: z.boolean(),
  detected_text: z.string().trim().min(1).nullable(),
  confidence: z.coerce.number().min(0).max(1),
  reason: z.string().trim().min(1).nullable(),
});

const cardComparisonSchema = z.object({
  approved: z.boolean(),
  confidence: z.coerce.number().min(0).max(1),
  reason: z.string().trim().min(1).nullable(),
});

const cardConfirmationSchema = z.object({
  legible: z.boolean(),
  approved: z.boolean(),
  detected_text: z.string().trim().min(1).nullable(),
  confidence: z.coerce.number().min(0).max(1),
  reason: z.string().trim().min(1).nullable(),
});

const CARD_READ_FAILURE =
  "The card photo could not be read clearly. Please retake the card photo and try again.";
const CARD_MISMATCH_FAILURE =
  "The card text is materially different from the order message.";
const CARD_CONFIDENCE_THRESHOLD = 0.75;

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const value: unknown = JSON.parse(jsonMatch[0]);
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Normalize only presentation differences that cannot change the substantive
 * message: Unicode compatibility, case, punctuation, spacing, and line breaks.
 */
export function normalizeCardMessage(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build an orientation-corrected readability view in memory. The original
 * upload remains the durable evidence; this derived JPEG is used only for AI
 * reading when the original pass is uncertain or appears mismatched.
 */
export async function prepareEnhancedCardPhoto(
  cardPhoto: CardPhoto,
): Promise<CardPhoto | null> {
  try {
    const buffer = await sharp(cardPhoto.buffer, { failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.2, m1: 1, m2: 2 })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { buffer, mime: "image/jpeg" };
  } catch (err) {
    logger.warn({ err }, "runCardTextVerification: readability enhancement failed");
    return null;
  }
}

async function transcribeCardPhoto(
  photo: CardPhoto,
  source: CardPhotoSource,
  attribution?: AiUsageAttribution,
): Promise<CardVerificationEvidence> {
  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const prompt = `Transcribe the handwritten or printed greeting-card text in this photo.

This pass is transcription only. Do not compare it with any expected message and do not infer missing words.
- Read all visible card text, including names and sign-offs, preserving the words and line order.
- Ignore printed branding, decorative graphics, and text on surrounding packaging.
- Set legible=false only when the substantive message cannot be read reliably.
- Confidence is from 0 to 1 and reflects confidence in the exact transcription. Minor uncertainty in one handwritten character can still be legible with lower confidence.

Return ONLY valid JSON:
{
  "legible": true or false,
  "detected_text": "all card text" or null,
  "confidence": number from 0 to 1,
  "reason": null when legible, otherwise one short actionable explanation
}`;
  const response = await callAI({
    actionKey: "florist.card_transcription",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 768,
    orderId: attribution?.orderId == null ? null : String(attribution.orderId),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${photo.mime};base64,${photo.buffer.toString("base64")}`,
            detail: "high" as const,
          },
        },
      ],
    }],
  });
  const raw = parseJsonObject(response.choices[0]?.message?.content ?? "");
  const parsed = cardTranscriptionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pass: "transcription",
      source,
      valid: false,
      legible: false,
      detectedText: null,
      confidence: 0,
      reason: "The transcription pass returned an unreadable result.",
      raw,
    };
  }
  return {
    pass: "transcription",
    source,
    valid: true,
    legible: parsed.data.legible && parsed.data.detected_text != null,
    detectedText: parsed.data.detected_text,
    confidence: parsed.data.confidence,
    reason: parsed.data.legible ? null : parsed.data.reason,
    raw,
  };
}

async function compareCardMessages(
  detectedText: string,
  expectedMessage: string,
  attribution?: AiUsageAttribution,
): Promise<CardVerificationEvidence> {
  if (normalizeCardMessage(detectedText) === normalizeCardMessage(expectedMessage)) {
    return {
      pass: "comparison",
      source: "text",
      valid: true,
      approved: true,
      detectedText,
      confidence: 1,
      reason: null,
      raw: { method: "normalized_exact_match" },
    };
  }

  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const prompt = `Compare a greeting-card transcription with the expected order message.

Detected transcription:
"""
${detectedText}
"""

Expected message:
"""
${expectedMessage}
"""

Approve harmless presentation and handwriting/OCR variation: capitalization, punctuation, apostrophes, spacing, line breaks, an obvious single-character ambiguity, or a minor wording difference that preserves the same recipient, occasion, and meaning.
Reject only substantive differences: a clearly different recipient, occasion, sentiment, or materially missing/changed content. Do not reject because the transcription is imperfect; low visual confidence is handled by a separate confirmation pass.

Return ONLY valid JSON:
{
  "approved": true or false,
  "confidence": number from 0 to 1,
  "reason": null when approved, otherwise one short explanation of the material difference
}`;
  const response = await callAI({
    actionKey: "florist.card_message_comparison",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 512,
    orderId: attribution?.orderId == null ? null : String(attribution.orderId),
    messages: [{ role: "user", content: prompt }],
  });
  const raw = parseJsonObject(response.choices[0]?.message?.content ?? "");
  const parsed = cardComparisonSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pass: "comparison",
      source: "text",
      valid: false,
      approved: false,
      detectedText,
      confidence: 0,
      reason: "The message-comparison pass returned an unreadable result.",
      raw,
    };
  }
  return {
    pass: "comparison",
    source: "text",
    valid: true,
    approved: parsed.data.approved,
    detectedText,
    confidence: parsed.data.confidence,
    reason: parsed.data.approved ? null : parsed.data.reason,
    raw,
  };
}

async function confirmCardMessage(
  photos: Array<{ photo: CardPhoto; source: CardPhotoSource }>,
  expectedMessage: string,
  attribution?: AiUsageAttribution,
): Promise<CardVerificationEvidence> {
  const model = process.env.AI_FLORIST_VERIFICATION_MODEL ?? "gpt-4o";
  const prompt = `This is a focused final confirmation of a greeting card that was uncertain or appeared mismatched.

Expected order message:
"""
${expectedMessage}
"""

The first image is the original high-detail photo. A second image, when present, is an orientation-corrected, contrast- and sharpness-enhanced view of the same photo.
Re-read the card with the expected message as context, but do not invent text. Approve capitalization, punctuation, spacing, line-break, contraction, and minor handwriting/OCR differences when the substantive recipient, occasion, and meaning match. Reject only when the message remains genuinely unreadable or substantive content is confirmed different.

Return ONLY valid JSON:
{
  "legible": true or false,
  "approved": true or false,
  "detected_text": "best final transcription" or null,
  "confidence": number from 0 to 1,
  "reason": null when approved, otherwise one short actionable explanation
}`;
  const response = await callAI({
    actionKey: "florist.card_message_confirmation",
    surface: "dashboard",
    provider: "openai",
    client: openai,
    model,
    maxTokens: 768,
    orderId: attribution?.orderId == null ? null : String(attribution.orderId),
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...photos.map(({ photo }) => ({
          type: "image_url" as const,
          image_url: {
            url: `data:${photo.mime};base64,${photo.buffer.toString("base64")}`,
            detail: "high" as const,
          },
        })),
      ],
    }],
  });
  const raw = parseJsonObject(response.choices[0]?.message?.content ?? "");
  const parsed = cardConfirmationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      pass: "confirmation",
      source: photos.length > 1 ? "enhanced" : "original",
      valid: false,
      legible: false,
      approved: false,
      detectedText: null,
      confidence: 0,
      reason: "The focused confirmation returned an unreadable result.",
      raw,
    };
  }
  const legible = parsed.data.legible && parsed.data.detected_text != null;
  return {
    pass: "confirmation",
    source: photos.length > 1 ? "enhanced" : "original",
    valid: true,
    legible,
    approved: legible && parsed.data.approved,
    detectedText: parsed.data.detected_text,
    confidence: parsed.data.confidence,
    reason: legible && parsed.data.approved ? null : parsed.data.reason,
    raw,
  };
}

/**
 * Read the original card, compare its transcription separately, then use an
 * enhanced view and a focused expected-message confirmation before rejecting.
 * Transport failures throw; malformed model output is retained as evidence and
 * fails closed only after the staged checks are exhausted.
 */
export async function runCardTextVerification(
  cardPhoto: CardPhoto,
  expectedMessage: string,
  attribution?: AiUsageAttribution,
): Promise<CardTextVerificationResult> {
  const evidence: CardVerificationEvidence[] = [];
  const decisionPath: string[] = ["transcribed_original"];
  const original = await transcribeCardPhoto(cardPhoto, "original", attribution);
  evidence.push(original);

  const evaluate = async (
    transcription: CardVerificationEvidence,
  ): Promise<CardVerificationEvidence | null> => {
    if (!transcription.legible || !transcription.detectedText) return null;
    const comparison = await compareCardMessages(
      transcription.detectedText,
      expectedMessage,
      attribution,
    );
    evidence.push(comparison);
    decisionPath.push(
      comparison.approved ? "comparison_matched" : "comparison_uncertain_or_mismatched",
    );
    return comparison;
  };

  let bestTranscription = original;
  let comparison: CardVerificationEvidence | null = null;
  if (original.legible && original.confidence >= CARD_CONFIDENCE_THRESHOLD) {
    comparison = await evaluate(original);
    if (
      comparison?.approved &&
      comparison.confidence >= CARD_CONFIDENCE_THRESHOLD
    ) {
      const result = {
        legible: true,
        approved: true,
        detectedText: original.detectedText,
        confidence: Math.min(original.confidence, comparison.confidence),
        reason: null,
        decisionPath,
        evidence,
      };
      logger.info(
        { approved: true, decisionPath },
        "runCardTextVerification: staged check completed",
      );
      return result;
    }
  } else {
    decisionPath.push("original_low_confidence_or_unreadable");
  }

  const enhancedPhoto = await prepareEnhancedCardPhoto(cardPhoto);
  const photos: Array<{ photo: CardPhoto; source: CardPhotoSource }> = [
    { photo: cardPhoto, source: "original" },
  ];
  if (enhancedPhoto) {
    photos.push({ photo: enhancedPhoto, source: "enhanced" });
    decisionPath.push("generated_enhanced_view");
    const enhanced = await transcribeCardPhoto(enhancedPhoto, "enhanced", attribution);
    evidence.push(enhanced);
    decisionPath.push("transcribed_enhanced");
    if (
      enhanced.legible &&
      (!bestTranscription.legible || enhanced.confidence > bestTranscription.confidence)
    ) {
      bestTranscription = enhanced;
    }
    comparison = await evaluate(bestTranscription);
    if (
      comparison?.approved &&
      bestTranscription.confidence >= CARD_CONFIDENCE_THRESHOLD &&
      comparison.confidence >= CARD_CONFIDENCE_THRESHOLD
    ) {
      return {
        legible: true,
        approved: true,
        detectedText: bestTranscription.detectedText,
        confidence: Math.min(bestTranscription.confidence, comparison.confidence),
        reason: null,
        decisionPath,
        evidence,
      };
    }
  } else {
    decisionPath.push("enhancement_unavailable");
    if (!comparison) comparison = await evaluate(bestTranscription);
  }

  decisionPath.push("focused_confirmation");
  const confirmation = await confirmCardMessage(photos, expectedMessage, attribution);
  evidence.push(confirmation);
  if (
    confirmation.valid &&
    confirmation.approved &&
    confirmation.legible &&
    confirmation.confidence >= CARD_CONFIDENCE_THRESHOLD
  ) {
    decisionPath.push("confirmed_match");
    return {
      legible: true,
      approved: true,
      detectedText: confirmation.detectedText ?? bestTranscription.detectedText,
      confidence: confirmation.confidence,
      reason: null,
      decisionPath,
      evidence,
    };
  }

  const confirmedMaterialMismatch =
    confirmation.valid &&
    confirmation.legible === true &&
    confirmation.approved === false &&
    confirmation.confidence >= CARD_CONFIDENCE_THRESHOLD;
  decisionPath.push(
    confirmedMaterialMismatch
      ? "confirmed_material_mismatch"
      : "confirmed_unreadable_or_uncertain",
  );
  const result: CardTextVerificationResult = {
    legible: confirmedMaterialMismatch,
    approved: false,
    detectedText: confirmation.detectedText ?? bestTranscription.detectedText,
    confidence: confirmation.confidence,
    reason:
      confirmation.reason ??
      (confirmedMaterialMismatch ? CARD_MISMATCH_FAILURE : CARD_READ_FAILURE),
    decisionPath,
    evidence,
  };
  logger.info(
    { legible: result.legible, approved: false, decisionPath },
    "runCardTextVerification: staged check completed",
  );
  return result;
}
