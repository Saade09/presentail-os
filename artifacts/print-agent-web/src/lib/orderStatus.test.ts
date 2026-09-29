import { describe, it, expect } from "vitest";
import {
  ORDER_STATUS_COLORS,
  ORDER_STATUSES,
  ORDER_STATUS_FALLBACK_CLASS,
  normalizeOrderStatus,
  orderStatusBadgeClass,
} from "@/lib/orderStatus";

/**
 * Guards the approved five-color order lifecycle palette (exact
 * background/text hex pairs) and the status normalizer that drives every
 * badge color lookup.
 */

const APPROVED_PALETTE: Record<string, { bg: string; text: string }> = {
  preparing: { bg: "#FCE7F3", text: "#9D174D" },
  processing: { bg: "#EDE9FE", text: "#6D28D9" },
  ready_for_delivery: { bg: "#FEF3C7", text: "#92400E" },
  out_for_delivery: { bg: "#DBEAFE", text: "#1D4ED8" },
  completed: { bg: "#DCFCE7", text: "#166534" },
};

describe("five-color lifecycle palette", () => {
  it.each(Object.entries(APPROVED_PALETTE))(
    "%s uses the exact approved background/text pair",
    (status, { bg, text }) => {
      const cls = ORDER_STATUS_COLORS[status];
      expect(cls).toContain(`bg-[${bg}]`);
      expect(cls).toContain(`text-[${text}]`);
      // Hover must not wash out the badge background inside hoverable rows.
      expect(cls).toContain(`hover:bg-[${bg}]`);
    },
  );

  it("the five lifecycle backgrounds are all distinct", () => {
    const bgs = Object.values(APPROVED_PALETTE).map((p) => p.bg);
    expect(new Set(bgs).size).toBe(bgs.length);
  });

  it("every canonical status still has a color class", () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_STATUS_COLORS[status]).toBeTruthy();
    }
  });

  it("red stays reserved for cancelled/failed", () => {
    expect(ORDER_STATUS_COLORS.cancelled).toContain("red");
    expect(ORDER_STATUS_COLORS.failed).toContain("red");
    for (const status of Object.keys(APPROVED_PALETTE)) {
      expect(ORDER_STATUS_COLORS[status]).not.toContain("red");
    }
  });
});

describe("normalizeOrderStatus", () => {
  it("maps legacy delivered to completed", () => {
    expect(normalizeOrderStatus("delivered")).toBe("completed");
    expect(normalizeOrderStatus("Delivered")).toBe("completed");
  });

  it("normalizes label-cased and hyphenated variants to snake_case keys", () => {
    expect(normalizeOrderStatus("Ready For Delivery")).toBe("ready_for_delivery");
    expect(normalizeOrderStatus("Ready for delivery")).toBe("ready_for_delivery");
    expect(normalizeOrderStatus("on-hold")).toBe("on_hold");
    expect(normalizeOrderStatus("Out For Delivery")).toBe("out_for_delivery");
  });

  it("leaves canonical values unchanged", () => {
    for (const status of ORDER_STATUSES) {
      expect(normalizeOrderStatus(status)).toBe(status);
    }
  });
});

describe("orderStatusBadgeClass", () => {
  it("resolves colors for variant spellings", () => {
    expect(orderStatusBadgeClass("on-hold")).toBe(ORDER_STATUS_COLORS.on_hold);
    expect(orderStatusBadgeClass("Preparing")).toBe(
      ORDER_STATUS_COLORS.preparing,
    );
    expect(orderStatusBadgeClass("delivered")).toBe(
      ORDER_STATUS_COLORS.completed,
    );
  });

  it("falls back to a neutral class for unknown statuses", () => {
    expect(orderStatusBadgeClass("something_new")).toBe(
      ORDER_STATUS_FALLBACK_CLASS,
    );
  });
});
