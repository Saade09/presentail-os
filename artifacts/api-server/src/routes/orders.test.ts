import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockRequestLogError = vi.fn();
const mockDbConnect = vi.fn(async () => ({
  query: (...args: unknown[]) => mockClientQuery(...args),
  release: (...args: unknown[]) => mockClientRelease(...args),
}));
const { mockSyncContactToRespondIo } = vi.hoisted(() => ({
  mockSyncContactToRespondIo: vi.fn().mockResolvedValue(undefined),
}));

const { mockSendWhishPaymentInstructions } = vi.hoisted(() => ({
  mockSendWhishPaymentInstructions: vi.fn().mockResolvedValue({ ok: false }),
}));

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
  sendWhishPaymentInstructions: (...args: unknown[]) => mockSendWhishPaymentInstructions(...args),
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  linkOrderToAddressBook: vi.fn().mockResolvedValue(undefined),
}));

const mockRecalcScheduleForOrder = vi.fn().mockResolvedValue(undefined);
const mockFinalizeAddressCollectionForOrder = vi.fn().mockResolvedValue(0);
const mockCreateAutomaticAddressCollectionRequest = vi.fn().mockResolvedValue({
  created: false,
  reason: "order_not_eligible",
});
vi.mock("../lib/addressCollector/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/addressCollector/service")>();
  return {
    ...actual,
    recalcScheduleForOrder: (...args: unknown[]) =>
      mockRecalcScheduleForOrder(...args),
    finalizeAddressCollectionForOrder: (...args: unknown[]) =>
      mockFinalizeAddressCollectionForOrder(...args),
    createAutomaticAddressCollectionRequest: (...args: unknown[]) =>
      mockCreateAutomaticAddressCollectionRequest(...args),
  };
});

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockDbConnect(),
  },
  // Run the transactional callback immediately for unit tests.
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/contactUpsert", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/contactUpsert")>();
  return {
    ...actual,
    syncContactToRespondIo: (...args: unknown[]) => mockSyncContactToRespondIo(...args),
  };
});

describe("delivery reschedule operation", () => {
  const rescheduleOrderId = "11111111-1111-1111-1111-111111111111";
  const lockedOrder = {
    id: rescheduleOrderId,
    status: "processing",
    external_order_id: "PT-2049",
    delivery_type: "standard",
    delivery_address: { cityId: 7, city: "Beirut" },
    window_start: "2026-09-09T11:00:00.000Z",
    window_end: "2026-09-09T15:00:00.000Z",
    tookan_job_id: null,
  };
  const cityRow = {
    id: 7,
    timezone: "Asia/Beirut",
    is_active: true,
    standard_available: true,
    express_available: true,
    standard_capacity: 2,
    express_capacity: 2,
    standard_cutoff_time: null,
    express_enabled: true,
    express_start_time: "14:00",
    express_end_time: "18:00",
    express_cutoff_time: null,
    express_min_prep_minutes: 0,
    express_daily_capacity: 2,
    standard_globally_active: true,
    express_globally_active: true,
  };
  const weeklySlot = {
    id: "12",
    label: "Afternoon",
    start_time: "14:00",
    end_time: "18:00",
    capacity: 2,
    cutoff_time: null,
    same_day_available: true,
    next_day_available: true,
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockRequestLogError.mockReset();
    mockDbConnect.mockClear();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockRecalcScheduleForOrder.mockClear();
    mockSendOrderRescheduledEmail.mockClear();
    mockIsTookanEnabled.mockReturnValue(false);
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockAvailableOptions(
    order: Omit<typeof lockedOrder, "delivery_address"> & {
      delivery_address: Record<string, unknown> | null;
    },
  ) {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [order], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 });
  }

  it.each([
    ["numeric cityId", { cityId: 7 }, ["7", "", "", "", ""]],
    ["slug cityId", { cityId: "beirut" }, ["beirut", "", "", "", ""]],
    ["legacy city_id", { city_id: "beirut" }, ["", "beirut", "", "", ""]],
    ["cityName", { cityName: "Beirut" }, ["", "", "Beirut", "", ""]],
    ["city", { city: "Beirut" }, ["", "", "", "Beirut", ""]],
    ["district", { district: "Beirut" }, ["", "", "", "", "Beirut"]],
    [
      "cityName fallback after a stale cityId",
      { cityId: "retired-beirut", cityName: "Beirut" },
      ["retired-beirut", "", "Beirut", "", ""],
    ],
  ])("loads reschedule options from %s", async (_label, deliveryAddress, expectedRefs) => {
    mockAvailableOptions({ ...lockedOrder, delivery_address: deliveryAddress });

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2026-09-10" });

    expect(response.status).toBe(200);
    expect(response.body.slots).toEqual([
      expect.objectContaining({
        id: "12",
        start_time: "14:00",
        end_time: "18:00",
      }),
    ]);
    expect(mockDbQuery.mock.calls[1]?.[1]).toEqual([
      "owner_123",
      ...expectedRefs,
    ]);
  });

  it("withholds conflicting duplicate weekly rows from the final option list", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          weeklySlot,
          {
            ...weeklySlot,
            id: "13",
            capacity: null,
            same_day_available: false,
          },
        ],
        rowCount: 2,
      });

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2026-09-10" });

    expect(response.status).toBe(200);
    expect(response.body.slots).toEqual([]);
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["missing", null, undefined],
    ["stale", { cityId: "does-not-exist" }, undefined],
    ["inactive", { cityId: 7 }, { ...cityRow, is_active: false }],
    ["out-of-workspace", { cityId: 99 }, undefined],
  ])(
    "returns an unavailable error for a %s delivery area",
    async (_label, deliveryAddress, resolvedCity) => {
      mockDbQuery
        .mockResolvedValueOnce({
          rows: [{ ...lockedOrder, delivery_address: deliveryAddress }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: resolvedCity ? [resolvedCity] : [],
          rowCount: resolvedCity ? 1 : 0,
        });

      const response = await request(makeApp())
        .get(`/orders/${rescheduleOrderId}/reschedule-options`)
        .query({ date: "2026-09-10" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        success: false,
        code: "delivery_area_unavailable",
        error: "The delivery area is unavailable",
      });
      expect(mockDbQuery.mock.calls[1]?.[1]?.[0]).toBe("owner_123");
    },
  );

  it("rejects impossible calendar dates before querying the order", async () => {
    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-02-30", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(400);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("requires the server-provided slot identity", async () => {
    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-09-10", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_schedule");
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("persists schedule metadata and audit data together, then replans", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({
        date: "2026-09-10",
        slot_id: "12",
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders")),
    ).toBe(true);
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringMatching(
        /UPDATE fleet_driver_order_assignments[\s\S]*WHERE order_id = \$2 AND workspace_owner_id = \$3/,
      ),
      ["2026-09-10T11:00:00.000Z", rescheduleOrderId, "owner_123"],
    );
    const eventCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO order_events"),
    );
    expect(eventCall).toBeTruthy();
    expect(String(eventCall?.[1]?.[2])).toContain("previous");
    expect(String(eventCall?.[1]?.[2])).toContain("next");
    expect(mockRecalcScheduleForOrder).toHaveBeenCalledOnce();
  });

  it("rejects a stale slot identity even when its old times still match", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({
        date: "2026-09-10",
        slot_id: "retired-slot",
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("slot_no_longer_available");
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders")),
    ).toBe(false);
  });

  it("returns overnight options using the market timezone", async () => {
    mockAvailableOptions(lockedOrder);
    mockDbQuery.mockReset();
    mockDbQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ...weeklySlot, id: "overnight", start_time: "23:00", end_time: "01:00" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], rowCount: 1 });

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2026-09-10" });

    expect(response.status).toBe(200);
    expect(response.body.slots[0]).toMatchObject({
      id: "overnight",
      window_start: "2026-09-10T20:00:00.000Z",
      window_end: "2026-09-10T22:00:00.000Z",
    });
  });

  it("discovers an eligible Express window after normalizing the stored delivery mode", async () => {
    const expressOrder = {
      ...lockedOrder,
      delivery_type: " Express ",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [expressOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      ;

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2099-01-02" });

    expect(response.status).toBe(200);
    expect(response.body.slots).toEqual([
      expect.objectContaining({
        id: "express",
        label: "Express",
        start_time: "14:00",
        end_time: "18:00",
      }),
    ]);
    expect(response.body.slots[0].capacity).toBeNull();
  });

  it("can list regular slots while rescheduling an Express order", async () => {
    mockAvailableOptions({
      ...lockedOrder,
      delivery_type: "express",
    });

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2026-09-10", delivery_type: "standard" });

    expect(response.status).toBe(200);
    expect(response.body.slots).toEqual([
      expect.objectContaining({
        id: "12",
        start_time: "14:00",
        end_time: "18:00",
      }),
    ]);
  });

  it("keeps the Express window available regardless of daily capacity", async () => {
    const expressOrder = {
      ...lockedOrder,
      delivery_type: "express",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [expressOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(makeApp())
      .get(`/orders/${rescheduleOrderId}/reschedule-options`)
      .query({ date: "2099-01-02" });

    expect(response.status).toBe(200);
    expect(response.body.slots).toEqual([
      expect.objectContaining({ id: "express", capacity: null }),
    ]);
  });

  it("revalidates and saves the same normalized Express slot", async () => {
    const expressOrder = {
      ...lockedOrder,
      delivery_type: " Express ",
    };
    mockClientQuery
      .mockResolvedValueOnce({ rows: [expressOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "job-1", event_id: "event-1" }], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({
        date: "2099-01-02",
        slot_id: "express",
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders")),
    ).toBe(true);
  });

  it("returns a safe error and logs context when transactional persistence fails", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 })
      .mockRejectedValueOnce(Object.assign(new Error("database detail"), { code: "23503" }));

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({
        date: "2026-09-10",
        slot_id: "12",
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      code: "reschedule_failed",
      error: "Could not reschedule delivery",
    });
    expect(mockRequestLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: rescheduleOrderId,
        workspaceOwnerId: "owner_123",
        requestedSlotId: "12",
      }),
      "Unexpected order reschedule failure",
    );
    expect(mockRecalcScheduleForOrder).not.toHaveBeenCalled();
  });

  it("reschedules through a cityName fallback when the stored cityId is stale", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{
          ...lockedOrder,
          delivery_address: { cityId: "retired-beirut", cityName: "Beirut" },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-09-10", slot_id: "12", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    expect(mockClientQuery.mock.calls[1]?.[1]).toEqual([
      "owner_123",
      "retired-beirut",
      "",
      "Beirut",
      "",
      "",
    ]);
    expect(String(mockClientQuery.mock.calls[1]?.[0])).toContain("WHEN dc.is_active");
  });

  it("saves the selected slot regardless of consumed capacity", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-09-10", slot_id: "12", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders")),
    ).toBe(true);
    expect(mockRecalcScheduleForOrder).toHaveBeenCalledOnce();
  });

  it.each(["out_for_delivery", "completed", "cancelled"])(
    "rejects %s orders before availability or writes",
    async (status) => {
      mockClientQuery.mockResolvedValueOnce({
        rows: [{ ...lockedOrder, status }],
        rowCount: 1,
      });

      const response = await request(makeApp())
        .post(`/orders/${rescheduleOrderId}/reschedule`)
        .send({ date: "2026-09-10", slot_id: "12", start_time: "14:00", end_time: "18:00" });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("order_not_reschedulable");
      expect(mockClientQuery).toHaveBeenCalledTimes(1);
    },
  );

  it("treats an identical retry as a no-op so side effects are not duplicated", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [lockedOrder], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [cityRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [weeklySlot], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: 0 }], rowCount: 1 });

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-09-09", slot_id: "12", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: false });
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE orders")),
    ).toBe(false);
    expect(mockRecalcScheduleForOrder).not.toHaveBeenCalled();
    expect(mockSendOrderRescheduledEmail).not.toHaveBeenCalled();
  });

  it("rejects users without Orders access", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];

    const response = await request(makeApp())
      .post(`/orders/${rescheduleOrderId}/reschedule`)
      .send({ date: "2026-09-10", slot_id: "12", start_time: "14:00", end_time: "18:00" });

    expect(response.status).toBe(403);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });
});

describe("effective reschedule slot identity", () => {
  const configuredSlot = {
    id: "12",
    label: "Night",
    start_time: "21:00",
    end_time: "23:00",
    capacity: 4,
    cutoff_time: "21:00",
    delivery_type: "standard",
    fee_override: null,
    same_day_available: true,
    next_day_available: true,
  };

  it("collapses byte-for-byte equivalent weekly repetitions", () => {
    expect(
      resolveEffectiveRescheduleSlots(
        [configuredSlot, { ...configuredSlot, id: "13" }],
        [],
        null,
      ),
    ).toEqual([configuredSlot]);
  });

  it("withholds a conflicting weekly identity rather than guessing a survivor", () => {
    expect(
      resolveEffectiveRescheduleSlots(
        [
          configuredSlot,
          {
            ...configuredSlot,
            id: "13",
            capacity: null,
            same_day_available: false,
          },
        ],
        [],
        null,
      ),
    ).toEqual([]);
  });

  it("gives an additive date override authority over a colliding weekly identity", () => {
    const morning = {
      ...configuredSlot,
      id: "11",
      label: "Morning",
      start_time: "09:00",
      end_time: "14:00",
    };
    const override = {
      ...configuredSlot,
      id: "override-5",
      label: "Holiday Night",
      capacity: 2,
    };

    expect(
      resolveEffectiveRescheduleSlots(
        [morning, configuredSlot],
        [override],
        "add_to_regular_schedule",
      ),
    ).toEqual([morning, override]);
  });

  it("keeps distinct delivery types and overnight windows separate", () => {
    const express = { ...configuredSlot, id: "express", delivery_type: "express" };
    const overnight = {
      ...configuredSlot,
      id: "14",
      start_time: "23:00",
      end_time: "01:00",
    };

    expect(
      resolveEffectiveRescheduleSlots(
        [configuredSlot, express, overnight],
        [],
        null,
      ),
    ).toEqual([configuredSlot, express, overnight]);
  });

  it("keeps intentionally supported partially overlapping windows separate", () => {
    const afternoon = {
      ...configuredSlot,
      id: "10",
      label: "Afternoon",
      start_time: "18:00",
      end_time: "22:00",
    };

    expect(
      resolveEffectiveRescheduleSlots([afternoon, configuredSlot], [], null),
    ).toEqual([afternoon, configuredSlot]);
  });
});

describe("reschedule slot resolution ordering", () => {
  const order = {
    id: "11111111-1111-1111-1111-111111111111",
    status: "processing",
    external_order_id: "PT-2049",
    delivery_type: "standard",
    delivery_address: { cityId: 7 },
    window_start: null,
    window_end: null,
    tookan_job_id: null,
  };
  const city = {
    id: 7,
    timezone: "UTC",
    is_active: true,
    standard_available: true,
    express_available: false,
    standard_capacity: null,
    express_capacity: null,
    standard_cutoff_time: null,
    express_enabled: false,
    express_start_time: null,
    express_end_time: null,
    express_cutoff_time: null,
    express_min_prep_minutes: null,
    express_daily_capacity: null,
    standard_globally_active: true,
    express_globally_active: true,
  };
  const night = {
    id: "12",
    label: "Night",
    start_time: "21:00",
    end_time: "23:00",
    capacity: null,
    cutoff_time: "21:00",
    delivery_type: "standard",
    fee_override: null,
    same_day_available: true,
    next_day_available: true,
  };

  function queryableWith(
    weekly: Array<typeof night>,
    activeOverride: { id: number; override_type: string } | null = null,
    overrideSlots: Array<typeof night> = [],
  ): RescheduleQueryable {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [city], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: activeOverride ? [activeOverride] : [],
        rowCount: activeOverride ? 1 : 0,
      })
      .mockResolvedValueOnce({ rows: weekly, rowCount: weekly.length });
    if (activeOverride) {
      query.mockResolvedValueOnce({
        rows: overrideSlots,
        rowCount: overrideSlots.length,
      });
    }
    return { query: query as unknown as RescheduleQueryable["query"] };
  }

  it.each([
    [
      "same-day",
      "2026-09-04",
      new Date("2026-09-04T12:00:00.000Z"),
      { same_day_available: false },
    ],
    [
      "next-day",
      "2026-09-05",
      new Date("2026-09-04T12:00:00.000Z"),
      { next_day_available: false },
    ],
    [
      "cutoff",
      "2026-09-04",
      new Date("2026-09-04T20:30:00.000Z"),
      { cutoff_time: "22:00" },
    ],
  ])(
    "does not let %s eligibility implicitly choose a conflicting weekly survivor",
    async (_label, date, now, conflictingAttributes) => {
      const context = await resolveRescheduleContext(
        queryableWith([
          night,
          { ...night, id: "13", ...conflictingAttributes },
        ]),
        "owner_123",
        order,
        date,
        { now },
      );

      expect(context.slots).toEqual([]);
    },
  );

  it("keeps a colliding additive override available for operational rescheduling", async () => {
    const context = await resolveRescheduleContext(
      queryableWith(
        [night],
        { id: 20, override_type: "add_to_regular_schedule" },
        [{
          ...night,
          id: "override-5",
          same_day_available: false,
        }],
      ),
      "owner_123",
      order,
      "2026-09-04",
      { now: new Date("2026-09-04T12:00:00.000Z") },
    );

    expect(context.slots).toEqual([
      expect.objectContaining({ id: "override-5", start_time: "21:00", end_time: "23:00" }),
    ]);
  });

  it("keeps Express available after its customer-booking cutoff", async () => {
    const expressCity = {
      ...city,
      timezone: "Asia/Beirut",
      express_available: true,
      express_enabled: true,
      express_start_time: "14:00",
      express_end_time: "18:00",
      express_cutoff_time: "15:00",
      express_min_prep_minutes: 0,
      express_daily_capacity: 3,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [expressCity], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const context = await resolveRescheduleContext(
      { query: query as unknown as RescheduleQueryable["query"] },
      "owner_123",
      { ...order, delivery_type: "express" },
      "2026-09-04",
      { now: new Date("2026-09-04T12:01:00.000Z") },
    );

    expect(context.slots).toEqual([
      expect.objectContaining({ id: "express", start_time: "14:00", end_time: "18:00" }),
    ]);
  });

  it("keeps Express available regardless of customer preparation-time rules", async () => {
    const expressCity = {
      ...city,
      timezone: "Asia/Beirut",
      express_available: true,
      express_enabled: true,
      express_start_time: "14:00",
      express_end_time: "18:00",
      express_cutoff_time: null,
      express_min_prep_minutes: 60,
      express_daily_capacity: 3,
    };
    const makeQueryable = (): RescheduleQueryable => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [expressCity], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return { query: query as unknown as RescheduleQueryable["query"] };
    };

    const tooLate = await resolveRescheduleContext(
      makeQueryable(),
      "owner_123",
      { ...order, delivery_type: "express" },
      "2026-09-04",
      { now: new Date("2026-09-04T10:30:00.000Z") },
    );
    const boundary = await resolveRescheduleContext(
      makeQueryable(),
      "owner_123",
      { ...order, delivery_type: "express" },
      "2026-09-04",
      { now: new Date("2026-09-04T10:00:00.000Z") },
    );

    expect(tooLate.slots).toEqual([
      expect.objectContaining({ id: "express", start_time: "14:00", end_time: "18:00" }),
    ]);
    expect(boundary.slots).toEqual([
      expect.objectContaining({ id: "express", start_time: "14:00", end_time: "18:00" }),
    ]);
  });
});

const { mockRefundsCreate, MockStripeError, mockStripeConstructor } = vi.hoisted(() => {
  class MockStripeError extends Error {}
  return {
    mockRefundsCreate: vi.fn(),
    MockStripeError,
    mockStripeConstructor: vi.fn(),
  };
});

vi.mock("stripe", () => {
  class StripeMock {
    refunds = { create: (...args: unknown[]) => mockRefundsCreate(...args) };
    static errors = { StripeError: MockStripeError };
    constructor(...args: unknown[]) {
      mockStripeConstructor(...args);
    }
  }
  return { default: StripeMock };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubAllowedPages: string[] | null = null;
let stubMemberDbId: number | null = 71;
let stubUserId = "user_editor_1";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.allowedPages = stubAllowedPages;
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = stubUserId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
}));

const mockFireWebhookEvent = vi.fn();

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: (...args: unknown[]) => mockFireWebhookEvent(...args),
}));

const mockSendOrderStatusEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOrderRefundEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOrderPaymentReceivedEmail = vi.fn().mockResolvedValue(undefined);
const mockSendOrderRescheduledEmail = vi.fn().mockResolvedValue({
  sent: true,
  skipped: false,
  messageId: "message-1",
  errorMessage: null,
  subject: "Delivery rescheduled",
});

vi.mock("../lib/email", () => ({
  sendOrderStatusEmail: (...args: unknown[]) => mockSendOrderStatusEmail(...args),
  sendOrderRefundEmail: (...args: unknown[]) => mockSendOrderRefundEmail(...args),
  sendOrderPaymentReceivedEmail: (...args: unknown[]) =>
    mockSendOrderPaymentReceivedEmail(...args),
  sendOrderRescheduledEmail: (...args: unknown[]) => mockSendOrderRescheduledEmail(...args),
  ORDER_STATUS_EMAIL_STATUSES: new Set([
    "processing",
    "ready_for_delivery",
    "out_for_delivery",
    "completed",
  ]),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockClerkGetUser = vi.fn().mockResolvedValue({
  firstName: "Test",
  lastName: "Editor",
  primaryEmailAddress: { emailAddress: "editor@example.com" },
});

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUser: (...args: unknown[]) => mockClerkGetUser(...args) } },
}));

const mockIsTookanEnabled = vi.fn();
const mockRetryTookanDeliveryTask = vi.fn();
const mockBackfillTookanDeliveryTasks = vi.fn();
const mockSyncTookanDestinationForOrder = vi.fn().mockResolvedValue("skipped");
const mockSyncTookanDestinationWithClient = vi.fn().mockResolvedValue("skipped");
const mockTookanDestinationsEqual = vi.fn().mockReturnValue(true);

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: (...args: unknown[]) => mockIsTookanEnabled(...args),
  retryTookanDeliveryTask: (...args: unknown[]) => mockRetryTookanDeliveryTask(...args),
  backfillTookanDeliveryTasks: (...args: unknown[]) => mockBackfillTookanDeliveryTasks(...args),
  syncTookanDestinationForOrder: (...args: unknown[]) => mockSyncTookanDestinationForOrder(...args),
  syncTookanDestinationWithClient: (...args: unknown[]) =>
    mockSyncTookanDestinationWithClient(...args),
  tookanDestinationsEqual: (...args: unknown[]) => mockTookanDestinationsEqual(...args),
  editTookanDeliveryTask: vi.fn(),
  TOOKAN_MISSING_ADDRESS_ERROR: "Delivery address missing — add an address and retry",
}));

const mockTransitionOrderStatus = vi.fn().mockResolvedValue({ success: true });

vi.mock("../lib/orderStatusTransition", () => ({
  transitionOrderStatus: (...args: unknown[]) => mockTransitionOrderStatus(...args),
}));

const mockIsTrustpilotEnabled = vi.fn().mockReturnValue(false);
const mockIsTrustpilotTestMode = vi.fn().mockReturnValue(false);

vi.mock("../lib/trustpilot", () => ({
  isTrustpilotEnabled: (...args: unknown[]) => mockIsTrustpilotEnabled(...args),
  isTrustpilotTestMode: (...args: unknown[]) => mockIsTrustpilotTestMode(...args),
}));

const mockMaybeEnqueueTrustpilotInvitation = vi.fn().mockResolvedValue("enqueued");
const mockProcessTrustpilotInvitation = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/trustpilotInvitations", () => ({
  maybeEnqueueTrustpilotInvitation: (...args: unknown[]) =>
    mockMaybeEnqueueTrustpilotInvitation(...args),
  processTrustpilotInvitation: (...args: unknown[]) =>
    mockProcessTrustpilotInvitation(...args),
}));

const mockCreateManualOrder = vi.fn();
vi.mock("../lib/orderCreate", () => ({
  createManualOrder: (...args: unknown[]) => mockCreateManualOrder(...args),
  ContactNotFoundError: class ContactNotFoundError extends Error {
    constructor(role: string) {
      super(`Selected ${role} contact was not found in this workspace`);
      this.name = "ContactNotFoundError";
    }
  },
}));

import ordersRouter, {
  lookupWorkspaceStaffEmails,
  lookupOrderEmailDetails,
  resolveEffectiveRescheduleSlots,
  resolveRescheduleContext,
  type RescheduleQueryable,
} from "./orders";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: (...args: unknown[]) => mockRequestLogError(...args),
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(ordersRouter);
  return app;
}

const ORDER_ID = "11111111-1111-1111-1111-111111111111";

describe("order read permission", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("rejects members without orders access before querying", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["customers"];

    const res = await request(app).get("/orders");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows the orders permission and preserves owner access", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    expect((await request(app).get(`/orders/${ORDER_ID}`)).status).toBe(404);

    stubActualRole = "owner";
    stubAllowedPages = null;
    expect((await request(app).get(`/orders/${ORDER_ID}`)).status).toBe(404);
  });
});

describe("POST /orders/:id/card-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("persists a workspace-scoped additional card message", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: "card-2",
        card_to: "Maya",
        card_message: "A second note",
        card_from: "Omar",
        qr_link: "https://example.com/card",
        created_at: "2026-09-08T10:00:00.000Z",
      }],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/card-messages`)
      .send({
        card_to: "Maya",
        card_message: "A second note",
        card_from: "Omar",
        qr_link: "https://example.com/card",
      });

    expect(res.status).toBe(201);
    expect(res.body.card_message).toMatchObject({ id: "card-2", card_message: "A second note" });
    expect(mockDbQuery.mock.calls[0]?.[0]).toContain("INSERT INTO order_card_messages");
    expect(mockDbQuery.mock.calls[0]?.[0]).toContain(
      "WHERE o.id = $1 AND o.workspace_owner_id = $2",
    );
    expect(mockDbQuery.mock.calls[0]?.[1]).toEqual([
      ORDER_ID,
      "owner_123",
      "Maya",
      "A second note",
      "Omar",
      "https://example.com/card",
      expect.anything(),
    ]);
  });

  it.each([
    [{ card_message: "" }, /at least 1/i],
    [{ card_message: "hello", qr_link: "javascript:alert(1)" }, /http/i],
    [{ card_message: "hello", card_to: "x".repeat(301) }, /at most 300/i],
  ])("rejects invalid card input", async (payload, errorPattern) => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/card-messages`)
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(errorPattern);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects callers without Orders access", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/card-messages`)
      .send({ card_message: "Not allowed" });
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns not found when the order does not belong to the workspace", async () => {
    const res = await request(makeApp())
      .post(`/orders/${ORDER_ID}/card-messages`)
      .send({ card_message: "Cross workspace" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Order not found");
  });

  it("rejects malformed order IDs before querying", async () => {
    const res = await request(makeApp())
      .post("/orders/not-a-uuid/card-messages")
      .send({ card_message: "Hello" });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

function existingRow(
  status = "pending",
  paymentStatus: string | null = "paid",
  tookan: { job_id?: string | null; status?: string | null; error?: string | null } = {},
  deliveryAddress: Record<string, unknown> | null = null,
) {
  return {
    rows: [
      {
        id: ORDER_ID,
        status,
        external_order_id: "ext-1",
        tookan_job_id: tookan.job_id ?? null,
        tookan_status: tookan.status ?? null,
        tookan_error: tookan.error ?? null,
        payment_status: paymentStatus,
        delivery_address: deliveryAddress,
      },
    ],
    rowCount: 1,
  };
}

function updatedRow(status = "processing") {
  return {
    rows: [{ id: ORDER_ID, status, customer_note: null, florist_note: null, driver_note: null, internal_note: null }],
    rowCount: 1,
  };
}

// ---------------------------------------------------------------------------
// lookupWorkspaceStaffEmails — staff new-order email recipients
// ---------------------------------------------------------------------------

describe("lookupWorkspaceStaffEmails", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("excludes members who opted out of new-order emails", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ member_email: "owner@biz.com" }],
      rowCount: 1,
    });

    const emails = await lookupWorkspaceStaffEmails("owner_123");

    expect(emails).toEqual(["owner@biz.com"]);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("notify_email_on_new_order = true");
    expect(params).toEqual(["owner_123"]);
  });

  it("returns [] on query failure (best-effort)", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(lookupWorkspaceStaffEmails("owner_123")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /orders — list filters
// ---------------------------------------------------------------------------

describe("GET /orders — delivery date filter", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    // main list query (empty), then count query
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("does not add a delivery-date condition when no dates are supplied", async () => {
    const res = await request(makeApp()).get("/orders");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/AT TIME ZONE/);
    // only workspace owner + limit + offset
    expect(params).toEqual(["owner_123", 50, 0]);
  });

  it("returns the entitled workspace's orders for a member with Orders page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders", "cash-sessions"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const res = await request(makeApp()).get("/orders");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, orders: [], total: 0 });
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123", 50, 0]);
  });

  it("adds a date[] ANY condition with the supplied tz and resets to the given page", async () => {
    const res = await request(makeApp()).get(
      "/orders?deliveryDates=2026-06-22,2026-06-23&tz=Asia/Beirut&offset=0",
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("COALESCE(o.window_start, o.window_end)");
    expect(sql).toContain("AT TIME ZONE COALESCE(dctz.timezone, $2)");
    expect(sql).toContain("o.raw_payload#>>'{delivery,date}'");
    expect(params[1]).toBe("Asia/Beirut");
    expect(params[2]).toEqual(["2026-06-22", "2026-06-23"]);

    // count query reuses the tz + dates params (limit/offset sliced off)
    const [, countParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(countParams).toEqual(["owner_123", "Asia/Beirut", ["2026-06-22", "2026-06-23"]]);
  });

  it("filters and counts Today matches before pagination using market-local canonical and valid legacy schedules", async () => {
    const pageOrder = {
      id: "today-match-after-first-page",
      status: "processing",
      window_start: "2026-06-22T07:00:00.000Z",
      window_end: "2026-06-22T10:00:00.000Z",
    };
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT COUNT(*) AS total")) {
        return Promise.resolve({ rows: [{ total: "53" }], rowCount: 1 });
      }
      if (sql.includes("FROM orders o")) {
        return Promise.resolve({ rows: [pageOrder], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get(
      "/orders?today=true&status=processing&limit=50&offset=50",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      orders: [expect.objectContaining({ id: pageOrder.id })],
      total: 53,
      limit: 50,
      offset: 50,
    });

    const [listSql, listParams] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const [countSql, countParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(listSql).toContain("o.status = $2");
    expect(listSql).toContain("AT TIME ZONE COALESCE(dctz.timezone, 'UTC')");
    expect(listSql).toContain("retained_schedule.delivery_date IS NOT NULL");
    expect(listSql).toContain("candidate.date_text ~ '^\\d{4}-\\d{2}-\\d{2}'");
    expect(listSql).toContain("candidate.slot_text ~*");
    expect(listSql).toContain("now() AT TIME ZONE COALESCE(dctz.timezone, 'UTC')");
    expect(listSql).toContain(
      "END <= (now() AT TIME ZONE COALESCE(dctz.timezone, 'UTC'))::date",
    );
    expect(listSql).toContain(
      "o.status IN ('completed','delivered','cancelled','refunded')",
    );
    expect(listSql).toContain(
      "AND NOT (o.status IN ('completed','delivered','cancelled','refunded') AND CASE",
    );
    expect(listSql).toContain(
      "END < (now() AT TIME ZONE COALESCE(dctz.timezone, 'UTC'))::date",
    );
    expect(listSql).toContain("ELSE NULL END");
    expect(listSql.indexOf("WHERE")).toBeLessThan(listSql.indexOf("LIMIT"));
    expect(listParams).toEqual(["owner_123", "processing", 50, 50]);

    // The count query uses the identical schedule, timezone, and status filter,
    // but excludes pagination parameters so total describes the complete set.
    expect(countSql).toContain("AT TIME ZONE COALESCE(dctz.timezone, 'UTC')");
    expect(countSql).toContain("retained_schedule.delivery_date IS NOT NULL");
    expect(countSql).toContain("AND NOT (o.status IN");
    expect(countParams).toEqual(["owner_123", "processing"]);
  });

  it("ignores malformed dates and falls back to UTC for an invalid tz", async () => {
    const res = await request(makeApp()).get(
      "/orders?deliveryDates=2026-06-22,nope,06/23&tz=Not/AZone",
    );
    expect(res.status).toBe(200);
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe("UTC");
    expect(params[2]).toEqual(["2026-06-22"]);
  });

  it("adds no delivery-date condition when all supplied dates are malformed", async () => {
    const res = await request(makeApp()).get("/orders?deliveryDates=nope,06/23");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/AT TIME ZONE/);
    expect(params).toEqual(["owner_123", 50, 0]);
  });

  it("projects an unambiguous retained LB-style schedule and uses it for filtering", async () => {
    const res = await request(makeApp()).get(
      "/orders?deliveryDates=2026-06-22&slots=" + encodeURIComponent("2:00 PM - 5:00 PM"),
    );
    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("o.raw_payload->>'deliveryDate'");
    expect(sql).toContain("o.raw_payload->>'deliverySlot'");
    expect(sql).toContain("jsonb_set(COALESCE(o.delivery_address, '{}'::jsonb)");
    expect(sql).toContain("candidate.slot_text ~* '^(morning|afternoon|evening|night|express)$'");
    expect(sql).toContain("AND retained_schedule.slot_text ~* '^express$'");
    expect(sql).toContain("AND o.raw_payload#>>'{delivery,isExpress}' IS NULL");
    expect(sql).toContain("THEN 'express'");
    expect(sql).not.toContain("o.ordered_at AT TIME ZONE");
  });

  it("returns the recovered date and slot in the delivery_address consumed by the Orders cell", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT COUNT(*) AS total")) {
        return Promise.resolve({ rows: [{ total: "1" }], rowCount: 1 });
      }
      if (sql.includes("FROM order_line_items")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({
        rows: [{
          id: "11111111-1111-1111-1111-111111111111",
          delivery_address: {
            date: "2026-06-22",
            slot: "2:00 PM - 5:00 PM",
          },
          delivery_timezone: "Asia/Beirut",
        }],
        rowCount: 1,
      });
    });

    const res = await request(makeApp()).get("/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders[0]).toMatchObject({
      delivery_address: {
        date: "2026-06-22",
        slot: "2:00 PM - 5:00 PM",
      },
      delivery_timezone: "Asia/Beirut",
    });
  });
});

describe("GET /orders — country filter", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    // main list query (empty), then count query
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("adds no country condition when the param is absent", async () => {
    const res = await request(makeApp()).get("/orders");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/countryCode/);
    // only workspace owner id + limit + offset
    expect(params).toEqual(["owner_123", 50, 0]);
  });

  it("adds a condition matching countryCode AND country name for a known code (lb)", async () => {
    const res = await request(makeApp()).get("/orders?country=lb");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // Must match by ISO code
    expect(sql).toMatch(/delivery_address->>'countryCode'/);
    // Must also match by full country name
    expect(sql).toMatch(/delivery_address->>'country'/);
    expect(params).toContain("lb");
    expect(params).toContain("lebanon");
  });

  it("adds a condition matching countryCode AND country name for ae", async () => {
    const res = await request(makeApp()).get("/orders?country=ae");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/delivery_address->>'countryCode'/);
    expect(sql).toMatch(/delivery_address->>'country'/);
    expect(params).toContain("ae");
    expect(params).toContain("united arab emirates");
  });

  it("adds a condition matching countryCode AND country name for cy", async () => {
    const res = await request(makeApp()).get("/orders?country=cy");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("cy");
    expect(params).toContain("cyprus");
  });

  it("the count query reuses the country params (limit/offset sliced off)", async () => {
    await request(makeApp()).get("/orders?country=lb");
    const [, countParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(countParams).toEqual(["owner_123", "lb", "lebanon"]);
  });

  it("combines correctly with status filter (country params use subsequent placeholders)", async () => {
    const res = await request(makeApp()).get("/orders?status=pending&country=ae");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    // status binds $2, country code binds $3, country name binds $4
    expect(params[1]).toBe("pending");
    expect(params[2]).toBe("ae");
    expect(params[3]).toBe("united arab emirates");
    expect(sql).toMatch(/\$3/);
    expect(sql).toMatch(/\$4/);
  });

  it("falls back to code-only match for an unknown ISO code", async () => {
    const res = await request(makeApp()).get("/orders?country=xx");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain("xx");
    // No name lookup possible — only countryCode matched
    expect(sql).toMatch(/delivery_address->>'countryCode'/);
    expect(sql).not.toMatch(/delivery_address->>'country'/);
  });
});

describe("GET /orders — workshop and punctuality fields", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("joins order_florist_assignments/locations and resolves delivered_at + timezone", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM orders o") && sql.includes("LEFT JOIN order_payment")) {
        return Promise.resolve({
          rows: [{
            id: "order-1",
            workshop: { location_id: 7, location_name: "Downtown Workshop", status: "in_progress" },
            delivered_at: "2026-08-24T10:00:00.000Z",
            delivery_timezone: "Asia/Beirut",
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT COUNT(*) AS total")) {
        return Promise.resolve({ rows: [{ total: "1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get("/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders[0]).toEqual(
      expect.objectContaining({
        workshop: { location_id: 7, location_name: "Downtown Workshop", status: "in_progress" },
        delivered_at: "2026-08-24T10:00:00.000Z",
        delivery_timezone: "Asia/Beirut",
      }),
    );

    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LEFT JOIN order_florist_assignments ofa ON ofa.order_id = o.id");
    expect(sql).toContain("LEFT JOIN locations loc ON loc.id = ofa.location_id");
    expect(sql).toContain("COALESCE(a.delivered_at, o.tookan_delivered_at) AS delivered_at");
    expect(sql).toContain("to_jsonb(dc)->>'delivery_timezone'");
    expect(sql).not.toMatch(/\bdc\.delivery_timezone\b/);
  });

  it("returns workshop: null when no florist assignment exists", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM orders o") && sql.includes("LEFT JOIN order_payment")) {
        return Promise.resolve({
          rows: [{
            id: "order-2",
            workshop: null,
            delivered_at: null,
            delivery_timezone: "UTC",
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT COUNT(*) AS total")) {
        return Promise.resolve({ rows: [{ total: "1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get("/orders");
    expect(res.status).toBe(200);
    expect(res.body.orders[0].workshop).toBeNull();
    expect(res.body.orders[0].delivered_at).toBeNull();
    expect(res.body.orders[0].delivery_timezone).toBe("UTC");
  });
});

describe("GET /orders — time slot filter", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("adds no slot condition when the slots param is absent or blank", async () => {
    const res = await request(makeApp()).get("/orders?slots=,%20,");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toMatch(/= ANY\(\$\d+::text\[\]\)/);
    expect(params).toEqual(["owner_123", 50, 0]);
  });

  it("filters by trimmed slot labels via a text[] ANY condition", async () => {
    const res = await request(makeApp()).get(
      "/orders?slots=" + encodeURIComponent("9:00 AM – 12:00 PM, 2:00 PM – 5:00 PM "),
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/to_char\(o\.window_start AT TIME ZONE COALESCE\(dctz\.timezone, 'UTC'\), 'HH24:MI'\)/);
    expect(sql).toMatch(/= ANY\(\$2::text\[\]\)/);
    expect(params[1]).toEqual(["9:00 AM – 12:00 PM", "2:00 PM – 5:00 PM"]);

    // count query reuses the slot param (limit/offset sliced off)
    const [, countParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(countParams).toEqual(["owner_123", ["9:00 AM – 12:00 PM", "2:00 PM – 5:00 PM"]]);
  });

  it("combines with the delivery-date filter using subsequent placeholders", async () => {
    const res = await request(makeApp()).get(
      "/orders?deliveryDates=2026-06-22&tz=Asia/Beirut&slots=" +
        encodeURIComponent("9:00 AM – 12:00 PM"),
    );
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/= ANY\(\$3::date\[\]\)/);
    expect(sql).toMatch(/to_char\(o\.window_start AT TIME ZONE COALESCE\(dctz\.timezone, 'UTC'\), 'HH24:MI'\)/);
    expect(params[3]).toEqual(["9:00 AM – 12:00 PM"]);
  });
});

describe("GET /orders/delivery-slots", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns the workspace's distinct non-empty slots", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ slot: "9:00 AM – 12:00 PM" }, { slot: "2:00 PM – 5:00 PM" }],
      rowCount: 2,
    });
    const res = await request(makeApp()).get("/orders/delivery-slots");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slots: ["9:00 AM – 12:00 PM", "2:00 PM – 5:00 PM"] });
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "to_char(o.window_start AT TIME ZONE COALESCE(dctz.timezone, 'UTC'), 'HH24:MI')",
    );
    expect(sql).toContain("workspace_owner_id = $1");
    expect(sql).toContain("o.raw_payload->>'deliverySlot'");
    expect(sql).toContain("o.raw_payload#>>'{delivery_address,timeSlot}'");
    expect(params).toEqual(["owner_123"]);
  });

  it("ranks complete schedule pairs so malformed stored metadata cannot block retained raw data", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ slot: "2:00 PM - 5:00 PM" }],
      rowCount: 1,
    });

    const res = await request(makeApp()).get("/orders/delivery-slots");
    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    const storedPair = sql.indexOf("o.delivery_address->>'date'");
    const rawPair = sql.indexOf("o.raw_payload#>>'{delivery,date}'");
    expect(storedPair).toBeGreaterThan(-1);
    expect(rawPair).toBeGreaterThan(storedPair);
    expect(sql).toContain("ORDER BY candidate.priority");
  });
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id/status — paid-before-processing guard
// ---------------------------------------------------------------------------

describe("PATCH /orders/:id/status", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockTransitionOrderStatus.mockResolvedValue({ success: true });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 409 when advancing an unpaid order to processing", async () => {
    mockDbQuery.mockResolvedValueOnce(existingRow("pending", null)); // lookup — no payment row

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "processing" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("payment_not_paid");
    expect(res.body.error).toMatch(/marked as paid/i);
    // Only the lookup ran — the UPDATE was never issued.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when the payment status is pending (not paid)", async () => {
    mockDbQuery.mockResolvedValueOnce(existingRow("pending", "pending"));

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "processing" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("payment_not_paid");
  });

  it("still blocks Processing when the payment status is refunded", async () => {
    mockDbQuery.mockResolvedValueOnce(existingRow("pending", "refunded"));

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "processing" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("payment_not_paid");
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("allows advancing a paid order to processing", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending", "paid")) // lookup
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "processing" }],
        rowCount: 1,
      }); // UPDATE orders

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "processing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order.status).toBe("processing");
    expect(mockFireWebhookEvent).toHaveBeenCalledWith(
      "order.status_updated",
      "owner_123",
      expect.objectContaining({ status: "processing" }),
    );
  });

  it("does not gate later transitions on an unpaid order already in processing", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("processing", null)) // lookup
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "ready_for_delivery" }],
        rowCount: 1,
      }); // UPDATE orders

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "ready_for_delivery" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Backward/skip transitions are owner-only, enforced server-side (the
  // Orders board's drag-and-drop is the first UI path that can attempt one;
  // this guard holds regardless of which client — or a direct API call —
  // issues the request).
  // -------------------------------------------------------------------------

  it("returns 403 when a non-owner member tries to move an order backward", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce(existingRow("out_for_delivery", "paid")); // lookup

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "preparing" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("elevated_transition_forbidden");
    // Only the lookup ran — no UPDATE / transition was attempted.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-owner member tries to skip a stage forward", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce(existingRow("processing", "paid")); // lookup

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "out_for_delivery" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("elevated_transition_forbidden");
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });

  it("allows the owner to move an order backward", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("out_for_delivery", "paid")) // lookup
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "preparing" }],
        rowCount: 1,
      }); // UPDATE orders

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("does not restrict a non-owner member's plain single-step forward move", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce(existingRow("processing", "paid")) // lookup
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "preparing" }],
        rowCount: 1,
      }); // UPDATE orders

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it.each(["owner", "admin"])("%s can change a refunded order to any valid status", async (role) => {
    stubActualRole = role;
    mockDbQuery
      .mockResolvedValueOnce(existingRow("refunded", "partially_refunded"))
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "completed" }],
        rowCount: 1,
      });
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "refunded",
      previousPaymentStatus: "partially_refunded",
      newStatus: "completed",
    });

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("completed");
    expect(mockTransitionOrderStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: ORDER_ID,
        newStatus: "completed",
        restoreRefundedPayment: true,
        allowedFromStatuses: ["refunded"],
      }),
    );
  });

  it("lets an Ops 2 member change refunded status even without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ role_id: 8 }], rowCount: 1 }) // Ops 2 membership
      .mockResolvedValueOnce(existingRow("refunded", "refunded"))
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "preparing" }],
        rowCount: 1,
      });
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "refunded",
      previousPaymentStatus: "refunded",
      newStatus: "preparing",
    });

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("preparing");
    expect(mockTransitionOrderStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        restoreRefundedPayment: true,
        allowedFromStatuses: ["refunded"],
      }),
    );
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("wr.name = 'Ops 2'"),
      [71, "owner_123", "user_editor_1"],
    );
  });

  it("rejects a regular Orders-page member changing status from refunded", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce(existingRow("refunded", "refunded"))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no Ops 2 role

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/status`)
      .send({ status: "preparing" });

    expect(res.status).toBe(403);
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id
// ---------------------------------------------------------------------------

describe("PATCH /orders/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockTransitionOrderStatus.mockResolvedValue({ success: true });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 403 for a member without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows a member whose role grants Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce(updatedRow("processing")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("marks payment paid when an authorized user changes a refunded order through the edit route", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("refunded", "refunded")) // existing lookup
      .mockResolvedValueOnce(updatedRow("refunded")); // response snapshot before transition
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "refunded",
      previousPaymentStatus: "refunded",
      newStatus: "preparing",
    });

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "preparing" });

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("preparing");
    expect(mockTransitionOrderStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        newStatus: "preparing",
        restoreRefundedPayment: true,
        allowedFromStatuses: ["refunded"],
      }),
    );
  });

  it("rejects a regular Orders-page member changing a refunded order through the edit route", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce(existingRow("refunded", "refunded"))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no Ops 2 role

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "preparing" });

    expect(res.status).toBe(403);
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid status value", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "not_a_real_status" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when window_end is before window_start", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({
        window_start: "2026-06-16T12:00:00Z",
        window_end: "2026-06-16T10:00:00Z",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown field (strict schema)", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ totally_unknown_field: "x" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when no fields are provided", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/No fields/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the order is not in this workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // existing lookup

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when moving an unpaid order to processing", async () => {
    mockDbQuery.mockResolvedValueOnce(existingRow("pending", null)); // existing lookup — no payment row

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("payment_not_paid");
    // Only the lookup ran — no UPDATE was issued.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when the payment status is pending (not paid)", async () => {
    mockDbQuery.mockResolvedValueOnce(existingRow("pending", "pending"));

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("payment_not_paid");
  });

  it("allows moving a paid order to processing", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending", "paid")) // existing lookup
      .mockResolvedValueOnce(updatedRow("processing")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order.status).toBe("processing");
  });

  it("does not gate an unpaid order already in processing (or later transitions)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("processing", null)) // existing lookup
      .mockResolvedValueOnce(updatedRow("ready_for_delivery")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "ready_for_delivery" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("updates status, fires the webhook, and emails the customer when the status changes", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce(updatedRow("processing")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order.status).toBe("processing");

    expect(mockTransitionOrderStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: ORDER_ID, newStatus: "processing" }),
    );

    expect(mockFireWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockFireWebhookEvent).toHaveBeenCalledWith(
      "order.status_updated",
      "owner_123",
      expect.objectContaining({ orderId: ORDER_ID, status: "processing" }),
    );
  });

  it("does not fire the webhook or email when the status is unchanged", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("processing")) // existing lookup
      .mockResolvedValueOnce(updatedRow("processing")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ status: "processing" });

    expect(res.status).toBe(200);
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
    expect(mockSendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it("auto-retries Tookan when an address is saved on an order that failed for missing address", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockRetryTookanDeliveryTask.mockResolvedValue(undefined);
    mockDbQuery
      .mockResolvedValueOnce(
        existingRow("pending", "paid", {
          job_id: null,
          status: "failed",
          error: "Delivery address missing — add an address and retry",
        }),
      ) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ delivery_address: { address: "Hamra Street, Beirut" } });

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).toHaveBeenCalledWith(ORDER_ID, "owner_123");
  });

  it("does not auto-retry Tookan on address save when the failure was not missing-address", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery
      .mockResolvedValueOnce(
        existingRow("pending", "paid", {
          job_id: null,
          status: "failed",
          error: "Tookan API error: HTTP 502",
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ delivery_address: { address: "Hamra Street, Beirut" } });

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).not.toHaveBeenCalled();
  });

  it("does not auto-retry Tookan when the order already has a Tookan task", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery
      .mockResolvedValueOnce(
        existingRow("pending", "paid", {
          job_id: "job-1",
          status: "created",
          error: null,
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ delivery_address: { address: "Hamra Street, Beirut" } });

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).not.toHaveBeenCalled();
  });

  it("upserts order_notes when note fields are provided and skips the webhook with no status change", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT order_notes
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ customer_note: "Leave at the door", internal_note: "VIP" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const notesCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO order_notes/i.test(sql),
    );
    expect(notesCall).toBeDefined();
    expect(notesCall![0]).toMatch(/ON CONFLICT \(order_id\)/i);
    expect(notesCall![1]).toContain("Leave at the door");

    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("accepts and persists card_to, card_message, and card_from", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({
        card_to: "Sara",
        card_message: "Happy birthday!",
        card_from: "Omar",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatch(/card_to = \$\d+/i);
    expect(updateCall![0]).toMatch(/card_message = \$\d+/i);
    expect(updateCall![0]).toMatch(/card_from = \$\d+/i);
    expect(updateCall![1]).toContain("Sara");
    expect(updateCall![1]).toContain("Happy birthday!");
    expect(updateCall![1]).toContain("Omar");

    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("clears card fields when null is sent", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ card_to: null, card_message: null, card_from: null });

    expect(res.status).toBe(200);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![1].slice(0, 3)).toEqual([null, null, null]);
  });

  it("accepts and persists a valid http(s) qr_link", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ qr_link: "https://example.com/gift/abc" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatch(/qr_link = \$\d+/i);
    expect(updateCall![1]).toContain("https://example.com/gift/abc");
  });

  it("clears qr_link when null or an empty string is sent", async () => {
    for (const value of [null, "", "   "]) {
      vi.clearAllMocks();
      mockDbQuery
        .mockResolvedValueOnce(existingRow("pending")) // existing lookup
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
        .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

      const res = await request(app)
        .patch(`/orders/${ORDER_ID}`)
        .send({ qr_link: value });

      expect(res.status).toBe(200);

      const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) =>
        /UPDATE orders/i.test(sql),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toMatch(/qr_link = \$\d+/i);
      expect(updateCall![1][0]).toBeNull();
    }
  });

  it("returns 400 for a non-URL or non-http(s) qr_link", async () => {
    for (const bad of ["not a url", "ftp://example.com/x", "javascript:alert(1)"]) {
      vi.clearAllMocks();
      mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      const res = await request(app)
        .patch(`/orders/${ORDER_ID}`)
        .send({ qr_link: bad });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/qr_link/i);
      expect(mockDbQuery).not.toHaveBeenCalled();
    }
  });

  it("returns 400 when card_to exceeds the max length", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ card_to: "x".repeat(301) });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when card_message exceeds the max length", async () => {
    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ card_message: "x".repeat(5001) });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("serializes delivery_address as jsonb in the UPDATE", async () => {
    mockDbQuery
      .mockResolvedValueOnce(existingRow("pending")) // existing lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE orders
      .mockResolvedValueOnce(updatedRow("pending")); // final SELECT

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({ delivery_address: { city: "Beirut", address_1: "Main St" } });

    expect(res.status).toBe(200);

    const updateCall = mockDbQuery.mock.calls.find(([sql]: [string]) => /UPDATE orders/i.test(sql));
    expect(updateCall).toBeDefined();
    expect(updateCall![0]).toMatch(/delivery_address = \$\d+::jsonb/i);
    expect(updateCall![1]).toContain(JSON.stringify({ city: "Beirut", address_1: "Main St" }));
  });

  it("syncs an edited destination best-effort without changing the successful OS response", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockTookanDestinationsEqual.mockReturnValueOnce(false);
    mockSyncTookanDestinationForOrder.mockRejectedValueOnce(new Error("Tookan unavailable"));
    mockDbQuery
      .mockResolvedValueOnce(
        existingRow("pending", "paid", { job_id: "job-1", status: "created" }, {
          address: "Old Street",
          latitude: 33.88,
          longitude: 35.49,
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce(updatedRow("pending"));

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}`)
      .send({
        delivery_address: {
          address_1: "New Street",
          lat: "33.90",
          lng: "35.51",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSyncTookanDestinationForOrder).toHaveBeenCalledWith(ORDER_ID, "owner_123");
  });
});

// ---------------------------------------------------------------------------
// GET /orders/:id — resolves a product image per line item
//
// Ordered db.query sequence for this route:
//   1. order lookup (orders + payment + notes)
//   2. line items
//   3. product image lookup (only when ≥1 line item has no image and carries a
//      product_id or sku)
//   4. contacts
//   5. assignment
// ---------------------------------------------------------------------------

describe("GET /orders/:id — retained delivery schedule", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("uses the same atomic retained-pair projection as the Orders list", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: ORDER_ID,
        raw_payload: {
          deliveryDate: "2026-06-22",
          deliverySlot: "2:00 PM - 5:00 PM",
        },
        delivery_address: { date: "invalid", slot: "" },
      }],
      rowCount: 1,
    });

    const res = await request(makeApp()).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    const [sql] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("retained_schedule.delivery_date IS NOT NULL");
    expect(sql).toContain("o.raw_payload->>'deliveryDate'");
    expect(sql).toContain("END AS delivery_address");
  });
});

describe("GET /orders/:id — line item product images", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("populates image_url for line items matched to a product (by id and by sku), leaving unmatched items empty", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: "pending" }], rowCount: 1 }) // order
      .mockResolvedValueOnce({
        rows: [
          { id: "li-1", name: "Roses", sku: "ROSE-1", product_id: 10, image_url: null },
          { id: "li-2", name: "Tulips", sku: "TULIP-9", product_id: null, image_url: null },
          { id: "li-3", name: "Mystery", sku: "NOPE", product_id: null, image_url: null },
        ],
        rowCount: 3,
      }) // line items
      .mockResolvedValueOnce({
        rows: [
          { id: 10, sku: "ROSE-1", main_image_url: "/objects/owner_123/products/rose.jpg", image_public_path: null },
          { id: 22, sku: "TULIP-9", main_image_url: null, image_public_path: "products/22.jpg" },
        ],
        rowCount: 2,
      }) // product image lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // assignment

    const res = await request(app).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);

    const productLookup = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /FROM products/i.test(sql) && /id = ANY/i.test(sql) && /sku = ANY/i.test(sql),
    );
    expect(productLookup).toBeDefined();
    expect(productLookup![1]).toEqual(["owner_123", [10], ["ROSE-1", "TULIP-9", "NOPE"]]);

    const items = res.body.line_items as Array<{ id: string; image_url: string | null }>;
    const byId = Object.fromEntries(items.map((i) => [i.id, i.image_url]));
    // Matched by product_id → private main_image_url served via storage route.
    expect(byId["li-1"]).toMatch(/\/api\/storage\/objects\/owner_123\/products\/rose\.jpg$/);
    // Matched by sku → public-path copy is preferred.
    expect(byId["li-2"]).toMatch(/\/api\/storage\/public-objects\/products\/22\.jpg$/);
    // No matching product → stays empty (no broken image).
    expect(byId["li-3"]).toBeNull();
  });

  it("keeps an image already stored on the line item and skips the product lookup when none are needed", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: "pending" }], rowCount: 1 }) // order
      .mockResolvedValueOnce({
        rows: [
          { id: "li-1", name: "Roses", sku: "ROSE-1", product_id: 10, image_url: "https://cdn.example.com/stored.jpg" },
        ],
        rowCount: 1,
      }) // line items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // assignment

    const res = await request(app).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.line_items[0].image_url).toBe("https://cdn.example.com/stored.jpg");

    const productLookup = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /FROM products/i.test(sql) && /id = ANY/i.test(sql),
    );
    expect(productLookup).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Address Collector context + order action
// ---------------------------------------------------------------------------

describe("order Address Collector context", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns the latest workspace-scoped collector request on order detail", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM orders o") && sql.includes("LEFT JOIN order_payment")) {
        return Promise.resolve({ rows: [{ id: ORDER_ID, status: "processing" }], rowCount: 1 });
      }
      if (sql.includes("FROM address_collection_requests") && sql.includes("submitted_address")) {
        return Promise.resolve({
          rows: [{
            id: "22222222-2222-2222-2222-222222222222",
            status: "address_received",
            risk_level: "normal",
            submitted_address: { street: "Main Street" },
            address_received_at: "2026-08-24T10:00:00.000Z",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.order.address_collector_request).toEqual(
      expect.objectContaining({
        id: "22222222-2222-2222-2222-222222222222",
        status: "address_received",
        submitted_address: { street: "Main Street" },
      }),
    );
    const contextQuery = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM address_collection_requests") && sql.includes("submitted_address"),
    );
    expect(contextQuery?.[1]).toEqual([ORDER_ID, "owner_123"]);
    expect(contextQuery?.[0]).toContain("resolution_outcome");
    expect(contextQuery?.[0]).not.toContain("status NOT IN ('cancelled', 'expired')");
  });

  it("loads delivery timezone without requiring the new column during schema rollout", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM orders o") && sql.includes("LEFT JOIN order_payment")) {
        return Promise.resolve({
          rows: [{
            id: ORDER_ID,
            status: "processing",
            delivery_address: { cityId: "beirut" },
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("FROM delivery_cities dc")) {
        return Promise.resolve({ rows: [{ timezone: "UTC" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("UTC");
    const timezoneQuery = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM delivery_cities dc"),
    );
    expect(timezoneQuery?.[0]).toContain("to_jsonb(dc)->>'delivery_timezone'");
    expect(timezoneQuery?.[0]).not.toMatch(/\bdc\.delivery_timezone\b/);
  });

  it("creates an address request from recipient and delivery context", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN LATERAL") && sql.includes("recipient_name")) {
        return Promise.resolve({
          rows: [{
            id: ORDER_ID,
            window_start: "2026-08-25T10:00:00.000Z",
            window_end: "2026-08-25T12:00:00.000Z",
            delivery_address: { date: "2026-08-25", slot: "10:00–12:00", country: "LB" },
            recipient_name: "Maya Khalil",
            recipient_phone: "+961 81 865 589",
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT id, status") && sql.includes("address_collection_requests")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT status, delivery_address") && sql.includes("FROM orders")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (sql.includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({
          rows: [{ id: "33333333-3333-3333-3333-333333333333" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/address-collector`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      created: true,
      requestId: "33333333-3333-3333-3333-333333333333",
    });
    const insert = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      sql.includes("INSERT INTO address_collection_requests"),
    );
    expect(insert).toBeDefined();
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      "owner_123",
      ORDER_ID,
      "Maya Khalil",
      "+96181865589",
    ]));
    const recipientLookup = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN LATERAL") && sql.includes("recipient_name"),
    );
    expect(recipientLookup?.[0]).toContain("c.workspace_owner_id = o.workspace_owner_id");
  });

  it("treats repeated creation as an idempotent success", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN LATERAL") && sql.includes("recipient_name")) {
        return Promise.resolve({
          rows: [{
            id: ORDER_ID,
            window_start: null,
            window_end: null,
            delivery_address: null,
            recipient_name: "Maya Khalil",
            recipient_phone: "+96181865589",
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT id, status") && sql.includes("address_collection_requests")) {
        return Promise.resolve({
          rows: [{ id: "44444444-4444-4444-4444-444444444444", status: "scheduled" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/address-collector`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      created: false,
      reason: "duplicate",
      requestId: "44444444-4444-4444-4444-444444444444",
    });
    expect(
      mockDbQuery.mock.calls.some(([sql]: [string]) =>
        sql.includes("INSERT INTO address_collection_requests"),
      ),
    ).toBe(false);
  });

  it("reports an actionable error when recipient data is incomplete", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN LATERAL") && sql.includes("recipient_name")) {
        return Promise.resolve({
          rows: [{
            id: ORDER_ID,
            window_start: null,
            window_end: null,
            delivery_address: null,
            recipient_name: null,
            recipient_phone: null,
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT id, status") && sql.includes("address_collection_requests")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/address-collector`);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      success: false,
      code: "missing_recipient",
      missing: ["recipient_name", "recipient_phone"],
    });
  });

  it("returns the existing request identity when a concurrent create wins the race", async () => {
    let activeRequestReads = 0;
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("LEFT JOIN LATERAL") && sql.includes("recipient_name")) {
        return Promise.resolve({
          rows: [{
            id: ORDER_ID,
            window_start: null,
            window_end: null,
            delivery_address: null,
            recipient_name: "Maya Khalil",
            recipient_phone: "+96181865589",
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT id, status") && sql.includes("address_collection_requests")) {
        activeRequestReads += 1;
        return Promise.resolve(
          activeRequestReads === 1
            ? { rows: [], rowCount: 0 }
            : {
                rows: [{ id: "55555555-5555-5555-5555-555555555555", status: "scheduled" }],
                rowCount: 1,
              },
        );
      }
      if (sql.includes("SELECT status, delivery_address") && sql.includes("FROM orders")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (sql.includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/address-collector`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      created: false,
      reason: "duplicate",
      requestId: "55555555-5555-5555-5555-555555555555",
    });
  });
});

// ---------------------------------------------------------------------------
// GET /orders/:id — display order number resolution
// ---------------------------------------------------------------------------

describe("GET /orders/:id — display order number resolution", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("resolves a display order number (case-insensitively) to the order UUID", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }) // number → id lookup
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: "pending" }], rowCount: 1 }) // order
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // assignment

    const res = await request(app).get("/orders/LB-1125");

    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(ORDER_ID);

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LOWER\(display_order_number\)\s*=\s*LOWER\(\$2\)/i);
    expect(sql).toMatch(/ORDER BY created_at DESC/i);
    expect(params).toEqual(["owner_123", "LB-1125"]);
  });

  it("resolves an external_order_id (case-insensitively) when no display_order_number matches — externally-ingested orders never get a display_order_number, only their external_order_id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }) // number → id lookup
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: "pending" }], rowCount: 1 }) // order
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // assignment

    const res = await request(app).get("/orders/LB-2368");

    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(ORDER_ID);

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LOWER\(external_order_id\)\s*=\s*LOWER\(\$2\)/i);
    expect(params).toEqual(["owner_123", "LB-2368"]);
  });

  it("passes a UUID param through without a number lookup", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: "pending" }], rowCount: 1 }) // order
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // assignment

    const res = await request(app).get(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    const numberLookup = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /display_order_number/i.test(sql),
    );
    expect(numberLookup).toBeUndefined();
  });

  it("returns 404 when the display order number matches no order", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // number → id lookup, no match

    const res = await request(app).get("/orders/lb-9999");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: "Order not found" });
  });
});

// ---------------------------------------------------------------------------
// DELETE /orders/:id
// ---------------------------------------------------------------------------

describe("DELETE /orders/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 403 for a member without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("returns 403 for a plain member even with Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("wr.name = 'Ops 2'"),
      [71, "owner_123", "user_editor_1"],
    );
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("allows the workspace owner to delete", async () => {
    stubActualRole = "owner";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }); // existence lookup

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbConnect).toHaveBeenCalledTimes(1);
  });

  it("allows an admin with Orders-page access to delete", async () => {
    stubActualRole = "admin";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }); // existence lookup

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbConnect).toHaveBeenCalledTimes(1);
  });

  it("allows a member assigned the exact Ops 2 role to delete", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ role_id: 8 }], rowCount: 1 }) // Ops 2 membership
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }); // existence lookup

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("wr.name = 'Ops 2'"),
      [71, "owner_123", "user_editor_1"],
    );
    expect(mockDbConnect).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the order is not in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // existence lookup

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(404);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("hard-deletes the order and all child rows in a transaction", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }); // existence lookup

    const res = await request(app).delete(`/orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDbConnect).toHaveBeenCalledTimes(1);
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
    expect(mockFinalizeAddressCollectionForOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: ORDER_ID,
        workspaceOwnerId: "owner_123",
        outcome: "order_deleted",
        source: "order_hard_delete",
      }),
    );

    const deletedTables = mockClientQuery.mock.calls
      .map(([sql]: [string]) => {
        const m = /DELETE FROM (\w+)/i.exec(sql);
        return m ? m[1] : null;
      })
      .filter(Boolean);

    expect(deletedTables).toEqual([
      "fleet_driver_order_assignments",
      "order_line_items",
      "order_notes",
      "order_payment",
      "order_contacts",
      "orders",
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/refund
// ---------------------------------------------------------------------------

describe("POST /orders/:id/refund", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
  });

  function paidStripeOrder(overrides: Record<string, unknown> = {}) {
    return {
      rows: [
        {
          id: ORDER_ID,
          status: "completed",
          external_order_id: "ext-1",
          payment_status: "paid",
          payment_provider: "stripe",
          payment_reference: "pi_123",
          ...overrides,
        },
      ],
      rowCount: 1,
    };
  }

  it("returns 403 for a member without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("allows a member with Orders-page access to reach the refund flow", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // order lookup

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    // Passes the permission gate; 404 because the order lookup found nothing.
    expect(res.status).toBe(404);
    expect(mockDbQuery).toHaveBeenCalled();
  });

  it("returns 404 when the order is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(404);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers with 400", async () => {
    mockDbQuery.mockResolvedValueOnce(paidStripeOrder({ payment_provider: "mamo" }));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(400);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("rejects an already-refunded order with 400", async () => {
    mockDbQuery.mockResolvedValueOnce(paidStripeOrder({ status: "refunded" }));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(400);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("rejects when there is no Stripe reference with 400", async () => {
    mockDbQuery.mockResolvedValueOnce(paidStripeOrder({ payment_reference: null }));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(400);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("returns 503 when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    mockDbQuery.mockResolvedValueOnce(paidStripeOrder());

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(503);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("uses the UAE Stripe key when the order's delivery country is UAE", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_default";
    process.env.STRIPE_SECRET_KEY_UAE = "sk_test_uae";
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({ delivery_country_code: "AE", delivery_country: null }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      });
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_uae", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: "pi_123" });
    // The refund client must be constructed with the UAE secret key.
    const keys = mockStripeConstructor.mock.calls.map(([key]: [string]) => key);
    expect(keys).toContain("sk_test_uae");
    expect(keys).not.toContain("sk_test_default");

    delete process.env.STRIPE_SECRET_KEY_UAE;
  });

  it("uses the UAE Stripe key when the delivery country name is United Arab Emirates", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_default";
    process.env.STRIPE_SECRET_KEY_UAE = "sk_test_uae";
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          delivery_country_code: null,
          delivery_country: "United Arab Emirates",
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      });
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_uae2", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    const keys = mockStripeConstructor.mock.calls.map(([key]: [string]) => key);
    expect(keys).toContain("sk_test_uae");
    expect(keys).not.toContain("sk_test_default");

    delete process.env.STRIPE_SECRET_KEY_UAE;
  });

  it("returns 503 for a UAE order when STRIPE_SECRET_KEY_UAE is missing (no fallback)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_default";
    delete process.env.STRIPE_SECRET_KEY_UAE;
    mockDbQuery.mockResolvedValueOnce(
      paidStripeOrder({ delivery_country_code: "AE", delivery_country: null }),
    );

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY_UAE/);
    // Must NOT silently fall back to the default account.
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(
      mockStripeConstructor.mock.calls.some(([key]: [string]) => key === "sk_test_default"),
    ).toBe(false);
  });

  it("uses the default Stripe key for non-UAE orders", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_default";
    process.env.STRIPE_SECRET_KEY_UAE = "sk_test_uae";
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({ delivery_country_code: "LB", delivery_country: "Lebanon" }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      });
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_lb", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    const keys = mockStripeConstructor.mock.calls.map(([key]: [string]) => key);
    expect(keys).toContain("sk_test_default");
    expect(keys).not.toContain("sk_test_uae");

    delete process.env.STRIPE_SECRET_KEY_UAE;
  });

  it("issues a full refund, marks the order refunded, and fires the webhook", async () => {
    mockDbQuery
      .mockResolvedValueOnce(paidStripeOrder()) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }); // UPDATE orders
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_123", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order.status).toBe("refunded");
    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: "pi_123" });

    const paymentUpdate = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE order_payment/i.test(sql) && /refunded/i.test(sql),
    );
    expect(paymentUpdate).toBeDefined();

    expect(mockFireWebhookEvent).toHaveBeenCalledWith(
      "order.status_updated",
      "owner_123",
      expect.objectContaining({ orderId: ORDER_ID, status: "refunded" }),
    );

    // "refunded" is not an email-eligible status, so no customer email is sent.
    expect(mockSendOrderStatusEmail).not.toHaveBeenCalled();
  });

  it("uses the charge param when the reference is a charge id", async () => {
    mockDbQuery
      .mockResolvedValueOnce(paidStripeOrder({ payment_reference: "ch_999" }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      });
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_1", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(mockRefundsCreate).toHaveBeenCalledWith({ charge: "ch_999" });
  });

  it("returns 502 and does not mutate state when Stripe rejects the refund", async () => {
    mockDbQuery.mockResolvedValueOnce(paidStripeOrder());
    mockRefundsCreate.mockRejectedValueOnce(new MockStripeError("charge already refunded"));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/already refunded/i);

    const ordersUpdate = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(ordersUpdate).toBeUndefined();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount with 400 before any DB/Stripe work", async () => {
    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid refund amount/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it("issues a partial refund, sends the minor-unit amount, and leaves the order status intact", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          payment_amount: "100.00",
          payment_amount_usd: "100.00",
          payment_currency: "USD",
          refunded_amount: null,
          refunded_amount_usd: null,
        }),
      ) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE order_payment
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_p1", status: "succeeded" });

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 30 });

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(res.body.payment.status).toBe("partially_refunded");
    expect(Number(res.body.payment.refunded_amount)).toBeCloseTo(30, 2);

    expect(mockRefundsCreate).toHaveBeenCalledWith({
      payment_intent: "pi_123",
      amount: 3000,
    });

    // A partial refund never touches the orders table or fires the webhook.
    const ordersUpdate = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(ordersUpdate).toBeUndefined();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("accumulates a partial refund on top of a prior partial refund", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          payment_status: "partially_refunded",
          payment_amount: "100.00",
          payment_amount_usd: "100.00",
          payment_currency: "USD",
          refunded_amount: "30.00",
          refunded_amount_usd: "30.00",
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE order_payment
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_p2", status: "succeeded" });

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 20 });

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(Number(res.body.payment.refunded_amount)).toBeCloseTo(50, 2);
    expect(mockRefundsCreate).toHaveBeenCalledWith({
      payment_intent: "pi_123",
      amount: 2000,
    });
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("sends the full-refund email with the refunded amount in the paid currency", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          payment_amount: "100.00",
          payment_amount_usd: "100.00",
          payment_currency: "USD",
          refunded_amount: null,
          refunded_amount_usd: null,
        }),
      ) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }) // UPDATE orders
      .mockResolvedValueOnce({
        rows: [{ contact_email: "customer@example.com", contact_name: "Jane" }],
        rowCount: 1,
      }); // customer contact lookup (remaining detail queries use the default empty rows)
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_full", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(mockSendOrderRefundEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderRefundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "customer@example.com",
        customerName: "Jane",
        orderNumber: "ext-1",
        isPartial: false,
        refundAmountText: "$100.00",
        totalRefundedText: "$100.00",
      }),
    );
  });

  it("sends the partial-refund email with the amount and cumulative total refunded", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          payment_status: "partially_refunded",
          payment_amount: "100.00",
          payment_amount_usd: "100.00",
          payment_currency: "USD",
          refunded_amount: "30.00",
          refunded_amount_usd: "30.00",
        }),
      ) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({
        rows: [{ contact_email: "customer@example.com", contact_name: null }],
        rowCount: 1,
      }); // customer contact lookup
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_part", status: "succeeded" });

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 20 });

    expect(res.status).toBe(200);
    expect(mockSendOrderRefundEmail).toHaveBeenCalledTimes(1);
    expect(mockSendOrderRefundEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "customer@example.com",
        isPartial: true,
        refundAmountText: "$20.00",
        totalRefundedText: "$50.00",
      }),
    );
  });

  it("skips the refund email silently when no customer email is on file", async () => {
    mockDbQuery
      .mockResolvedValueOnce(paidStripeOrder()) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }); // UPDATE orders — contact lookup falls through to the default empty rows
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_ne", status: "succeeded" });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSendOrderRefundEmail).not.toHaveBeenCalled();
  });

  it("still returns success when sending the refund email fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce(paidStripeOrder()) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }) // UPDATE orders
      .mockResolvedValueOnce({
        rows: [{ contact_email: "customer@example.com", contact_name: "Jane" }],
        rowCount: 1,
      }); // customer contact lookup
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_fail", status: "succeeded" });
    mockSendOrderRefundEmail.mockRejectedValueOnce(new Error("resend down"));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockSendOrderRefundEmail).toHaveBeenCalledTimes(1);
  });

  it("closes out the payment when a partial refund covers the remaining balance", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        paidStripeOrder({
          payment_status: "partially_refunded",
          payment_amount: "100.00",
          payment_amount_usd: "100.00",
          payment_currency: "USD",
          refunded_amount: "70.00",
          refunded_amount_usd: "70.00",
        }),
      )
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }); // UPDATE orders
    mockRefundsCreate.mockResolvedValueOnce({ id: "re_p3", status: "succeeded" });

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 30 });

    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.payment.status).toBe("refunded");
    expect(res.body.order.status).toBe("refunded");
    // Prior refunds exist, so this is a top-up: the amount is still sent.
    expect(mockRefundsCreate).toHaveBeenCalledWith({
      payment_intent: "pi_123",
      amount: 3000,
    });
    expect(mockFireWebhookEvent).toHaveBeenCalledWith(
      "order.status_updated",
      "owner_123",
      expect.objectContaining({ orderId: ORDER_ID, status: "refunded" }),
    );
  });

  it("rejects a refund that exceeds the remaining balance with 400", async () => {
    mockDbQuery.mockResolvedValueOnce(
      paidStripeOrder({
        payment_amount: "100.00",
        payment_amount_usd: "100.00",
        payment_currency: "USD",
        refunded_amount: "80.00",
        refunded_amount_usd: "80.00",
      }),
    );

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 30 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds the remaining/i);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects any refund once the order is already fully refunded by amount", async () => {
    mockDbQuery.mockResolvedValueOnce(
      paidStripeOrder({
        payment_status: "partially_refunded",
        payment_amount: "100.00",
        payment_amount_usd: "100.00",
        payment_currency: "USD",
        refunded_amount: "100.00",
        refunded_amount_usd: "100.00",
      }),
    );

    const res = await request(app)
      .post(`/orders/${ORDER_ID}/refund`)
      .send({ amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been fully refunded/i);
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/refund — PayPal
// ---------------------------------------------------------------------------

describe("POST /orders/:id/refund (PayPal)", () => {
  const app = makeApp();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    process.env.PAYPAL_CLIENT_ID = "pp_client";
    process.env.PAYPAL_CLIENT_SECRET = "pp_secret";
    delete process.env.PAYPAL_ENV;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function paidPaypalOrder(overrides: Record<string, unknown> = {}) {
    return {
      rows: [
        {
          id: ORDER_ID,
          status: "completed",
          external_order_id: "ext-1",
          payment_status: "paid",
          payment_provider: "paypal",
          payment_reference: "CAPTURE123",
          ...overrides,
        },
      ],
      rowCount: 1,
    };
  }

  function tokenResponse() {
    return {
      ok: true,
      json: async () => ({ access_token: "ppt_abc" }),
    };
  }

  it("returns 503 when PayPal is not configured", async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    mockDbQuery.mockResolvedValueOnce(paidPaypalOrder());

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when there is no PayPal reference with 400", async () => {
    mockDbQuery.mockResolvedValueOnce(paidPaypalOrder({ payment_reference: null }));

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refunds the capture, marks the order refunded, and fires the webhook", async () => {
    mockDbQuery
      .mockResolvedValueOnce(paidPaypalOrder()) // order + payment lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE order_payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE cmc_sales sync (full refund)
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, external_order_id: "ext-1", status: "refunded" }],
        rowCount: 1,
      }); // UPDATE orders

    fetchMock
      .mockResolvedValueOnce(tokenResponse()) // oauth token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "RF1", status: "COMPLETED" }) });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.order.status).toBe("refunded");

    const refundCall = fetchMock.mock.calls.find(([url]: [string]) =>
      /\/v2\/payments\/captures\/CAPTURE123\/refund$/.test(url),
    );
    expect(refundCall).toBeDefined();
    expect(refundCall?.[1]?.method).toBe("POST");
    expect(refundCall?.[1]?.headers?.Authorization).toBe("Bearer ppt_abc");

    const paymentUpdate = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE order_payment/i.test(sql) && /refunded/i.test(sql),
    );
    expect(paymentUpdate).toBeDefined();

    expect(mockFireWebhookEvent).toHaveBeenCalledWith(
      "order.status_updated",
      "owner_123",
      expect.objectContaining({ orderId: ORDER_ID, status: "refunded" }),
    );
  });

  it("returns 502 and does not mutate state when PayPal rejects the refund", async () => {
    mockDbQuery.mockResolvedValueOnce(paidPaypalOrder());

    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({ details: [{ description: "Capture already refunded" }] }),
      });

    const res = await request(app).post(`/orders/${ORDER_ID}/refund`);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/already refunded/i);

    const ordersUpdate = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE orders/i.test(sql),
    );
    expect(ordersUpdate).toBeUndefined();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /orders/:id/contacts
// ---------------------------------------------------------------------------

describe("PATCH /orders/:id/contacts", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 403 for a member without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/contacts`)
      .send({ customer: { name: "Jane" } });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when no customer or recipient is provided", async () => {
    const res = await request(app).patch(`/orders/${ORDER_ID}/contacts`).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the order is not in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // existence lookup

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/contacts`)
      .send({ customer: { name: "Jane" } });

    expect(res.status).toBe(404);
  });

  it("updates existing linked customer and recipient contacts", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }) // existence
      .mockResolvedValueOnce({
        rows: [
          { role: "customer", contact_id: "contact_cust" },
          { role: "recipient", contact_id: "contact_recip" },
        ],
        rowCount: 2,
      }) // linked contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE customer contact
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE recipient contact

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/contacts`)
      .send({
        customer: { name: "Jane Doe", email: "Jane@Example.com", phone: "+9611234567" },
        recipient: { name: "John Doe", phone: "+9617654321" },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updateCalls = mockDbQuery.mock.calls.filter(([sql]: [string]) =>
      /UPDATE contacts SET/i.test(sql),
    );
    expect(updateCalls).toHaveLength(2);
    // email is lowercased before storing
    const custUpdate = updateCalls.find(([, params]: [string, unknown[]]) =>
      (params as unknown[]).includes("jane@example.com"),
    );
    expect(custUpdate).toBeDefined();
    expect(mockSyncContactToRespondIo).toHaveBeenCalledTimes(2);
    expect(mockSyncContactToRespondIo).toHaveBeenCalledWith(
      "contact_cust",
    );
    expect(mockSyncContactToRespondIo).toHaveBeenCalledWith(
      "contact_recip",
    );

    // Each edited role records an append-only audit row with the editor + name.
    const auditInserts = mockDbQuery.mock.calls.filter(([sql]: [string]) =>
      /INSERT INTO order_contact_edits/i.test(sql),
    );
    expect(auditInserts).toHaveLength(2);
    const roles = auditInserts.map(([, params]: [string, unknown[]]) => (params as unknown[])[2]);
    expect(roles).toContain("customer");
    expect(roles).toContain("recipient");
    expect((auditInserts[0]![1] as unknown[])[4]).toBe("Test Editor");
    expect(res.body.contact_edits).toBeDefined();
  });

  it("creates and links a new contact when the role is not yet linked", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }) // existence
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // no linked contacts
      .mockResolvedValueOnce({ rows: [{ id: "new_contact" }], rowCount: 1 }) // INSERT contacts
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT order_contacts

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/contacts`)
      .send({ customer: { name: "New Person", phone: "+96170000001" } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const insertContact = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO contacts/i.test(sql),
    );
    expect(insertContact).toBeDefined();
    const linkContact = mockDbQuery.mock.calls.find(([sql]: [string]) =>
      /INSERT INTO order_contacts/i.test(sql),
    );
    expect(linkContact).toBeDefined();
    expect(mockSyncContactToRespondIo).toHaveBeenCalledTimes(1);
    expect(mockSyncContactToRespondIo).toHaveBeenCalledWith(
      "new_contact",
    );
  });

  it("translates a contacts unique violation into HTTP 409", async () => {
    const uniqueErr = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "contacts_workspace_owner_id_email_unique",
    });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: ORDER_ID }], rowCount: 1 }) // existence
      .mockResolvedValueOnce({
        rows: [{ role: "customer", contact_id: "contact_cust" }],
        rowCount: 1,
      }) // linked contacts
      .mockRejectedValueOnce(uniqueErr); // UPDATE customer contact -> 23505

    const res = await request(app)
      .patch(`/orders/${ORDER_ID}/contacts`)
      .send({ customer: { email: "taken@example.com" } });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/restore-refunded — local-only refunded-order recovery
// ---------------------------------------------------------------------------

describe("POST /orders/:id/restore-refunded", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    mockDbConnect.mockClear();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    stubMemberDbId = 71;
    stubUserId = "user_editor_1";
    mockClerkGetUser.mockResolvedValue({
      firstName: "Test",
      lastName: "Editor",
      primaryEmailAddress: { emailAddress: "editor@example.com" },
    });
  });

  function queueSuccessfulRestore() {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, status: "refunded" }],
        rowCount: 1,
      }) // lock order
      .mockResolvedValueOnce({ rows: [{ status: "refunded" }], rowCount: 1 }) // lock payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update payment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update order
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // insert audit event
  }

  it.each(["owner", "admin"])("%s can restore a fully-refunded order locally", async (role) => {
    stubActualRole = role;
    queueSuccessfulRestore();

    const response = await request(app).post(`/orders/${ORDER_ID}/restore-refunded`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      order: { id: ORDER_ID, status: "processing" },
      payment: { status: "paid" },
    });
    expect(mockDbQuery).not.toHaveBeenCalled();

    const paymentUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      /UPDATE order_payment/i.test(String(sql)),
    );
    expect(paymentUpdate).toBeDefined();
    expect(String(paymentUpdate?.[0])).toMatch(/SET status = 'paid'/);
    expect(String(paymentUpdate?.[0])).not.toMatch(/refunded_amount|payment_reference/i);
    expect(paymentUpdate?.[1]).toEqual([ORDER_ID]);

    const orderUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      /UPDATE orders/i.test(String(sql)),
    );
    expect(String(orderUpdate?.[0])).toMatch(/SET status = 'processing'/);

    const auditInsert = mockClientQuery.mock.calls.find(([sql]) =>
      /INSERT INTO order_events/i.test(String(sql)),
    );
    expect(auditInsert).toBeDefined();
    expect(auditInsert?.[1]?.[2]).toBe("refunded_order_restored");
    expect(JSON.parse(String(auditInsert?.[1]?.[3]))).toEqual({
      from_order_status: "refunded",
      from_payment_status: "refunded",
      to_order_status: "processing",
      to_payment_status: "paid",
      scope: "local_only",
    });
    expect(auditInsert?.[1]?.[4]).toBe("user_editor_1");
    expect(auditInsert?.[1]?.[5]).toBe("Test Editor");

    expect(mockRefundsCreate).not.toHaveBeenCalled();
    expect(mockSendOrderPaymentReceivedEmail).not.toHaveBeenCalled();
    expect(mockSendOrderStatusEmail).not.toHaveBeenCalled();
    expect(mockFireWebhookEvent).not.toHaveBeenCalled();
  });

  it("allows an Ops 2 member even without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ role_id: 8 }], rowCount: 1 });
    queueSuccessfulRestore();

    const response = await request(app).post(`/orders/${ORDER_ID}/restore-refunded`);

    expect(response.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("wr.name = 'Ops 2'"),
      [71, "owner_123", "user_editor_1"],
    );
  });

  it("does not treat ordinary Orders-page access as recovery authorization", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];

    const response = await request(app).post(`/orders/${ORDER_ID}/restore-refunded`);

    expect(response.status).toBe(403);
    expect(mockDbConnect).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["non-refunded order", "processing", "refunded"],
    ["non-refunded payment", "refunded", "partially_refunded"],
  ])("rejects a %s without writing state or activity", async (_case, orderStatus, paymentStatus) => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ id: ORDER_ID, status: orderStatus }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ status: paymentStatus }], rowCount: 1 });

    const response = await request(app).post(`/orders/${ORDER_ID}/restore-refunded`);

    expect(response.status).toBe(409);
    expect(mockClientQuery).toHaveBeenCalledTimes(2);
    expect(mockClientQuery.mock.calls.some(([sql]) =>
      /UPDATE order_payment|UPDATE orders|INSERT INTO order_events/i.test(String(sql)),
    )).toBe(false);
  });

  it("returns 404 when the order is outside the workspace or missing", async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app).post(`/orders/${ORDER_ID}/restore-refunded`);

    expect(response.status).toBe(404);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/mark-paid — auto-advance pending → processing
// ---------------------------------------------------------------------------

describe("POST /orders/:id/mark-paid", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  function unpaidOrder(status = "pending") {
    return {
      rows: [
        {
          id: ORDER_ID,
          status,
          external_order_id: "ext-1",
          display_order_number: "LB-1001",
          payment_status: null,
        },
      ],
      rowCount: 1,
    };
  }

  it("returns 404 when the order is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(404);
  });

  it("returns 409 when the order is already paid", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: ORDER_ID,
          status: "pending",
          external_order_id: "ext-1",
          display_order_number: "LB-1001",
          payment_status: "paid",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(409);
  });

  it("keeps refunded orders rejected by the ordinary mark-paid endpoint", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: ORDER_ID,
          status: "refunded",
          external_order_id: "ext-1",
          display_order_number: "LB-1001",
          payment_status: "refunded",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(409);
    expect(mockSendOrderPaymentReceivedEmail).not.toHaveBeenCalled();
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });

  it("marks paid and auto-advances a pending order to processing", async () => {
    mockDbQuery
      .mockResolvedValueOnce(unpaidOrder("pending")) // SELECT order
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT order_payment upsert
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE cmc_sales sync (no linked record)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE orders -> processing

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const statusUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && /UPDATE orders/.test(sql) && /status = 'processing'/.test(sql),
    );
    expect(statusUpdate).toBeDefined();
    // Guarded so it only advances a still-pending order.
    expect(statusUpdate?.[0]).toMatch(/status = 'pending'/);
    expect(statusUpdate?.[1]).toEqual([ORDER_ID, "owner_123"]);
    expect(mockCreateAutomaticAddressCollectionRequest).toHaveBeenCalledWith({
      workspaceOwnerId: "owner_123",
      orderId: ORDER_ID,
    });
  });

  it("does not regress an order already past pending", async () => {
    mockDbQuery
      .mockResolvedValueOnce(unpaidOrder("out_for_delivery")) // SELECT order
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT order_payment upsert
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // UPDATE cmc_sales sync (no linked record)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matched nothing (status != pending)

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The guarded UPDATE is still issued; the WHERE status='pending' clause is
    // what prevents a non-pending order from being moved.
    const statusUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && /UPDATE orders/.test(sql) && /status = 'processing'/.test(sql),
    );
    expect(statusUpdate?.[0]).toMatch(/status = 'pending'/);
  });

  it("flips the linked CMC Sales record to paid so audit totals include it", async () => {
    mockDbQuery.mockResolvedValueOnce(unpaidOrder("pending")); // SELECT order

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);

    expect(res.status).toBe(200);
    const cmcUpdate = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && /UPDATE cmc_sales/.test(sql),
    );
    expect(cmcUpdate).toBeDefined();
    expect(cmcUpdate?.[0]).toMatch(/status = 'paid'/);
    expect(cmcUpdate?.[0]).toMatch(/workflow_type = 'order'/);
    expect(cmcUpdate?.[1]).toEqual([ORDER_ID, "owner_123"]);
  });
});

describe("POST /orders/:id/resend-whish-payment-instructions", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    mockSendWhishPaymentInstructions.mockReset();
  });

  it("requires a Whish payment and returns the Respond.io message reference", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ method: "whish", provider: null }],
      rowCount: 1,
    });
    mockSendWhishPaymentInstructions.mockResolvedValueOnce({ ok: true, providerRef: "rio-msg-9" });

    const res = await request(app).post(`/orders/${ORDER_ID}/resend-whish-payment-instructions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      sent: true,
      provider_message_id: "rio-msg-9",
    });
    expect(mockSendWhishPaymentInstructions).toHaveBeenCalledWith(
      ORDER_ID,
      "owner_123",
      expect.objectContaining({ manual: true, actorUserId: "user_editor_1" }),
    );
  });

  it("rejects non-Whish payment methods without sending", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ method: "stripe", provider: "stripe" }],
      rowCount: 1,
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/resend-whish-payment-instructions`);

    expect(res.status).toBe(409);
    expect(res.body.sent).toBe(false);
    expect(mockSendWhishPaymentInstructions).not.toHaveBeenCalled();
  });

  it("rejects a paid Whish order without sending instructions", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ method: "whish", provider: "whish", status: "paid" }],
      rowCount: 1,
    });

    const res = await request(app).post(`/orders/${ORDER_ID}/resend-whish-payment-instructions`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/unpaid Whish/i);
    expect(mockSendWhishPaymentInstructions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /orders/:id/mark-paid — deferred Tookan task for Whish orders
// ---------------------------------------------------------------------------

describe("POST /orders/:id/mark-paid — Tookan awaiting_payment", () => {
  const app = makeApp();
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  function orderRow(overrides: Record<string, unknown> = {}) {
    return {
      rows: [
        {
          id: ORDER_ID,
          status: "pending",
          external_order_id: "ext-1",
          display_order_number: "LB-1001",
          payment_status: null,
          tookan_job_id: null,
          tookan_status: "awaiting_payment",
          ...overrides,
        },
      ],
      rowCount: 1,
    };
  }

  it("creates the deferred Tookan task when an awaiting_payment order is marked paid", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockRetryTookanDeliveryTask.mockResolvedValue({ ok: true });
    mockDbQuery
      .mockResolvedValueOnce(orderRow()) // SELECT order
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // payment upsert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // status UPDATE

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);
    await flush();

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).toHaveBeenCalledTimes(1);
    expect(mockRetryTookanDeliveryTask).toHaveBeenCalledWith(ORDER_ID, "owner_123");
  });

  it("does not create a Tookan task when the order already has a Tookan job", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery
      .mockResolvedValueOnce(orderRow({ tookan_job_id: "job-9", tookan_status: "created" }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);
    await flush();

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).not.toHaveBeenCalled();
  });

  it("does not create a Tookan task when tookan_status is not awaiting_payment", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery
      .mockResolvedValueOnce(orderRow({ tookan_status: "failed" }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);
    await flush();

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).not.toHaveBeenCalled();
  });

  it("does not create a Tookan task when the integration is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);
    mockDbQuery
      .mockResolvedValueOnce(orderRow())
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post(`/orders/${ORDER_ID}/mark-paid`);
    await flush();

    expect(res.status).toBe(200);
    expect(mockRetryTookanDeliveryTask).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /orders/backfill-tookan
// ---------------------------------------------------------------------------

describe("POST /orders/backfill-tookan", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
  });

  it("returns 403 for a member without Orders-page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(app).post(`/orders/backfill-tookan`);

    expect(res.status).toBe(403);
    expect(mockBackfillTookanDeliveryTasks).not.toHaveBeenCalled();
  });

  it("allows a member with Orders-page access to run the backfill", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    mockIsTookanEnabled.mockReturnValue(true);
    mockBackfillTookanDeliveryTasks.mockResolvedValue({
      attempted: 2,
      succeeded: 2,
      failed: 0,
    });

    const res = await request(app).post(`/orders/backfill-tookan`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, attempted: 2, succeeded: 2, failed: 0 });
    expect(mockBackfillTookanDeliveryTasks).toHaveBeenCalledWith("owner_123");
  });

  it("still works for the owner", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockBackfillTookanDeliveryTasks.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });

    const res = await request(app).post(`/orders/backfill-tookan`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when the Tookan integration is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);

    const res = await request(app).post(`/orders/backfill-tookan`);

    expect(res.status).toBe(400);
    expect(mockBackfillTookanDeliveryTasks).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Trustpilot invitation routes
// ---------------------------------------------------------------------------

const DISPLAY_ORDER_NUMBER = "lb-1001";
const TP_ORDER_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeResolveOrderRow(id = TP_ORDER_UUID) {
  return { rows: [{ id }], rowCount: 1 };
}

const noRow = { rows: [], rowCount: 0 };

const sampleInvitation = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  order_id: TP_ORDER_UUID,
  status: "pending",
  recipient_email: "a@b.com",
  recipient_name: "Alice",
  reference_id: DISPLAY_ORDER_NUMBER,
  locale: "en-US",
  preferred_send_time: "2026-07-24T10:00:00.000Z",
  attempt_count: 0,
  next_attempt_at: null,
  last_error: null,
  last_attempt_at: null,
  trustpilot_invitation_id: null,
  created_at: "2026-07-23T00:00:00.000Z",
  updated_at: "2026-07-23T00:00:00.000Z",
};

describe("GET /orders/:id/trustpilot-invitation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockIsTrustpilotEnabled.mockReturnValue(false);
    mockIsTrustpilotTestMode.mockReturnValue(false);
  });

  it("returns 403 for a non-owner member", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];

    const res = await request(app).get(`/orders/${TP_ORDER_UUID}/trustpilot-invitation`);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("resolves by UUID and returns invitation when found", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow()) // resolveOrderId
      .mockResolvedValueOnce({ rows: [sampleInvitation], rowCount: 1 }); // SELECT trustpilot_invitations

    const res = await request(app).get(`/orders/${TP_ORDER_UUID}/trustpilot-invitation`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.invitation).toMatchObject({ status: "pending" });
    expect(res.body.enabled).toBe(false);

    // Verify resolveOrderId uses the regex guard (never a bare uuid cast)
    const resolveSql = mockDbQuery.mock.calls[0][0] as string;
    expect(resolveSql).toContain("display_order_number = $1");
    expect(resolveSql).toContain("~ '^[0-9a-f]");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([TP_ORDER_UUID, "owner_123"]);
  });

  it("resolves by display_order_number and returns invitation — the UUID-cast bug fix", async () => {
    // This is the key regression test: passing a non-UUID id param must NOT
    // cause "invalid input syntax for type uuid" — the regex guard prevents that.
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow()) // resolveOrderId finds by display_order_number
      .mockResolvedValueOnce({ rows: [sampleInvitation], rowCount: 1 });

    const res = await request(app).get(`/orders/${DISPLAY_ORDER_NUMBER}/trustpilot-invitation`);

    expect(res.status).toBe(200);
    expect(res.body.invitation).toMatchObject({ status: "pending" });

    // The query param is the display_order_number string, workspace_owner_id scopes it
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(DISPLAY_ORDER_NUMBER);
    expect(params[1]).toBe("owner_123");
  });

  it("returns 404 when no matching order exists", async () => {
    mockDbQuery.mockResolvedValueOnce(noRow); // resolveOrderId → not found

    const res = await request(app).get(`/orders/m-9999/trustpilot-invitation`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns null invitation when no row has been enqueued for this order", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce(noRow); // no trustpilot_invitations row

    const res = await request(app).get(`/orders/${TP_ORDER_UUID}/trustpilot-invitation`);

    expect(res.status).toBe(200);
    expect(res.body.invitation).toBeNull();
  });

  it("includes workspace toggle in enabled flag when env switch is on", async () => {
    mockIsTrustpilotEnabled.mockReturnValue(true);
    mockIsTrustpilotTestMode.mockReturnValue(false);
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce(noRow) // trustpilot_invitations
      .mockResolvedValueOnce({ rows: [{ trustpilot_invitations_enabled: false }], rowCount: 1 }); // workspace_settings

    const res = await request(app).get(`/orders/${TP_ORDER_UUID}/trustpilot-invitation`);

    expect(res.status).toBe(200);
    // Env switch on but workspace toggle off → enabled = false
    expect(res.body.enabled).toBe(false);
  });

  it("reports enabled=true when env switch and workspace toggle are both on", async () => {
    mockIsTrustpilotEnabled.mockReturnValue(true);
    mockIsTrustpilotTestMode.mockReturnValue(false);
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce(noRow)
      .mockResolvedValueOnce({ rows: [{ trustpilot_invitations_enabled: true }], rowCount: 1 });

    const res = await request(app).get(`/orders/${TP_ORDER_UUID}/trustpilot-invitation`);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});

describe("POST /orders/:id/trustpilot-invitation/retry", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockIsTrustpilotEnabled.mockReturnValue(true);
    mockIsTrustpilotTestMode.mockReturnValue(false);
    mockMaybeEnqueueTrustpilotInvitation.mockResolvedValue("enqueued");
    mockProcessTrustpilotInvitation.mockResolvedValue(undefined);
  });

  it("returns 403 for a non-owner member", async () => {
    stubActualRole = "member";

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when the Trustpilot integration is disabled", async () => {
    mockIsTrustpilotEnabled.mockReturnValue(false);

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 for a display_order_number param when no order exists — UUID-cast bug fix", async () => {
    // Passing a display_order_number must use the regex-guarded resolveOrderId, not a bare cast
    mockDbQuery.mockResolvedValueOnce(noRow); // resolveOrderId → not found

    const res = await request(app).post(`/orders/${DISPLAY_ORDER_NUMBER}/trustpilot-invitation/retry`);

    expect(res.status).toBe(404);
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(DISPLAY_ORDER_NUMBER);
    expect(params[1]).toBe("owner_123");
  });

  it("returns 404 when a UUID param matches no order", async () => {
    mockDbQuery.mockResolvedValueOnce(noRow); // resolveOrderId

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(404);
  });

  it("returns 409 when the order is not completed", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow()) // resolveOrderId
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "processing", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      }); // order lookup

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not completed/i);
  });

  it("returns 409 when the completed order has no customer email", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: null, customer_name: null }],
        rowCount: 1,
      });

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no customer email/i);
  });

  it("returns 409 when the invitation was already sent (created status)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(noRow) // UPDATE failed (no failed row to reset)
      .mockResolvedValueOnce({ rows: [{ status: "created" }], rowCount: 1 }); // existing row check

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already sent/i);
  });

  it("returns 409 when the invitation is currently being processed (pending status)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(noRow) // UPDATE failed
      .mockResolvedValueOnce({ rows: [{ status: "pending" }], rowCount: 1 }); // existing row

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/being processed/i);
  });

  it("resets a failed row to pending and fires processing — success path with UUID param", async () => {
    const invRowId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow()) // resolveOrderId
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      }) // order lookup
      .mockResolvedValueOnce({ rows: [{ id: invRowId }], rowCount: 1 }) // UPDATE failed → pending returns id
      .mockResolvedValueOnce({ rows: [{ ...sampleInvitation, status: "pending", id: invRowId }], rowCount: 1 }); // final SELECT

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.invitation).toMatchObject({ status: "pending" });
    // Async processing was kicked off
    expect(mockProcessTrustpilotInvitation).toHaveBeenCalledWith(invRowId);
  });

  it("resets a failed row via display_order_number param (UUID-cast bug fix)", async () => {
    const invRowId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow()) // resolveOrderId
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: invRowId }], rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [{ ...sampleInvitation, id: invRowId }], rowCount: 1 });

    const res = await request(app).post(`/orders/${DISPLAY_ORDER_NUMBER}/trustpilot-invitation/retry`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // resolveOrderId was called with the display_order_number, not a UUID
    const resolveParams = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(resolveParams[0]).toBe(DISPLAY_ORDER_NUMBER);
  });

  it("enqueues fresh when no invitation row exists yet", async () => {
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(noRow) // UPDATE (no failed row) → rowCount 0
      .mockResolvedValueOnce(noRow) // SELECT existing → no row → triggers enqueue
      .mockResolvedValueOnce({ rows: [sampleInvitation], rowCount: 1 }); // final SELECT

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(200);
    expect(mockMaybeEnqueueTrustpilotInvitation).toHaveBeenCalledWith(
      TP_ORDER_UUID,
      null,
      "completed",
    );
  });

  it("returns 502 when fresh enqueue fails unexpectedly", async () => {
    mockMaybeEnqueueTrustpilotInvitation.mockResolvedValue("error");
    mockDbQuery
      .mockResolvedValueOnce(makeResolveOrderRow())
      .mockResolvedValueOnce({
        rows: [{ id: TP_ORDER_UUID, status: "completed", customer_email: "a@b.com", customer_name: "Alice" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(noRow) // UPDATE
      .mockResolvedValueOnce(noRow); // SELECT existing → no row

    const res = await request(app).post(`/orders/${TP_ORDER_UUID}/trustpilot-invitation/retry`);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lookupOrderEmailDetails — effective paid total from component fields
// ---------------------------------------------------------------------------

describe("lookupOrderEmailDetails — effective paid total", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  // Helper: build mock query responses for lookupOrderEmailDetails.
  // First call: order totals row. Second call: line items (empty).
  function mockOrderTotalsAndLineItems(totals: Record<string, unknown>) {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            totals,
            window_start: null,
            card_message: null,
            payment_method: null,
            coupon_discount_usd: null,
            coupon_code: null,
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // line items
  }

  it("uses paid_subtotal + paid_shipping as the effective total when both are present", async () => {
    // paid_total is a deposit (100 AED); real order is 380 AED
    mockOrderTotalsAndLineItems({
      total: 103.4, // USD equivalent
      currency: "USD",
      subtotal: 81.68,
      shipping: 21.72,
      paid_total: 100,        // deposit / wrong figure
      paid_currency: "AED",
      paid_subtotal: 300,
      paid_shipping: 80,
    });

    const result = await lookupOrderEmailDetails("order-id", "owner-id");

    expect(result.amountPaidText).toBe("AED 380.00");
    // paidConversion.rate should be derived from 380, not 100
    // rate = 380 / 103.4 ≈ 3.675
    // Verify subtotalText uses the stored paid_subtotal directly
    expect(result.subtotalText).toBe("AED 300.00");
    expect(result.deliveryFeeText).toBe("AED 80.00");
  });

  it("uses only paid_subtotal (plus zero) when paid_shipping is absent", async () => {
    mockOrderTotalsAndLineItems({
      total: 54.45,
      currency: "USD",
      paid_total: 50,         // partial amount
      paid_currency: "AED",
      paid_subtotal: 200,
      // no paid_shipping
    });

    const result = await lookupOrderEmailDetails("order-id", "owner-id");

    expect(result.amountPaidText).toBe("AED 200.00");
  });

  it("falls back to paid_total when neither component is stored", async () => {
    mockOrderTotalsAndLineItems({
      total: 27.23,
      currency: "USD",
      paid_total: 100,
      paid_currency: "AED",
      // no paid_subtotal or paid_shipping
    });

    const result = await lookupOrderEmailDetails("order-id", "owner-id");

    expect(result.amountPaidText).toBe("AED 100.00");
  });

  it("is unaffected when paid_subtotal + paid_shipping equals paid_total", async () => {
    // Normal case: components add up to total — behaviour unchanged
    mockOrderTotalsAndLineItems({
      total: 54.45,
      currency: "USD",
      paid_total: 200,
      paid_currency: "AED",
      paid_subtotal: 180,
      paid_shipping: 20,
    });

    const result = await lookupOrderEmailDetails("order-id", "owner-id");

    expect(result.amountPaidText).toBe("AED 200.00");
  });

  it("shows USD total when no paid-currency pair is stored (legacy USD order)", async () => {
    mockOrderTotalsAndLineItems({
      total: 50,
      currency: "USD",
      // no paid_total / paid_currency
    });

    const result = await lookupOrderEmailDetails("order-id", "owner-id");

    // formatOrderAmount uses Intl.NumberFormat narrowSymbol; USD formats as "$50.00"
    expect(result.amountPaidText).toBe("$50.00");
  });
});

// ---------------------------------------------------------------------------
// POST /orders/manual
// ---------------------------------------------------------------------------

describe("POST /orders/manual", () => {
  /** Minimal wizard-shaped payload including the Address Collector fields. */
  const fullWizardPayload = {
    source: "manual",
    status: "pending",
    customer: { display_name: "Alice", phone: "+9613000111", email: "alice@example.com" },
    recipient: { display_name: "Bob", phone: "+9613999888" },
    line_items: [
      {
        product_id: 42,
        sku: "SKU-1",
        name: "Red Roses",
        quantity: 2,
        unit_price: 50,
        image_url: null,
        custom_input: null,
        is_custom_item: false,
        production_instructions: null,
        custom_item_created_by: null,
      },
    ],
    delivery_address: { address: "12 Main St", district: "Achrafieh" },
    delivery_instructions: "Leave at door",
    window_start: null,
    window_end: null,
    card_message: "Happy Birthday!",
    card_from: "Friend",
    card_to: "Bob",
    totals: { subtotal: 100, currency: "USD" },
    payment: { method: "cash", status: "pending", currency: "USD" },
    notes: { internal_note: "Handle with care" },
    payment_link_id: null,
    collect_address: true,
    preferred_language: "en",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "owner";
    stubAllowedPages = null;
    mockCreateManualOrder.mockResolvedValue({ orderId: "new-order-id", displayOrderNumber: "M-1001" });
  });

  it("returns 201 with full wizard payload including collect_address and preferred_language", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send(fullWizardPayload);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, id: "new-order-id", display_order_number: "M-1001" });
    expect(mockCreateManualOrder).toHaveBeenCalledOnce();
    const callArg = mockCreateManualOrder.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.collect_address).toBe(true);
    expect(callArg.data.preferred_language).toBe("en");
  });

  it("returns 201 when collect_address is false (no address collection)", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send({ ...fullWizardPayload, collect_address: false, preferred_language: null });

    expect(res.status).toBe(201);
    const callArg = mockCreateManualOrder.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.collect_address).toBe(false);
  });

  it("denies a CMC discount when the member only has New Order access", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc-pos-new-order"];
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send({
        ...fullWizardPayload,
        source: "cmc-pos",
        discount: { type: "percent", value: 10, reason: "Customer goodwill", explanation: null },
      });

    expect(res.status).toBe(403);
    expect(mockCreateManualOrder).not.toHaveBeenCalled();
  });

  it("does not let the discount sub-permission create a non-CMC order", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc_pos.discount"];
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send(fullWizardPayload);

    expect(res.status).toBe(403);
    expect(mockCreateManualOrder).not.toHaveBeenCalled();
  });

  it("passes a permitted CMC discount through to the authoritative create path", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc-pos-new-order", "cmc_pos.discount"];
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send({
        ...fullWizardPayload,
        source: "cmc-pos",
        discount: { type: "amount", value: 10, reason: "Service recovery", explanation: "Ribbon" },
      });

    expect(res.status).toBe(201);
    expect((mockCreateManualOrder.mock.calls[0]![0] as { data: { discount: unknown } }).data.discount)
      .toMatchObject({ type: "amount", value: 10, reason: "Service recovery" });
  });

  it("allows a New-Order-only role to create a CMC order", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc-pos-new-order"];
    const res = await request(makeApp())
      .post("/orders/manual")
      .send({ ...fullWizardPayload, source: "cmc-pos" });

    expect(res.status).toBe(201);
    expect(mockCreateManualOrder).toHaveBeenCalledOnce();
  });

  it("denies a Dashboard-only role from creating a CMC order", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc-pos-dashboard"];
    const res = await request(makeApp())
      .post("/orders/manual")
      .send({ ...fullWizardPayload, source: "cmc-pos" });

    expect(res.status).toBe(403);
    expect(mockCreateManualOrder).not.toHaveBeenCalled();
  });

  it("does not let a legacy CMC action permission substitute for New Order", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["cmc_pos.discount"];
    const res = await request(makeApp())
      .post("/orders/manual")
      .send({ ...fullWizardPayload, source: "cmc-pos" });

    expect(res.status).toBe(403);
    expect(mockCreateManualOrder).not.toHaveBeenCalled();
  });

  it("keeps owners unrestricted for CMC order creation", async () => {
    stubActualRole = "owner";
    stubAllowedPages = null;
    const res = await request(makeApp())
      .post("/orders/manual")
      .send({ ...fullWizardPayload, source: "cmc-pos" });

    expect(res.status).toBe(201);
  });

  it("keeps the ordinary Orders permission path separate", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    const res = await request(makeApp())
      .post("/orders/manual")
      .send(fullWizardPayload);

    expect(res.status).toBe(201);
  });

  it("returns 201 when collect_address and preferred_language are omitted (backward-compat)", async () => {
    const { collect_address: _ca, preferred_language: _pl, ...payloadWithout } = fullWizardPayload;
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send(payloadWithout);

    expect(res.status).toBe(201);
    expect(mockCreateManualOrder).toHaveBeenCalledOnce();
  });

  it("returns 400 with a descriptive error when an unknown key is included", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send({ ...fullWizardPayload, unknown_future_field: "oops" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation error/i);
    expect(res.body.details).toBeDefined();
  });

  it("returns 400 when line_items is empty", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send({ ...fullWizardPayload, line_items: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one product/i);
  });

  it("returns 403 when the caller has no orders page access", async () => {
    stubActualRole = "member";
    stubAllowedPages = [];
    const app = makeApp();
    const res = await request(app)
      .post("/orders/manual")
      .send(fullWizardPayload);

    expect(res.status).toBe(403);
  });

  it("requires payment-links permission before accepting a payment link", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["orders"];
    const app = makeApp();

    const res = await request(app)
      .post("/orders/manual")
      .send({ ...fullWizardPayload, payment_link_id: 42 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/payment links/i);
    expect(mockCreateManualOrder).not.toHaveBeenCalled();
  });

  it("passes payment-link confirmations through explicitly", async () => {
    const app = makeApp();

    const res = await request(app)
      .post("/orders/manual")
      .send({
        ...fullWizardPayload,
        payment_link_id: 42,
        confirm_payment_link_reassignment: true,
        confirm_payment_link_mismatch: true,
      });

    expect(res.status).toBe(201);
    expect(mockCreateManualOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payment_link_id: 42,
          confirm_payment_link_reassignment: true,
          confirm_payment_link_mismatch: true,
        }),
      }),
    );
  });
});
