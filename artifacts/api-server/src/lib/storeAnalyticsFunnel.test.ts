import { describe, expect, it } from "vitest";
import {
  FUNNEL_STEPS,
  FUNNEL_CONVERTED_STEP_KEYS,
  FUNNEL_LANGUAGE_BUCKETS,
  buildFunnelQuery,
  funnelConvertedSql,
  languageBucketSql,
} from "./storeAnalytics";

const paymentIdx = FUNNEL_STEPS.findIndex((s) => s.key === "payment_completed");
const orderIdx = FUNNEL_STEPS.findIndex((s) => s.key === "order_created");

describe("funnelConvertedSql", () => {
  it("includes both payment_completed and order_created step flags", () => {
    expect(paymentIdx).toBeGreaterThanOrEqual(0);
    expect(orderIdx).toBeGreaterThanOrEqual(0);
    expect(funnelConvertedSql()).toBe(`(s${paymentIdx} OR s${orderIdx})`);
  });

  it("matches the declared converted step keys", () => {
    expect(FUNNEL_CONVERTED_STEP_KEYS).toEqual([
      "payment_completed",
      "order_created",
    ]);
  });
});

describe("languageBucketSql", () => {
  const sql = languageBucketSql("language");

  it("lowercases and strips the region subtag (handles - and _)", () => {
    expect(sql).toContain(
      "lower(split_part(replace(COALESCE(language, ''), '_', '-'), '-', 1))",
    );
  });

  it("buckets to en/ar/fr with everything else as other", () => {
    expect(FUNNEL_LANGUAGE_BUCKETS).toEqual(["en", "ar", "fr"]);
    expect(sql).toContain("IN ('en', 'ar', 'fr')");
    expect(sql).toContain("ELSE 'other'");
    expect(sql.startsWith("CASE WHEN ")).toBe(true);
  });
});

describe("buildFunnelQuery", () => {
  const query = buildFunnelQuery("", true);

  it("keeps per-step counts based on each step's own flag", () => {
    for (let i = 0; i < FUNNEL_STEPS.length; i++) {
      expect(query).toContain(`count(*) FILTER (WHERE s${i}) AS s${i}`);
    }
  });

  it("uses the broadened conversion definition in every breakdown", () => {
    const filter = `count(*) FILTER (WHERE (s${paymentIdx} OR s${orderIdx})) AS conversions`;
    const occurrences = query.split(filter).length - 1;
    // device, country, city, language, traffic source
    expect(occurrences).toBe(5);
    // The old last-step-only definition is gone.
    expect(query).not.toContain(`FILTER (WHERE s${orderIdx}) AS conversions`);
  });

  it("normalizes the language breakdown but leaves other dimensions raw", () => {
    expect(query).toContain(languageBucketSql("language"));
    expect(query).not.toContain(
      "COALESCE(NULLIF(language, ''), 'unknown') AS value",
    );
    for (const col of ["device_type", "country", "city", "traffic_source"]) {
      expect(query).toContain(`COALESCE(NULLIF(${col}, ''), 'unknown') AS value`);
    }
  });

  it("omits breakdowns when withBreakdowns is false (comparison query)", () => {
    const prev = buildFunnelQuery("", false);
    expect(prev).not.toContain("by_language");
    expect(prev).not.toContain("conversions");
    // Step counts are still present and unchanged.
    expect(prev).toContain(`count(*) FILTER (WHERE s${orderIdx}) AS s${orderIdx}`);
  });
});
