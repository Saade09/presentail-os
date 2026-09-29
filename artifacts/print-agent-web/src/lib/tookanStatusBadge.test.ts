import { describe, expect, it } from "vitest";
import { getTookanStatusBadge } from "./tookanStatusBadge";

import en from "../locales/en.json";
import ar from "../locales/ar.json";

function lookup(locale: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((obj, part) => {
    if (obj && typeof obj === "object") return (obj as Record<string, unknown>)[part];
    return undefined;
  }, locale);
}

describe("getTookanStatusBadge", () => {
  it("maps progression statuses to specific labeled badges", () => {
    const cases: Array<[string, string, string]> = [
      ["assigned", "orders.tookanStatusAssigned", "blue"],
      ["started", "orders.tookanStatusStarted", "blue"],
      ["in_progress", "orders.tookanStatusInProgress", "blue"],
      ["arrived", "orders.tookanStatusArrived", "blue"],
      ["accepted", "orders.tookanStatusAccepted", "blue"],
      ["successful", "orders.tookanStatusSuccessful", "green"],
      ["created", "orders.tookanStatusCreated", "green"],
      ["declined", "orders.tookanStatusDeclined", "red"],
      ["cancelled", "orders.tookanStatusCancelled", "red"],
      ["deleted", "orders.tookanStatusDeleted", "red"],
      ["failed", "orders.tookanStatusFailed", "red"],
      ["unassigned", "orders.tookanStatusUnassigned", "amber"],
      ["awaiting_payment", "orders.tookanStatusAwaitingPayment", "amber"],
    ];
    for (const [status, labelKey, color] of cases) {
      const badge = getTookanStatusBadge(status, "12345");
      expect(badge.labelKey, status).toBe(labelKey);
      expect(badge.className, status).toContain(`bg-${color}-100`);
    }
  });

  it("shows Created (never Not Created) for unknown statuses when a job id exists", () => {
    for (const status of ["status_11", "status_99", "something_new", ""]) {
      const badge = getTookanStatusBadge(status, 987654);
      expect(badge.labelKey, status).toBe("orders.tookanStatusCreated");
      expect(badge.className, status).toContain("bg-green-100");
    }
    expect(getTookanStatusBadge(null, "12345").labelKey).toBe("orders.tookanStatusCreated");
  });

  it("shows Not Created only when there is no job id and status is unrecognized", () => {
    for (const jobId of [null, undefined, "", "   "]) {
      const badge = getTookanStatusBadge(null, jobId);
      expect(badge.labelKey).toBe("orders.tookanStatusNotCreated");
      expect(badge.className).toContain("bg-secondary");
    }
    expect(getTookanStatusBadge("status_11", null).labelKey).toBe("orders.tookanStatusNotCreated");
  });

  it("keeps failed and awaiting_payment badges even without a job id", () => {
    expect(getTookanStatusBadge("failed", null).labelKey).toBe("orders.tookanStatusFailed");
    expect(getTookanStatusBadge("awaiting_payment", null).labelKey).toBe(
      "orders.tookanStatusAwaitingPayment",
    );
  });

  it("normalizes casing and whitespace", () => {
    expect(getTookanStatusBadge(" Assigned ", null).labelKey).toBe("orders.tookanStatusAssigned");
    expect(getTookanStatusBadge("IN_PROGRESS", null).labelKey).toBe(
      "orders.tookanStatusInProgress",
    );
  });

  it("has en + ar translations for every label key the badge can produce", () => {
    const keys = new Set<string>();
    for (const status of [
      "created",
      "successful",
      "assigned",
      "started",
      "in_progress",
      "arrived",
      "accepted",
      "unassigned",
      "failed",
      "declined",
      "cancelled",
      "deleted",
      "awaiting_payment",
      "status_42",
      null,
    ]) {
      keys.add(getTookanStatusBadge(status, "1").labelKey);
      keys.add(getTookanStatusBadge(status, null).labelKey);
    }
    for (const key of keys) {
      expect(typeof lookup(en, key), `en missing ${key}`).toBe("string");
      expect(typeof lookup(ar, key), `ar missing ${key}`).toBe("string");
    }
  });
});
