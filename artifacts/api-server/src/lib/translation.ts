import { logger } from "./logger";
import { callAI } from "./ai/callAI";
import { aiUsageAttribution, type AiUsageAttribution } from "./aiUsageRecorder";

/**
 * Classify whether a string is predominantly Arabic or Latin script.
 * A text is "arabic" when more than 30 % of its characters fall in the
 * Arabic Unicode block (U+0600–U+06FF). This mirrors the same check used
 * for abbreviation expansion in address normalisation.
 */
export function detectScript(text: string): "arabic" | "latin" {
  if (!text) return "latin";
  let arabicCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x0600 && cp <= 0x06ff) arabicCount++;
  }
  return arabicCount / text.length > 0.3 ? "arabic" : "latin";
}

/**
 * Best-effort translate a delivery address or place name to English via OpenAI.
 *
 * Returns `null` (never throws) when:
 *   - The input is already Latin script (detectScript returns "latin")
 *   - The OpenAI call fails for any reason
 *
 * Callers should fall back to storing the original text on `null`.
 */
export async function translateAddressToEnglish(text: string, attribution?: AiUsageAttribution): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Skip translation when the text is already in a Latin script.
  if (detectScript(trimmed) !== "arabic") return null;

  try {
    const completion = await callAI({
      actionKey: "translation.address_to_english",
      surface: "translation",
      provider: "openai",
      model: MODEL,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "system",
          content:
            "You translate delivery address text faithfully into English. " +
            "Preserve building numbers and international proper nouns such as hotel brands, " +
            "hospital names, and well-known landmarks exactly as they are commonly written in English. " +
            "Respond with ONLY the translated text, no quotes, no explanation.",
        },
        { role: "user", content: trimmed },
      ],
      maxTokens: 8192,
    });

    const translated = completion.choices[0]?.message?.content?.trim();
    if (!translated) return null;
    return translated;
  } catch (err) {
    logger.warn({ err, text: trimmed }, "Failed to auto-translate address to English");
    return null;
  }
}

const MODEL = process.env.AI_TRANSLATE_MODEL ?? "gpt-5-mini";

/**
 * Best-effort translate a short product/item name into Arabic using the
 * existing OpenAI integration. Returns `null` (never throws) on any failure
 * so callers can fail open and simply skip caching a translation.
 */
export async function translateToArabic(text: string, attribution?: AiUsageAttribution): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const completion = await callAI({
      actionKey: "translation.item_to_arabic",
      surface: "translation",
      provider: "openai",
      model: MODEL,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "system",
          content:
            "You translate short product/item names from English to Modern Standard Arabic for a purchase order. " +
            "Respond with ONLY the Arabic translation, no quotes, no explanation, no transliteration.",
        },
        { role: "user", content: trimmed },
      ],
      maxTokens: 8192,
    });

    const translated = completion.choices[0]?.message?.content?.trim();
    if (!translated) return null;
    return translated;
  } catch (err) {
    logger.warn({ err, text: trimmed }, "Failed to auto-translate item name to Arabic");
    return null;
  }
}

/**
 * Best-effort translate a product description (longer prose) into Arabic.
 * Returns `null` (never throws) on any failure so callers can fail open.
 */
export async function translateDescriptionToArabic(
  text: string,
  attribution?: AiUsageAttribution,
): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const completion = await callAI({
      actionKey: "translation.description_to_arabic",
      surface: "translation",
      provider: "openai",
      model: MODEL,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "system",
          content:
            "You translate product descriptions from English to Modern Standard Arabic for a flower shop. " +
            "Preserve line breaks. Respond with ONLY the Arabic translation, no quotes, no explanation, no transliteration.",
        },
        { role: "user", content: trimmed },
      ],
      maxTokens: 8192,
    });

    const translated = completion.choices[0]?.message?.content?.trim();
    if (!translated) return null;
    return translated;
  } catch (err) {
    logger.warn(
      { err, textLength: trimmed.length },
      "Failed to auto-translate product description to Arabic",
    );
    return null;
  }
}
