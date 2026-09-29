import type { MerchantProductInput } from "./googleMerchant";
import sharp from "sharp";

const GOOGLE_CRAWLERS = ["Googlebot", "Googlebot-Image"] as const;
const PREFLIGHT_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

type RobotsRule = { allow: boolean; path: string };
type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
type OriginRobots = { text?: string; error?: string };

export interface MerchantImagePreflightFailure {
  url: string;
  reason: string;
}

export interface MerchantImagePreflightResult {
  ok: boolean;
  checked: number;
  failures: MerchantImagePreflightFailure[];
}

function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let group: RobotsGroup | null = null;
  let sawRule = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!group || sawRule) {
        group = { agents: [], rules: [] };
        groups.push(group);
        sawRule = false;
      }
      group.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && group) {
      sawRule = true;
      if (value) group.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

function ruleMatches(path: string, pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(robotsText: string, userAgent: string, path: string): boolean {
  const groups = parseRobots(robotsText);
  const agent = userAgent.toLowerCase();
  const matchingSpecificities = groups.flatMap((group) =>
    group.agents
      .filter((entry) => entry !== "*" && agent.includes(entry))
      .map((entry) => entry.length),
  );
  const bestSpecificity = matchingSpecificities.length > 0 ? Math.max(...matchingSpecificities) : 0;
  const exact = bestSpecificity > 0
    ? groups.filter((group) => group.agents.some((entry) => entry.length === bestSpecificity && agent.includes(entry)))
    : [];
  const applicable = exact.length > 0
    ? exact
    : groups.filter((group) => group.agents.includes("*"));
  const matches = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => ruleMatches(path, rule.path))
    .sort((a, b) => {
      const aSpecificity = a.path.replace(/\*|\$$/g, "").length;
      const bSpecificity = b.path.replace(/\*|\$$/g, "").length;
      return bSpecificity - aSpecificity || Number(b.allow) - Number(a.allow);
    });
  return matches[0]?.allow ?? true;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(PREFLIGHT_CONCURRENCY, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await operation(values[index]);
      }
    },
  ));
  return results;
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte preflight limit`);
  }
  if (!response.body) throw new Error("image response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte preflight limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("image response body is empty");
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function preflightOrigin(origin: string): Promise<OriginRobots> {
  try {
    const response = await fetchWithTimeout(`${origin}/robots.txt`, {
      headers: { "User-Agent": "Googlebot-Image" },
    });
    if (!response.ok) {
      return { error: `robots.txt returned HTTP ${response.status}` };
    }
    return { text: await response.text() };
  } catch (error) {
    return { error: `robots.txt could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkImage(
  rawUrl: string,
  robotsByOrigin: Map<string, OriginRobots>,
): Promise<MerchantImagePreflightFailure | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { url: rawUrl, reason: "image URL is invalid" };
  }
  if (url.protocol !== "https:") return { url: rawUrl, reason: "image URL is not HTTPS" };
  if (url.hostname !== "presentail.com" && !url.hostname.endsWith(".presentail.com")) {
    return { url: rawUrl, reason: "image URL is not on a Presentail-owned host" };
  }

  const robotsResult = robotsByOrigin.get(url.origin);
  if (!robotsResult) return { url: rawUrl, reason: "robots.txt was not checked for this origin" };
  if (robotsResult.error) return { url: rawUrl, reason: robotsResult.error };
  for (const crawler of GOOGLE_CRAWLERS) {
    if (!robotsAllows(robotsResult.text ?? "", crawler, `${url.pathname}${url.search}`)) {
      return { url: rawUrl, reason: `${crawler} is blocked by robots.txt` };
    }
  }

  try {
    const response = await fetchWithTimeout(rawUrl, {
      headers: { "User-Agent": "Googlebot-Image" },
    });
    const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (response.status !== 200) {
      await response.body?.cancel();
      return { url: rawUrl, reason: `image returned HTTP ${response.status}` };
    }
    if (!contentType.startsWith("image/")) {
      await response.body?.cancel();
      return { url: rawUrl, reason: `image returned non-image content type "${contentType || "missing"}"` };
    }
    const bytes = await readBoundedBody(response);
    // stats() forces libvips to decode the complete image rather than trusting
    // only its dimension header. failOn:"warning" rejects truncated payloads.
    await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS }).stats();
    return null;
  } catch (error) {
    return { url: rawUrl, reason: `image could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function preflightMerchantImages(
  payloads: ReadonlyArray<MerchantProductInput>,
): Promise<MerchantImagePreflightResult> {
  const urls = [...new Set(payloads.flatMap((payload) => [
    payload.productAttributes.imageLink,
    ...(payload.productAttributes.additionalImageLinks ?? []),
  ]).filter(Boolean))];
  const origins = [...new Set(urls.map((url) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname === "presentail.com" || parsed.hostname.endsWith(".presentail.com")
        ? parsed.origin
        : null;
    } catch { return null; }
  }).filter((origin): origin is string => Boolean(origin)))];
  const originResults = await mapConcurrent(origins, async (origin) => [origin, await preflightOrigin(origin)] as const);
  const robotsByOrigin = new Map(originResults);
  const failures = (await mapConcurrent(urls, (url) => checkImage(url, robotsByOrigin)))
    .filter((failure): failure is MerchantImagePreflightFailure => Boolean(failure));
  return { ok: failures.length === 0, checked: urls.length, failures };
}