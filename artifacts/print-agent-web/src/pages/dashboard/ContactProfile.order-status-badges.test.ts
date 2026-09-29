import { describe, it, expect, afterEach } from "vitest";
import i18n from "@/i18n";
import {
  ORDER_STATUS_COLORS,
  ORDER_STATUS_LABEL_KEYS,
  ORDER_STATUSES,
  type OrderStatus,
} from "@/lib/orderStatus";

/**
 * These tests guard the order status badge rendering used in the Contact
 * Profile order history table (ContactProfile.tsx ~line 714).
 *
 * Badge class:  ORDER_STATUS_COLORS[o.status] ?? ""
 * Badge label:  t(ORDER_STATUS_LABEL_KEYS[o.status] ?? "orders.statusPending")
 *
 * If either mapping is missing or the i18n key is unresolved the badge will
 * show an empty/unstyled chip or raw snake_case text — this test catches both.
 */

describe("ContactProfile order history — status badge mappings", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  const REPRESENTATIVE_STATUSES: OrderStatus[] = [
    "ready_for_delivery",
    "out_for_delivery",
    "on_hold",
    "pending",
    "processing",
    "preparing",
    "completed",
    "cancelled",
    "refunded",
  ];

  describe("English locale", () => {
    it("every representative status has a non-empty badge color class", () => {
      for (const status of REPRESENTATIVE_STATUSES) {
        const colorClass = ORDER_STATUS_COLORS[status];
        expect(
          colorClass,
          `ORDER_STATUS_COLORS["${status}"] should be a non-empty string`,
        ).toBeTruthy();
        expect(typeof colorClass).toBe("string");
      }
    });

    it("every representative status has a non-empty i18n key entry", () => {
      for (const status of REPRESENTATIVE_STATUSES) {
        const key = ORDER_STATUS_LABEL_KEYS[status];
        expect(
          key,
          `ORDER_STATUS_LABEL_KEYS["${status}"] should be defined`,
        ).toBeTruthy();
      }
    });

    it("translated labels are human-readable (not raw snake_case)", () => {
      for (const status of REPRESENTATIVE_STATUSES) {
        const key = ORDER_STATUS_LABEL_KEYS[status];
        const label = i18n.t(key);
        expect(
          label,
          `English label for "${status}" should not be the raw i18n key`,
        ).not.toBe(key);
        expect(
          label,
          `English label for "${status}" should not be snake_case (got "${label}")`,
        ).not.toMatch(/^[a-z]+(_[a-z]+)+$/);
      }
    });

    it.each([
      ["ready_for_delivery", "Ready for delivery"],
      ["out_for_delivery", "Out for delivery"],
      ["on_hold", "On hold"],
    ] as [OrderStatus, string][])(
      'status "%s" renders English label "%s"',
      (status, expectedLabel) => {
        const key = ORDER_STATUS_LABEL_KEYS[status];
        expect(i18n.t(key)).toBe(expectedLabel);
      },
    );
  });

  describe("Arabic locale", () => {
    it("translated labels are non-empty and differ from the English label", async () => {
      await i18n.changeLanguage("ar");

      for (const status of REPRESENTATIVE_STATUSES) {
        const key = ORDER_STATUS_LABEL_KEYS[status];
        const arLabel = i18n.t(key);

        expect(
          arLabel,
          `Arabic label for "${status}" should not be the raw i18n key`,
        ).not.toBe(key);
        expect(
          arLabel,
          `Arabic label for "${status}" should not be empty`,
        ).toBeTruthy();

        await i18n.changeLanguage("en");
        const enLabel = i18n.t(key);
        await i18n.changeLanguage("ar");

        expect(
          arLabel,
          `Arabic label for "${status}" should differ from English label`,
        ).not.toBe(enLabel);
      }
    });

    it.each([
      ["ready_for_delivery", "جاهز للتوصيل"],
      ["out_for_delivery", "قيد التوصيل"],
      ["on_hold", "في الانتظار"],
    ] as [OrderStatus, string][])(
      'status "%s" renders Arabic label "%s"',
      async (status, expectedLabel) => {
        await i18n.changeLanguage("ar");
        const key = ORDER_STATUS_LABEL_KEYS[status];
        expect(i18n.t(key)).toBe(expectedLabel);
      },
    );
  });

  describe("ALL statuses in ORDER_STATUSES are fully covered", () => {
    it("every status has a color class", () => {
      for (const status of ORDER_STATUSES) {
        expect(
          ORDER_STATUS_COLORS[status],
          `Missing color for status "${status}"`,
        ).toBeTruthy();
      }
    });

    it("every status has a label key", () => {
      for (const status of ORDER_STATUSES) {
        expect(
          ORDER_STATUS_LABEL_KEYS[status],
          `Missing label key for status "${status}"`,
        ).toBeTruthy();
      }
    });

    it("every status resolves to a translated English string (not a key fallback)", () => {
      for (const status of ORDER_STATUSES) {
        const key = ORDER_STATUS_LABEL_KEYS[status];
        const label = i18n.t(key);
        expect(label, `Unresolved key for status "${status}": ${label}`).not.toBe(key);
      }
    });
  });
});
