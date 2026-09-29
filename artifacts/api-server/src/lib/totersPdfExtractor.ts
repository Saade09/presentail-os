import { logger } from "./logger";

export interface TotersExtractedItem {
  rank: number;
  name: string;
  quantity: number | null;
  revenue: number | null;
}

export interface TotersExtractedTrend {
  weekLabel: string;
  weekStart: string | null;
  value: number | null;
  metricName: string;
}

export interface TotersExtractedMetric {
  name: string;
  value: number | null;
  unit: string | null;
  category: string;
}

export interface TotersExtractedReport {
  merchantName: string | null;
  country: string | null;
  address: string | null;
  reportPeriodStart: string | null;
  reportPeriodEnd: string | null;
  metrics: TotersExtractedMetric[];
  weeklyTrends: TotersExtractedTrend[];
  bestSellingItems: TotersExtractedItem[];
  rawText: string;
  confidence?: number;
}

/**
 * Extract all text content from a PDF buffer using pdfjs-dist.
 */
async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const pdfDoc = await loadingTask.promise;

    const pageTexts: string[] = [];
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pageTexts.push(pageText);
    }

    // Use loadingTask.destroy() — pdfjs 6 removed pdfDoc.destroy().
    await loadingTask.destroy();
    return pageTexts.join("\n");
  } catch (err) {
    logger.warn({ err }, "totersPdfExtractor: failed to extract text from PDF");
    return "";
  }
}

/**
 * Parse a date string from formats like "DD/MM/YYYY", "DD-MM-YYYY", "Month DD, YYYY", "YYYY-MM-DD".
 * Returns ISO date string "YYYY-MM-DD" or null.
 */
function parseDate(raw: string): string | null {
  if (!raw) return null;
  const clean = raw.trim();

  const ddmmyyyy = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const yyyymmdd = clean.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (yyyymmdd) {
    const [, y, m, d] = yyyymmdd;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthWords = clean.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (monthWords) {
    const [, mon, d, y] = monthWords;
    const mIdx = monthNames.findIndex((m) => m.startsWith(mon.toLowerCase().slice(0, 3)));
    if (mIdx >= 0) {
      return `${y}-${String(mIdx + 1).padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Parse a numeric value from a string, stripping currency symbols and commas.
 */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[,$%\s]/g, "").replace(/[()]/g, "");
  const val = parseFloat(cleaned);
  return Number.isFinite(val) ? val : null;
}

/**
 * Extract report period from text.
 * Looks for patterns like "Period: 01/01/2024 - 31/01/2024" or "From: ... To: ..."
 */
function extractPeriod(text: string): { start: string | null; end: string | null } {
  const patterns = [
    /period\s*[:]\s*([\d\/\-]+)\s*[-–to]+\s*([\d\/\-]+)/i,
    /from\s*[:]\s*([\d\/\-]+)\s+to\s*[:]\s*([\d\/\-]+)/i,
    /report\s+(?:date|period)\s*[:]\s*([\d\/\-]+)\s*[-–]\s*([\d\/\-]+)/i,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s*[-–to]+\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i,
    /week\s+of\s+([\d\/\-]+)\s*[-–]\s*([\d\/\-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        start: parseDate(match[1]),
        end: parseDate(match[2]),
      };
    }
  }

  return { start: null, end: null };
}

/**
 * Extract merchant name from text.
 * Toters reports typically have "Restaurant/Merchant: Name" or the merchant name at the top.
 */
function extractMerchantName(text: string): string | null {
  const patterns = [
    /(?:restaurant|merchant|store|outlet|branch)\s*[:]\s*([^\n\r,]+)/i,
    /^([A-Z][A-Za-z0-9\s&'\-]+(?:Restaurant|Cafe|Kitchen|Grill|Express|Hub|Bakery)[^\n\r]*)/m,
    /dear\s+([A-Z][A-Za-z0-9\s&'\-]+),/i,
    /report\s+for\s+([^\n\r,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim().replace(/\s+/g, " ").slice(0, 200);
    }
  }

  return null;
}

/**
 * Extract summary metrics from text.
 * Looks for labeled number patterns like "Total Revenue: $1,234.56" or "Orders: 150"
 */
function extractMetrics(text: string): TotersExtractedMetric[] {
  const metrics: TotersExtractedMetric[] = [];

  const metricPatterns: Array<{ pattern: RegExp; name: string; unit: string | null; category: string }> = [
    { pattern: /total\s+(?:gross\s+)?(?:revenue|sales|gmv)\s*[:]\s*\$?([\d,\.]+)/i, name: "total_revenue", unit: "USD", category: "summary" },
    { pattern: /net\s+(?:revenue|sales)\s*[:]\s*\$?([\d,\.]+)/i, name: "net_revenue", unit: "USD", category: "summary" },
    { pattern: /(?:total\s+)?orders?\s*[:]\s*([\d,\.]+)/i, name: "total_orders", unit: "count", category: "summary" },
    { pattern: /(?:total\s+)?(?:unique\s+)?customers?\s*[:]\s*([\d,\.]+)/i, name: "total_customers", unit: "count", category: "summary" },
    { pattern: /avg(?:erage)?\s+order\s+value\s*[:]\s*\$?([\d,\.]+)/i, name: "avg_order_value", unit: "USD", category: "summary" },
    { pattern: /avg(?:erage)?\s+(?:delivery\s+)?(?:time|rating)\s*[:]\s*([\d,\.]+)/i, name: "avg_delivery_time", unit: "min", category: "operational" },
    { pattern: /(?:restaurant|partner)\s+rating\s*[:]\s*([\d,\.]+)/i, name: "rating", unit: "score", category: "operational" },
    { pattern: /acceptance\s+rate\s*[:]\s*([\d,\.]+)\s*%?/i, name: "acceptance_rate", unit: "%", category: "operational" },
    { pattern: /cancellation\s+rate\s*[:]\s*([\d,\.]+)\s*%?/i, name: "cancellation_rate", unit: "%", category: "operational" },
    { pattern: /new\s+customers?\s*[:]\s*([\d,\.]+)/i, name: "new_customers", unit: "count", category: "summary" },
    { pattern: /returning\s+customers?\s*[:]\s*([\d,\.]+)/i, name: "returning_customers", unit: "count", category: "summary" },
    { pattern: /impressions?\s*[:]\s*([\d,\.]+)/i, name: "impressions", unit: "count", category: "operational" },
    { pattern: /conversion\s+rate\s*[:]\s*([\d,\.]+)\s*%?/i, name: "conversion_rate", unit: "%", category: "operational" },
    { pattern: /promo(?:tion)?\s+(?:discount|cost|spend)\s*[:]\s*\$?([\d,\.]+)/i, name: "promo_cost", unit: "USD", category: "summary" },
    { pattern: /commission\s*[:]\s*\$?([\d,\.]+)/i, name: "commission", unit: "USD", category: "summary" },
  ];

  for (const { pattern, name, unit, category } of metricPatterns) {
    const match = text.match(pattern);
    if (match) {
      const value = parseNumber(match[1]);
      if (value !== null) {
        metrics.push({ name, value, unit, category });
      }
    }
  }

  return metrics;
}

/**
 * Extract weekly trend data.
 * Looks for patterns like "Week 1: $1,234" or tabular data with week labels and values.
 */
function extractWeeklyTrends(text: string): TotersExtractedTrend[] {
  const trends: TotersExtractedTrend[] = [];

  const weekPatterns = [
    /week\s*(\d+)\s*[:]\s*\$?([\d,\.]+)/gi,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s+\$?([\d,\.]+)/gi,
    /wk\.?\s*(\d+)\s+\$?([\d,\.]+)/gi,
  ];

  for (const pattern of weekPatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const value = parseNumber(match[2]);
      if (value !== null) {
        const weekLabel = match[1].includes("/") || match[1].includes("-")
          ? `Week of ${match[1]}`
          : `Week ${match[1]}`;
        const weekStart = parseDate(match[1]);
        trends.push({
          weekLabel,
          weekStart,
          value,
          metricName: "revenue",
        });
      }
    }
    if (trends.length > 0) break;
  }

  return trends;
}

/**
 * Extract best-selling items section.
 * Looks for a ranked list of items with optional quantity/revenue columns.
 */
function extractBestSellingItems(text: string): TotersExtractedItem[] {
  const items: TotersExtractedItem[] = [];

  const sectionPatterns = [
    /(?:best\s+selling|top\s+items?|most\s+ordered|popular\s+items?)[^\n]*\n([\s\S]*?)(?:\n\n|\n[A-Z]|\z)/i,
    /(?:top\s+\d+\s+items?)[^\n]*\n([\s\S]*?)(?:\n\n|\n[A-Z]|\z)/i,
  ];

  let sectionText = "";
  for (const pattern of sectionPatterns) {
    const match = text.match(pattern);
    if (match) {
      sectionText = match[1];
      break;
    }
  }

  if (sectionText) {
    const lines = sectionText.split(/\n/).filter((l) => l.trim());
    let rank = 1;
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine || cleanLine.length < 3) continue;

      const numberedMatch = cleanLine.match(/^(\d+)[\.\)]\s+(.+?)(?:\s+([\d,\.]+))?(?:\s+\$?([\d,\.]+))?$/);
      if (numberedMatch) {
        items.push({
          rank: parseInt(numberedMatch[1], 10),
          name: numberedMatch[2].trim(),
          quantity: numberedMatch[3] ? parseNumber(numberedMatch[3]) : null,
          revenue: numberedMatch[4] ? parseNumber(numberedMatch[4]) : null,
        });
        continue;
      }

      const itemMatch = cleanLine.match(/^([A-Za-z][A-Za-z0-9\s&'\-\(\)]+?)\s+([\d,\.]+)(?:\s+\$?([\d,\.]+))?$/);
      if (itemMatch && rank <= 20) {
        items.push({
          rank,
          name: itemMatch[1].trim(),
          quantity: parseNumber(itemMatch[2]),
          revenue: itemMatch[3] ? parseNumber(itemMatch[3]) : null,
        });
        rank++;
      }
    }
  }

  if (items.length === 0) {
    const numberedPattern = /(\d+)[\.\)]\s+([A-Za-z][A-Za-z0-9\s&'\-\(\)]+?)(?:\s+([\d,]+))?(?:\s+\$?([\d,\.]+))?(?=\n|$)/gm;
    let match;
    while ((match = numberedPattern.exec(text)) !== null) {
      const rankNum = parseInt(match[1], 10);
      if (rankNum <= 20 && match[2].trim().length > 2) {
        items.push({
          rank: rankNum,
          name: match[2].trim(),
          quantity: match[3] ? parseNumber(match[3]) : null,
          revenue: match[4] ? parseNumber(match[4]) : null,
        });
      }
    }
    items.sort((a, b) => a.rank - b.rank);
    const uniqueItems = items.filter(
      (item, idx) => items.findIndex((i) => i.rank === item.rank) === idx,
    );
    return uniqueItems.slice(0, 20);
  }

  return items.slice(0, 20);
}

/**
 * Main extractor: parses a Toters PDF buffer and returns structured data.
 */
export async function extractTotersPdf(buffer: Buffer): Promise<TotersExtractedReport> {
  const rawText = await extractTextFromPdf(buffer);

  if (!rawText.trim()) {
    return {
      merchantName: null,
      country: null,
      address: null,
      reportPeriodStart: null,
      reportPeriodEnd: null,
      metrics: [],
      weeklyTrends: [],
      bestSellingItems: [],
      rawText: "",
    };
  }

  const merchantName = extractMerchantName(rawText);
  const period = extractPeriod(rawText);
  const metrics = extractMetrics(rawText);
  const weeklyTrends = extractWeeklyTrends(rawText);
  const bestSellingItems = extractBestSellingItems(rawText);

  const countryMatch = rawText.match(/(?:country|location|region)\s*[:]\s*([A-Za-z\s]+?)(?:\n|,)/i);
  const country = countryMatch ? countryMatch[1].trim().slice(0, 100) : null;

  const addressMatch = rawText.match(/(?:address|branch)\s*[:]\s*([^\n\r]{5,150})/i);
  const address = addressMatch ? addressMatch[1].trim() : null;

  return {
    merchantName,
    country,
    address,
    reportPeriodStart: period.start,
    reportPeriodEnd: period.end,
    metrics,
    weeklyTrends,
    bestSellingItems,
    rawText: rawText.slice(0, 50000),
  };
}

/**
 * Normalize a merchant name for alias matching:
 * lowercase, trim extra whitespace, remove common suffixes and punctuation.
 */
export function normalizeMerchantName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/['']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(restaurant|cafe|kitchen|grill|express|hub|bakery|co|ltd|llc|inc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute a simple Levenshtein similarity score (0-1) between two strings.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  const distance = matrix[b.length][a.length];
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}
