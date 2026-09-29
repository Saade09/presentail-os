import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

const mockDbQuery = vi.fn();
const mockConsumeOtpRateLimit = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/otpRateLimit", () => ({
  consumeOtpRateLimit: (...args: unknown[]) => mockConsumeOtpRateLimit(...args),
  otpRateLimitClientIp: () => "127.0.0.1",
}));

vi.mock("../lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../lib/clerkDriverSync", () => ({
  syncDriverToClerk: vi.fn().mockResolvedValue("clerk_test_user_id"),
}));

const mockTwilioCreate = vi.fn();
vi.mock("twilio", () => {
  const factory = () => ({
    messages: { create: mockTwilioCreate },
  });
  return { default: factory };
});

const mockSendExpoPushNotification = vi.fn().mockResolvedValue({ success: true });
vi.mock("../lib/expoPush", () => ({
  sendExpoPushNotification: (...args: unknown[]) =>
    mockSendExpoPushNotification(...args),
}));

const mockDriverSseBroadcast = vi.fn();
const mockDriverSseBroadcastStatusChange = vi.fn();
vi.mock("../lib/driverSse", () => ({
  subscribe: vi.fn(),
  broadcast: (...args: unknown[]) => mockDriverSseBroadcast(...args),
  broadcastStatusChange: (...args: unknown[]) => mockDriverSseBroadcastStatusChange(...args),
}));

const FAKE_DRIVER_ID = 42;

vi.mock("../lib/driverTokenAuth", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/driverTokenAuth")>();
  return {
    ...orig,
    requireDriverToken: (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { driverId: number; driverWorkspaceOwnerId: string }).driverId =
        FAKE_DRIVER_ID;
      (
        req as Request & { driverId: number; driverWorkspaceOwnerId: string }
      ).driverWorkspaceOwnerId = "00000000-0000-0000-0000-000000000001";
      next();
    },
    issueDriverToken: vi.fn().mockResolvedValue({
      plaintext: "fdt_live_testtoken",
      hash: "fakehash",
      prefix: "fdt_live_testt",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }),
  };
});

const fakeOwner = "00000000-0000-0000-0000-000000000001";

vi.mock("../lib/auth", () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth: unknown }).auth = { userId: "00000000-0000-0000-0000-000000000001" };
    next();
  },
}));

let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => {
  const OWNER = "00000000-0000-0000-0000-000000000001";
  return {
    resolveWorkspace: (req: Request, _res: Response, next: NextFunction) => {
      Object.assign(req, {
        workspaceOwnerId: OWNER,
        workspaceRole: stubWorkspaceRole,
        workspaceActualRole: stubWorkspaceRole,
        userId: OWNER,
        userEmail: null,
        allowedPages: stubAllowedPages,
        customRoleId: null,
        memberDbId: null,
        assignedLocationIds: null,
      });
      next();
    },
    workspace: (req: Request) =>
      req as unknown as { workspaceOwnerId: string; workspaceRole: string },
    hasPageAccess: (
      wreq: { workspaceRole: string; allowedPages: string[] | null },
      pageKey: string,
    ) => wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
  };
});

import fleetRouter from "./fleet";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = console;
    next();
  });
  app.use("/api", fleetRouter);
  return app;
}

describe("fleet routes (integration, mocked db)", () => {
  beforeEach(() => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConsumeOtpRateLimit.mockReset();
    mockConsumeOtpRateLimit.mockResolvedValue(true);
    mockSendExpoPushNotification.mockReset();
    mockSendExpoPushNotification.mockResolvedValue(undefined);
    mockDriverSseBroadcast.mockReset();
    mockDriverSseBroadcastStatusChange.mockReset();
  });

  it("GET /api/fleet/drivers responds with success envelope", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // list query
    const res = await request(makeApp()).get("/api/fleet/drivers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, drivers: [] });
  });

  it("GET /api/fleet/drivers applies onboarding_status filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await request(makeApp()).get("/api/fleet/drivers?onboarding_status=approved");
    const sql = String(mockDbQuery.mock.calls[0][0]);
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(sql).toMatch(/onboarding_status = \$/);
    expect(params).toContain("approved");
  });

  it("GET /api/fleet/drivers active=true narrows to active+approved", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await request(makeApp()).get("/api/fleet/drivers?active=true");
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/status = 'active' AND onboarding_status = 'approved'/);
  });

  it("POST /api/fleet/drivers rejects invalid phone (E.164)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // ensureSeed
    const res = await request(makeApp())
      .post("/api/fleet/drivers")
      .send({
        first_name: "A",
        last_name: "B",
        phone: "not-a-number",
        vehicle_type: "Car",
      });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/fleet/drivers rejects vehicle_type not in DB list", async () => {
    // ensureSeedVehicleTypes runs first, then isAllowedVehicleType returns 0 rows.
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(makeApp())
      .post("/api/fleet/drivers")
      .send({
        first_name: "A",
        last_name: "B",
        phone: "+9710000000",
        vehicle_type: "Spaceship",
      });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("INVALID_VEHICLE_TYPE");
  });

  it("PATCH /api/fleet/drivers/:id/status accepts {status} alias body", async () => {
    // ownership check returns one row (current pending), then UPDATE.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, current: "pending" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // revoke
    // For status=pending we go to else branch (revoke + update). 2 calls total.
    const res = await request(makeApp())
      .patch("/api/fleet/drivers/5/status")
      .send({ status: "pending" });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.onboarding_status).toBe("pending");
  });

  it("PATCH /api/fleet/orders/:id/assign-driver works (PATCH alias)", async () => {
    // 1) order lookup, 2) driver lookup (must be approved), 3) existing
    // assignment lookup (none), 4) INSERT returning id.
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00100", display_order_number: "ORD-100", delivery_address: { address_1: "1 St", city: "Beirut" } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 7, onboarding_status: "approved" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 999 }], rowCount: 1 });
    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00100/assign-driver")
      .send({ driver_id: 7 });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.driver_id).toBe(7);
    expect(res.body?.assignment_id).toBe(999);
  });

  it("GET /api/fleet/drivers returns 403 for a member without Fleet or Orders access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["devices"];
    const res = await request(makeApp()).get("/api/fleet/drivers");
    expect(res.status).toBe(403);
    // fleetManagerOnly short-circuits before any DB query runs.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("GET /api/fleet/drivers allows a member with Fleet-page access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["fleet"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // list query
    const res = await request(makeApp()).get("/api/fleet/drivers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, drivers: [] });
  });

  it("GET /api/fleet/drivers allows a member with Orders-page access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // list query
    const res = await request(makeApp()).get("/api/fleet/drivers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, drivers: [] });
  });

  it.each([
    ["get", "/api/fleet/assignments"],
    ["patch", "/api/fleet/assignments/1"],
    ["get", "/api/fleet/delivery-events"],
    ["post", "/api/fleet/delivery-events"],
    ["get", "/api/fleet/proof-of-delivery"],
    ["post", "/api/fleet/proof-of-delivery"],
  ] as const)("%s %s rejects members without Fleet or Orders access", async (method, path) => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["devices"];

    const res = await request(makeApp())[method](path).send({});

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each(["fleet", "orders"])(
    "GET /api/fleet/assignments allows members with %s access",
    async (permission) => {
      stubWorkspaceRole = "member";
      stubAllowedPages = [permission];
      mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(makeApp()).get("/api/fleet/assignments");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ assignments: [] });
    },
  );

  it("DELETE /api/fleet/orders/:id/assign-driver clears the assignment and notifies the displaced driver", async () => {
    mockDbQuery
      // 1) existing assignment lookup → assigned to driver 88
      .mockResolvedValueOnce({ rows: [{ id: 700, driver_id: 88 }], rowCount: 1 })
      // 2) DELETE assignment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3) displaced driver push token lookup
      .mockResolvedValueOnce({
        rows: [{ expo_push_token: "ExponentPushToken[displaced]" }],
        rowCount: 1,
      });

    const res = await request(makeApp()).delete(
      "/api/fleet/orders/ord-00300/assign-driver",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, driver_id: null, order_id: "ord-00300" });

    // The assignment row must be deleted.
    const deleteCall = mockDbQuery.mock.calls.find((c: unknown[]) =>
      /DELETE FROM fleet_driver_order_assignments/.test(String(c[0])),
    );
    expect(deleteCall).toBeDefined();

    // Displaced driver is notified via push + SSE.
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());
    expect(mockSendExpoPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[displaced]",
      "Delivery removed",
      expect.any(String),
      expect.objectContaining({ order_id: "ord-00300" }),
    );
    expect(mockDriverSseBroadcast).toHaveBeenCalledWith(88);
  });

  it("DELETE /api/fleet/orders/:id/assign-driver is idempotent when no assignment exists", async () => {
    // existing assignment lookup → none
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).delete(
      "/api/fleet/orders/ord-00301/assign-driver",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, driver_id: null });
    // No delete, no push, no SSE.
    expect(mockSendExpoPushNotification).not.toHaveBeenCalled();
    expect(mockDriverSseBroadcast).not.toHaveBeenCalled();
  });

  it("DELETE /api/fleet/orders/:id/assign-driver returns 403 for a member without Fleet or Orders access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["devices"];
    const res = await request(makeApp()).delete(
      "/api/fleet/orders/ord-00302/assign-driver",
    );
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("DELETE /api/fleet/orders/:id/assign-driver allows a member with Orders-page access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    // existing assignment lookup → none (idempotent path, no notifications)
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).delete(
      "/api/fleet/orders/ord-00303/assign-driver",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, driver_id: null });
  });

  // ---------------------------------------------------------------------------
  // Push notification behaviour in assign-driver
  // ---------------------------------------------------------------------------

  it("assign-driver sends push notification with correct args when driver has expo_push_token", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00100", display_order_number: "ORD-100", delivery_address: { address_1: "1 St", city: "Beirut" } }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 7, onboarding_status: "approved", expo_push_token: "ExponentPushToken[driverToken123]" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 888 }], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00100/assign-driver")
      .send({ driver_id: 7 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    // Wait for the fire-and-forget promise to settle.
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());

    expect(mockSendExpoPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[driverToken123]",
      "New delivery assigned",
      "You have a new delivery",
      { order_id: "ord-00100", assignment_id: 888 },
    );
  });

  it("assign-driver does NOT send push notification when driver has no expo_push_token", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00101", display_order_number: "ORD-101", delivery_address: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 8, onboarding_status: "approved", expo_push_token: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 777 }], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00101/assign-driver")
      .send({ driver_id: 8 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(mockSendExpoPushNotification).not.toHaveBeenCalled();
  });

  it("assign-driver returns 200 even when push notification throws", async () => {
    mockSendExpoPushNotification.mockRejectedValue(new Error("Expo service unavailable"));

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00102", display_order_number: "ORD-102", delivery_address: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 9, onboarding_status: "approved", expo_push_token: "ExponentPushToken[failToken]" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 666 }], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00102/assign-driver")
      .send({ driver_id: 9 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.assignment_id).toBe(666);

    // The push was attempted despite failing.
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());
  });

  it("assign-driver sends push notification to displaced driver when reassigned to a different driver", async () => {
    mockDbQuery
      // 1) order lookup
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00100", display_order_number: "ORD-100", delivery_address: { address_1: "1 St", city: "Beirut" } }],
        rowCount: 1,
      })
      // 2) new driver lookup (approved, has push token)
      .mockResolvedValueOnce({
        rows: [{ id: 7, onboarding_status: "approved", expo_push_token: "ExponentPushToken[newDriver]" }],
        rowCount: 1,
      })
      // 3) existing assignment lookup → order already assigned to driver 99
      .mockResolvedValueOnce({ rows: [{ id: 500, driver_id: 99 }], rowCount: 1 })
      // 4) UPDATE assignment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 5) displaced driver push token lookup
      .mockResolvedValueOnce({
        rows: [{ expo_push_token: "ExponentPushToken[displacedDriver]" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00100/assign-driver")
      .send({ driver_id: 7 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.assignment_id).toBe(500);

    // Wait for the fire-and-forget promises to settle.
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledTimes(2));

    const calls = mockSendExpoPushNotification.mock.calls;
    const tokens = calls.map((c: unknown[]) => c[0]);
    // Displaced driver notified with "Delivery reassigned"
    const displacedCall = calls.find((c: unknown[]) => c[0] === "ExponentPushToken[displacedDriver]");
    expect(displacedCall).toBeDefined();
    expect(displacedCall![1]).toBe("Delivery reassigned");
    expect(displacedCall![3]).toMatchObject({ order_id: "ord-00100", assignment_id: 500 });
    // New driver notified with "New delivery assigned"
    const newDriverCall = calls.find((c: unknown[]) => c[0] === "ExponentPushToken[newDriver]");
    expect(newDriverCall).toBeDefined();
    expect(newDriverCall![1]).toBe("New delivery assigned");
    void tokens;
  });

  it("assign-driver does NOT send push to displaced driver when same driver is re-assigned", async () => {
    mockDbQuery
      // 1) order lookup
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00100", display_order_number: "ORD-100", delivery_address: null }],
        rowCount: 1,
      })
      // 2) driver lookup
      .mockResolvedValueOnce({
        rows: [{ id: 7, onboarding_status: "approved", expo_push_token: "ExponentPushToken[sameDriver]" }],
        rowCount: 1,
      })
      // 3) existing assignment with the SAME driver_id=7
      .mockResolvedValueOnce({ rows: [{ id: 501, driver_id: 7 }], rowCount: 1 })
      // 4) UPDATE assignment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // No displaced-driver lookup should happen.

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00100/assign-driver")
      .send({ driver_id: 7 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    // Only the new-driver push fires (no displaced driver push).
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());
    expect(mockSendExpoPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[sameDriver]",
      "New delivery assigned",
      expect.any(String),
      expect.any(Object),
    );
  });

  // ---------------------------------------------------------------------------
  // SSE broadcast behaviour in assign-driver
  // ---------------------------------------------------------------------------

  it("assign-driver calls SSE broadcast with the assigned driver ID after a new assignment", async () => {
    mockDbQuery
      // 1) order lookup
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00200", display_order_number: "ORD-200", delivery_address: { address_1: "5 Ave", city: "Dubai" } }],
        rowCount: 1,
      })
      // 2) driver lookup (approved, has push token)
      .mockResolvedValueOnce({
        rows: [{ id: 15, onboarding_status: "approved", expo_push_token: "ExponentPushToken[ssDriver]" }],
        rowCount: 1,
      })
      // 3) existing assignment lookup → none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // 4) INSERT assignment
      .mockResolvedValueOnce({ rows: [{ id: 300 }], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00200/assign-driver")
      .send({ driver_id: 15 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    // SSE broadcast must fire exactly once with the new driver's ID.
    expect(mockDriverSseBroadcast).toHaveBeenCalledOnce();
    expect(mockDriverSseBroadcast).toHaveBeenCalledWith(15);
  });

  it("assign-driver calls SSE broadcast for both the displaced driver and the newly assigned driver on reassignment", async () => {
    mockDbQuery
      // 1) order lookup
      .mockResolvedValueOnce({
        rows: [{ id: "ord-00201", display_order_number: "ORD-201", delivery_address: null }],
        rowCount: 1,
      })
      // 2) new driver lookup (approved, has push token)
      .mockResolvedValueOnce({
        rows: [{ id: 20, onboarding_status: "approved", expo_push_token: "ExponentPushToken[newSse]" }],
        rowCount: 1,
      })
      // 3) existing assignment → assigned to driver 55
      .mockResolvedValueOnce({ rows: [{ id: 600, driver_id: 55 }], rowCount: 1 })
      // 4) UPDATE assignment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 5) displaced driver push token lookup
      .mockResolvedValueOnce({
        rows: [{ expo_push_token: "ExponentPushToken[displacedSse]" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-00201/assign-driver")
      .send({ driver_id: 20 });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    // Wait for fire-and-forget push promises to settle before checking broadcast counts.
    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledTimes(2));

    // SSE broadcast must fire twice: once for the displaced driver, once for the new driver.
    expect(mockDriverSseBroadcast).toHaveBeenCalledTimes(2);
    expect(mockDriverSseBroadcast).toHaveBeenCalledWith(55);
    expect(mockDriverSseBroadcast).toHaveBeenCalledWith(20);
  });

  // ---------------------------------------------------------------------------
  // Admin PATCH /fleet/orders/:id/status — cancellation / return notifications
  // ---------------------------------------------------------------------------

  it("PATCH /api/fleet/orders/:id/status with 'cancelled' sends push notification to assigned driver", async () => {
    mockDbQuery
      // 1) assignment lookup
      .mockResolvedValueOnce({ rows: [{ id: 200, driver_id: 10 }], rowCount: 1 })
      // 2) UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3) INSERT event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 4) driver push token lookup
      .mockResolvedValueOnce({
        rows: [{ expo_push_token: "ExponentPushToken[cancelledDriver]" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-0300/status")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.status).toBe("cancelled");

    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());
    expect(mockSendExpoPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[cancelledDriver]",
      "Delivery cancelled",
      "Your assigned delivery has been cancelled",
      { order_id: "ord-0300", assignment_id: 200 },
    );
  });

  it("PATCH /api/fleet/orders/:id/status with 'returned' sends push notification to assigned driver", async () => {
    mockDbQuery
      // 1) assignment lookup
      .mockResolvedValueOnce({ rows: [{ id: 201, driver_id: 11 }], rowCount: 1 })
      // 2) UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3) INSERT event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 4) driver push token lookup
      .mockResolvedValueOnce({
        rows: [{ expo_push_token: "ExponentPushToken[returnedDriver]" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-0301/status")
      .send({ status: "returned" });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.status).toBe("returned");

    await vi.waitFor(() => expect(mockSendExpoPushNotification).toHaveBeenCalledOnce());
    expect(mockSendExpoPushNotification).toHaveBeenCalledWith(
      "ExponentPushToken[returnedDriver]",
      "Delivery cancelled",
      "Your assigned delivery has been cancelled",
      { order_id: "ord-0301", assignment_id: 201 },
    );
  });

  it("PATCH /api/fleet/orders/:id/status with 'cancelled' does NOT send push when driver has no token", async () => {
    mockDbQuery
      // 1) assignment lookup
      .mockResolvedValueOnce({ rows: [{ id: 202, driver_id: 12 }], rowCount: 1 })
      // 2) UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3) INSERT event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 4) driver push token lookup — no token
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-0302/status")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(mockSendExpoPushNotification).not.toHaveBeenCalled();
  });

  it("PATCH /api/fleet/orders/:id/status with 'delivered' does NOT send any push notification", async () => {
    mockDbQuery
      // 1) assignment lookup
      .mockResolvedValueOnce({ rows: [{ id: 203, driver_id: 13 }], rowCount: 1 })
      // 2) UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3) INSERT event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // No driver push token lookup should be issued for non-cancellation statuses.

    const res = await request(makeApp())
      .patch("/api/fleet/orders/ord-0303/status")
      .send({ status: "delivered" });

    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(mockSendExpoPushNotification).not.toHaveBeenCalled();
  });

  it("GET /api/fleet/orders/:id 404s when missing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp()).get("/api/fleet/orders/123456");
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe("ORDER_NOT_FOUND");
  });

  it("PATCH /api/fleet/drivers/:id returns 409 DUPLICATE_PHONE when phone belongs to another driver", async () => {
    // Duplicate phone check finds another driver with the same phone.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 999 }], rowCount: 1 });
    const res = await request(makeApp())
      .patch("/api/fleet/drivers/5")
      .send({ phone: "+15550001234" });
    expect(res.status).toBe(409);
    expect(res.body?.code).toBe("DUPLICATE_PHONE");
  });

  it("PATCH /api/fleet/drivers/:id allows submitting the driver's own existing phone", async () => {
    // Duplicate phone check finds no other driver (exclusion of self works).
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE returns the updated driver row.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, first_name: "John", last_name: "Doe", phone: "+15550001234" }],
      rowCount: 1,
    });
    const res = await request(makeApp())
      .patch("/api/fleet/drivers/5")
      .send({ phone: "+15550001234" });
    expect(res.status).toBe(200);
    expect(res.body?.driver?.id).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // OTP auth: POST /fleet/auth/send-otp
  // ---------------------------------------------------------------------------

  it("POST /api/fleet/auth/send-otp returns 200 when phone not found (no enumeration)", async () => {
    // Driver lookup returns no rows — endpoint must NOT reveal whether the phone
    // belongs to an approved driver; it always returns success.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp())
      .post("/api/fleet/auth/send-otp")
      .send({ phone: "+9611234567" });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    // No error code must be present.
    expect(res.body?.error).toBeUndefined();
  });

  it("POST /api/fleet/auth/send-otp rejects a rate-limited IP or phone before querying", async () => {
    mockConsumeOtpRateLimit.mockResolvedValueOnce(false);

    const res = await request(makeApp())
      .post("/api/fleet/auth/send-otp")
      .send({ phone: "+9611234567" });

    expect(res.status).toBe(429);
    expect(res.body?.error?.code).toBe("OTP_RATE_LIMITED");
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockConsumeOtpRateLimit).toHaveBeenCalledWith(
      [
        "fleet:send:ip:127.0.0.1",
        "fleet:send:account:+9611234567",
      ],
      { maxRequests: 5, windowMs: 15 * 60 * 1000 },
    );
  });

  it("POST /api/fleet/auth/send-otp returns 429 when an unexpired OTP already exists", async () => {
    // Driver lookup finds a driver.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: "Ali" }],
      rowCount: 1,
    });
    // Rate-limit check finds an existing unexpired OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    const res = await request(makeApp())
      .post("/api/fleet/auth/send-otp")
      .send({ phone: "+9611234567" });
    expect(res.status).toBe(429);
    expect(res.body?.error?.code).toBe("OTP_RATE_LIMITED");
    expect(res.body?.error?.message).toMatch(/already sent recently/i);
  });

  it("POST /api/fleet/auth/send-otp returns 200 in dev mode when Twilio env vars are missing", async () => {
    // Driver lookup finds a driver.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: "Ali" }],
      rowCount: 1,
    });
    // Rate-limit check: no recent OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    // Invalidate old OTPs.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Insert new OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Ensure Twilio env vars are not set and not in production.
    const origSid = process.env.TWILIO_ACCOUNT_SID;
    const origToken = process.env.TWILIO_AUTH_TOKEN;
    const origPhone = process.env.TWILIO_PHONE_NUMBER;
    const origEnv = process.env.NODE_ENV;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    process.env.NODE_ENV = "development";
    try {
      const res = await request(makeApp())
        .post("/api/fleet/auth/send-otp")
        .send({ phone: "+9611234567" });
      expect(res.status).toBe(200);
      expect(res.body?.success).toBe(true);
    } finally {
      if (origSid) process.env.TWILIO_ACCOUNT_SID = origSid;
      if (origToken) process.env.TWILIO_AUTH_TOKEN = origToken;
      if (origPhone) process.env.TWILIO_PHONE_NUMBER = origPhone;
      if (origEnv !== undefined) process.env.NODE_ENV = origEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it("POST /api/fleet/auth/send-otp returns 500 in production when Twilio env vars are missing", async () => {
    // Driver lookup finds a driver.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: "Ali" }],
      rowCount: 1,
    });
    // Rate-limit check: no recent OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    // Invalidate old OTPs.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Insert new OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Simulate production with no Twilio creds.
    const origSid = process.env.TWILIO_ACCOUNT_SID;
    const origToken = process.env.TWILIO_AUTH_TOKEN;
    const origPhone = process.env.TWILIO_PHONE_NUMBER;
    const origEnv = process.env.NODE_ENV;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(makeApp())
        .post("/api/fleet/auth/send-otp")
        .send({ phone: "+9611234567" });
      expect(res.status).toBe(500);
      expect(res.body?.error?.code).toBe("SMS_CONFIG_ERROR");
    } finally {
      if (origSid) process.env.TWILIO_ACCOUNT_SID = origSid;
      if (origToken) process.env.TWILIO_AUTH_TOKEN = origToken;
      if (origPhone) process.env.TWILIO_PHONE_NUMBER = origPhone;
      if (origEnv !== undefined) process.env.NODE_ENV = origEnv;
      else delete process.env.NODE_ENV;
    }
  });

  it("POST /api/fleet/auth/send-otp sends OTP when driver exists and Twilio is configured", async () => {
    // Driver lookup finds a driver.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: "Ali" }],
      rowCount: 1,
    });
    // Rate-limit check: no recent OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });
    // Invalidate old OTPs.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Insert new OTP.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockTwilioCreate.mockResolvedValueOnce({ sid: "SM_test" });
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "authtest";
    process.env.TWILIO_PHONE_NUMBER = "+15005550006";
    try {
      const res = await request(makeApp())
        .post("/api/fleet/auth/send-otp")
        .send({ phone: "+9611234567" });
      expect(res.status).toBe(200);
      expect(res.body?.success).toBe(true);
      expect(mockTwilioCreate).toHaveBeenCalledOnce();
    } finally {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_NUMBER;
    }
  });

  // ---------------------------------------------------------------------------
  // OTP auth: POST /fleet/auth/verify-otp
  // ---------------------------------------------------------------------------

  it("POST /api/fleet/auth/verify-otp returns 401 for invalid or expired code", async () => {
    // OTP lookup returns no rows (bad/expired code).
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(makeApp())
      .post("/api/fleet/auth/verify-otp")
      .send({ phone: "+9611234567", code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe("INVALID_OR_EXPIRED_OTP");
  });

  it("POST /api/fleet/auth/verify-otp rejects a rate-limited IP or phone before querying", async () => {
    mockConsumeOtpRateLimit.mockResolvedValueOnce(false);

    const res = await request(makeApp())
      .post("/api/fleet/auth/verify-otp")
      .send({ phone: "+9611234567", code: "123456" });

    expect(res.status).toBe(429);
    expect(res.body?.error?.code).toBe("OTP_RATE_LIMITED");
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockConsumeOtpRateLimit).toHaveBeenCalledWith(
      [
        "fleet:verify:ip:127.0.0.1",
        "fleet:verify:account:+9611234567",
      ],
      { maxRequests: 10, windowMs: 15 * 60 * 1000 },
    );
  });

  it("POST /api/fleet/auth/verify-otp returns 400 for code with wrong length", async () => {
    const res = await request(makeApp())
      .post("/api/fleet/auth/verify-otp")
      .send({ phone: "+9611234567", code: "12345" }); // only 5 digits
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/fleet/auth/verify-otp returns token for valid OTP flow", async () => {
    const crypto = await import("crypto");
    const correctCodeHash = crypto.createHash("sha256").update("123456").digest("hex");
    // Active OTP lookup by phone only (new brute-force guard step).
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 99, code_hash: correctCodeHash, failed_attempts: 0 }],
      rowCount: 1,
    });
    // Mark used.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Driver lookup.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: "Ali", last_name: "Hassan" }],
      rowCount: 1,
    });
    // issueDriverToken is mocked via driverTokenAuth mock — also calls db.query
    // for UPDATE (revoke) and INSERT (new token).
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // revoke
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // insert token
    const res = await request(makeApp())
      .post("/api/fleet/auth/verify-otp")
      .send({ phone: "+9611234567", code: "123456" });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.token).toBe("fdt_live_testtoken");
    expect(res.body?.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(res.body?.driverId).toBe(1);
    expect(res.body?.driverName).toBe("Ali Hassan");
  });

  // ---------------------------------------------------------------------------
  // Driver bearer token: POST /fleet/me/push-token
  // ---------------------------------------------------------------------------

  it("POST /api/fleet/me/push-token saves a valid Expo push token", async () => {
    // UPDATE returns success.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(makeApp())
      .post("/api/fleet/me/push-token")
      .send({ expo_push_token: "ExponentPushToken[abc123]" });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/expo_push_token/);
  });

  it("POST /api/fleet/me/push-token rejects invalid token format", async () => {
    const res = await request(makeApp())
      .post("/api/fleet/me/push-token")
      .send({ expo_push_token: "not-a-valid-push-token" });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("VALIDATION_ERROR");
  });

  // ---------------------------------------------------------------------------
  // Driver bearer token: GET /fleet/me/transactions
  // ---------------------------------------------------------------------------

  it("GET /api/fleet/me/transactions returns paginated transactions", async () => {
    const txRow = {
      id: "uuid-1",
      driver_id: FAKE_DRIVER_ID,
      type: "earning",
      amount_cents: 5000,
      description: "Delivery bonus",
      order_id: null,
      date: "2026-05-16",
      created_at: new Date().toISOString(),
    };
    // List query.
    mockDbQuery.mockResolvedValueOnce({ rows: [txRow], rowCount: 1 });
    // Count query.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });
    const res = await request(makeApp()).get("/api/fleet/me/transactions");
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(res.body?.transactions).toHaveLength(1);
    expect(res.body?.total).toBe(1);
    expect(res.body?.page).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Admin (Clerk session): POST /fleet/me/transactions
  // ---------------------------------------------------------------------------

  it("POST /api/fleet/me/transactions creates a transaction (owner)", async () => {
    // Driver ownership check.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });
    // INSERT returning id.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: "new-uuid" }], rowCount: 1 });
    const res = await request(makeApp())
      .post("/api/fleet/me/transactions")
      .send({
        driver_id: 7,
        type: "bonus",
        amount_cents: 1000,
        description: "Performance bonus",
        date: "2026-05-16",
      });
    expect(res.status).toBe(201);
    expect(res.body?.success).toBe(true);
    expect(res.body?.id).toBe("new-uuid");
  });

  it("POST /api/fleet/me/transactions returns 400 for invalid type", async () => {
    const res = await request(makeApp())
      .post("/api/fleet/me/transactions")
      .send({
        driver_id: 7,
        type: "invalid_type",
        amount_cents: 1000,
        description: "Test",
        date: "2026-05-16",
      });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe("VALIDATION_ERROR");
  });
});
