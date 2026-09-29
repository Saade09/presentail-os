import { describe, expect, it } from "vitest";
import {
  computeAutoTags,
  planAutoTagChanges,
  isCorporateEmail,
  hasCorporateKeyword,
  VIP_SPEND_THRESHOLD_USD,
} from "./autoTags";

const base = {
  customerOrders: 0,
  totalSpentUsd: 0,
  email: null as string | null,
  corporateTexts: [] as Array<string | null | undefined>,
};

describe("isCorporateEmail", () => {
  it("rejects free providers and missing/invalid emails", () => {
    expect(isCorporateEmail(null)).toBe(false);
    expect(isCorporateEmail("")).toBe(false);
    expect(isCorporateEmail("nodomain")).toBe(false);
    expect(isCorporateEmail("x@gmail.com")).toBe(false);
    expect(isCorporateEmail("x@GMAIL.COM")).toBe(false);
    expect(isCorporateEmail("x@yahoo.co.uk")).toBe(false);
    expect(isCorporateEmail("x@localhost")).toBe(false);
  });

  it("accepts company domains", () => {
    expect(isCorporateEmail("ceo@acme.com")).toBe(true);
    expect(isCorporateEmail("info@presentail.com")).toBe(true);
  });
});

describe("hasCorporateKeyword", () => {
  it("matches legal-suffix keywords with word boundaries", () => {
    expect(hasCorporateKeyword(["Presentail SAL"])).toBe(true);
    expect(hasCorporateKeyword(["Acme LLC"])).toBe(true);
    expect(hasCorporateKeyword(["Foo Trading"])).toBe(true);
    expect(hasCorporateKeyword(["My Holding Group"])).toBe(true);
  });

  it("does not match keywords embedded in words", () => {
    expect(hasCorporateKeyword(["Salma"])).toBe(false);
    expect(hasCorporateKeyword(["Salim"])).toBe(false);
    expect(hasCorporateKeyword(["Coco"])).toBe(false);
    expect(hasCorporateKeyword([null, undefined, ""])).toBe(false);
  });
});

describe("computeAutoTags", () => {
  it("returns nothing for contacts with no customer orders", () => {
    expect(
      computeAutoTags({ ...base, totalSpentUsd: 5000, email: "x@acme.com" }),
    ).toEqual([]);
  });

  it("one-time for exactly one order, regular for 2+", () => {
    expect(computeAutoTags({ ...base, customerOrders: 1 })).toEqual(["one-time"]);
    expect(computeAutoTags({ ...base, customerOrders: 2 })).toEqual(["regular"]);
    expect(computeAutoTags({ ...base, customerOrders: 9 })).toEqual(["regular"]);
  });

  it("vip strictly above the threshold", () => {
    expect(
      computeAutoTags({ ...base, customerOrders: 1, totalSpentUsd: VIP_SPEND_THRESHOLD_USD }),
    ).toEqual(["one-time"]);
    expect(
      computeAutoTags({ ...base, customerOrders: 1, totalSpentUsd: VIP_SPEND_THRESHOLD_USD + 0.01 }),
    ).toEqual(["vip", "one-time"]);
  });

  it("corporate from email domain or keyword", () => {
    expect(
      computeAutoTags({ ...base, customerOrders: 1, email: "x@acme.com" }),
    ).toEqual(["corporate", "one-time"]);
    expect(
      computeAutoTags({
        ...base,
        customerOrders: 3,
        email: "x@gmail.com",
        corporateTexts: ["Beirut Flowers SARL"],
      }),
    ).toEqual(["corporate", "regular"]);
  });
});

describe("planAutoTagChanges", () => {
  it("adds only tags not present and not previously applied", () => {
    const plan = planAutoTagChanges({
      currentTags: ["customer"],
      autoApplied: [],
      desired: ["vip", "one-time"],
    });
    expect(plan.toAdd.sort()).toEqual(["one-time", "vip"]);
    expect(plan.toRemove).toEqual([]);
    expect(plan.newApplied.sort()).toEqual(["one-time", "vip"]);
  });

  it("never re-adds a tag the user removed (in applied set but not tags)", () => {
    const plan = planAutoTagChanges({
      currentTags: ["customer"],
      autoApplied: ["vip"],
      desired: ["vip", "regular"],
    });
    expect(plan.toAdd).toEqual(["regular"]);
  });

  it("is case-insensitive against existing tags", () => {
    const plan = planAutoTagChanges({
      currentTags: ["VIP", "Regular"],
      autoApplied: [],
      desired: ["vip", "regular"],
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  it("swaps one-time for regular only while auto-owned", () => {
    const owned = planAutoTagChanges({
      currentTags: ["one-time"],
      autoApplied: ["one-time"],
      desired: ["regular"],
    });
    expect(owned.toAdd).toEqual(["regular"]);
    expect(owned.toRemove).toEqual(["one-time"]);

    // Manual-owned: user re-added it (applied set cleared) — untouchable.
    const manual = planAutoTagChanges({
      currentTags: ["one-time"],
      autoApplied: [],
      desired: ["regular"],
    });
    expect(manual.toAdd).toEqual(["regular"]);
    expect(manual.toRemove).toEqual([]);
  });

  it("keeps the applied set monotonic (union)", () => {
    const plan = planAutoTagChanges({
      currentTags: [],
      autoApplied: ["one-time"],
      desired: ["regular"],
    });
    expect(plan.toAdd).toEqual(["regular"]);
    expect(plan.newApplied.sort()).toEqual(["one-time", "regular"]);
  });
});
