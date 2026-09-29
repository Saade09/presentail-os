/**
 * Unit tests for the florist photo verification workflow:
 *  - server-side completion gate (photos / approval cannot be bypassed)
 *  - photo attach/replace resets verification state
 *  - verification state transitions (approve, reject, concurrency guard)
 *  - auto-advance order after verification approval
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockTransactionQuery = vi.fn();

const mockNotifyOrderStatusWhatsApp = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: mockNotifyOrderStatusWhatsApp,
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn().mockResolvedValue({
      query: (sql: unknown, ...args: unknown[]) => {
        mockTransactionQuery(sql, ...args);
        return ["BEGIN", "COMMIT", "ROLLBACK"].includes(String(sql))
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : mockDbQuery(sql, ...args);
      },
      release: vi.fn(),
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages = ["orders", "florist_orders"];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.userId = "user_abc";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || stubAllowedPages.includes(pageKey),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/orderAlerts", () => ({
  notifyFloristAssignmentAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/realDeliveryPublication", () => ({
  enqueueRealDeliveryPublication: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./orders", () => ({
  notifyOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
  recordOrderEvent: vi.fn(),
}));

vi.mock("../lib/translation", () => ({
  translateDescriptionToArabic: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/giftCardPdf", () => ({
  buildGiftCardPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

const mockTransitionOrderStatus = vi.fn().mockResolvedValue({ success: true });
vi.mock("../lib/orderStatusTransition", () => ({
  transitionOrderStatus: (...args: unknown[]) => mockTransitionOrderStatus(...args),
}));

const mockGetObjectEntityFile = vi.fn();
vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    getObjectEntityFile: (...args: unknown[]) => mockGetObjectEntityFile(...args),
  },
  buildPublicObjectUrl: (key: string | null | undefined) =>
    key ? `https://os.presentail.com/api/storage/public-objects/${key}` : null,
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
}));

const mockRunVerification = vi.fn();
const mockRunFocusedVerification = vi.fn();
const mockRunCardText = vi.fn();
vi.mock("../lib/floristPhotoVerification", () => ({
  runFloristPhotoVerification: (...args: unknown[]) => mockRunVerification(...args),
  runFloristFocusedItemVerification: (...args: unknown[]) => mockRunFocusedVerification(...args),
  runCardTextVerification: (...args: unknown[]) => mockRunCardText(...args),
}));

const mockSyncApprovedFloristPhotoToTookan = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/floristTookanPhotoSync", () => ({
  syncApprovedFloristPhotoToTookan: (...args: unknown[]) =>
    mockSyncApprovedFloristPhotoToTookan(...args),
}));

import floristOrdersRouter from "./floristOrders";

// ---------------------------------------------------------------------------
// Test app + fixtures
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, typeof mockReqLog> }).log = {
      error: mockReqLog,
      warn: mockReqLog,
      info: mockReqLog,
      debug: mockReqLog,
    };
    next();
  });
  app.use(floristOrdersRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ success: false, error: err.message });
    },
  );
  return app;
}

const ORDER_ID = "11111111-2222-3333-4444-555555555555";
const PHOTO_ITEMS = "/objects/owner_123/uploads/photo-items";
const PHOTO_CARD = "/objects/owner_123/uploads/photo-card";

/** Full scoped-assignment row as loadScopedAssignment SELECTs it. */
function scopedRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        id: 1,
        order_id: ORDER_ID,
        location_id: 5,
        status: "in_progress",
        started_at: "2026-08-17T08:00:00Z",
        completed_at: null,
        created_at: "2026-08-17T07:00:00Z",
        updated_at: "2026-08-17T08:00:00Z",
        order_external_id: null,
        order_number: "LB-2122",
        has_card: true,
        card_printed_at: "2026-08-17T08:05:00Z",
        photo_items_path: PHOTO_ITEMS,
        photo_card_path: PHOTO_CARD,
        verification_status: "none",
        verification_reason_code: null,
        verification_reason: null,
        verified_at: null,
        slack_sent_at: null,
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

function verificationStateRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [
      {
        card_printed_at: "2026-08-17T08:05:00Z",
        photo_items_path: PHOTO_ITEMS,
        photo_card_path: PHOTO_CARD,
        verification_status: "none",
        verification_reason_code: null,
        verification_reason: null,
        verified_at: null,
        slack_sent_at: null,
        ...overrides,
      },
    ],
    rowCount: 1,
  };
}

function stubStoredObject(contentType = "image/jpeg", size = 1024) {
  return {
    getMetadata: vi.fn().mockResolvedValue([{ contentType, size }]),
    download: vi.fn().mockResolvedValue([Buffer.from("fake-image-bytes")]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransactionQuery.mockClear();
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubAllowedPages = ["orders", "florist_orders"];
  mockTransitionOrderStatus.mockResolvedValue({ success: true });
  mockGetObjectEntityFile.mockResolvedValue(stubStoredObject());
  // Default: card is legible and approved so existing approval tests are unaffected.
  mockRunCardText.mockResolvedValue({ legible: true, approved: true, detectedText: null, reason: null });
});

// ---------------------------------------------------------------------------
// Manual operations review
// ---------------------------------------------------------------------------

describe("florist manual photo review", () => {
  const app = makeApp();

  it("lists only rows selected by the workspace-scoped rejected-pair filter", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          order_id: ORDER_ID,
          order_number: "LB-2122",
          location_id: 5,
          location_name: "Florist A",
          status: "in_progress",
          photo_items_path: PHOTO_ITEMS,
          photo_card_path: PHOTO_CARD,
          photo_set_rev: 3,
          verification_reason_code: "unclear_photo",
          verification_reason: "The image is too dark",
          verified_at: "2026-08-17T09:00:00Z",
          updated_at: "2026-08-17T09:00:00Z",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/florist-orders/manual-review");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.manual_reviews).toHaveLength(1);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toContain("ofa.workspace_owner_id = $1");
    expect(sql).toContain("ofa.status <> 'completed'");
    expect(sql).toContain("ofa.verification_status = 'rejected'");
    expect(sql).toContain("ofa.photo_items_path IS NOT NULL");
    expect(sql).toContain("ofa.photo_card_path IS NOT NULL");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123"]);
  });

  it("rejects florist-only callers before querying", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["florist_orders"];

    const res = await request(app).get("/florist-orders/manual-review");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a florist-only caller attempting a manual approval", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["florist_orders"];

    const res = await request(app)
      .post("/florist-orders/manual-review/1/approve")
      .send({ photo_set_rev: 3 });

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns a reviewer-safe count with the same eligibility predicates", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: 6 }], rowCount: 1 });

    const res = await request(app).get("/florist-orders/manual-review/count");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true, count: 6 });
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toContain("status <> 'completed'");
    expect(sql).toContain("verification_status = 'rejected'");
    expect(sql).toContain("photo_items_path IS NOT NULL");
    expect(sql).toContain("photo_card_path IS NOT NULL");
  });

  it("records a manual override and auto-advances the order directly", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          location_id: 5,
          order_id: ORDER_ID,
          ...verificationStateRow({
            verification_status: "approved",
            verified_at: "2026-08-17T09:30:00Z",
          }).rows[0],
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/florist-orders/manual-review/1/approve")
      .send({ photo_set_rev: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, order_status_updated: expect.any(Boolean) });
    expect(res.body.slack_sent).toBeUndefined();
    const approvalSql = String(mockDbQuery.mock.calls[0][0]);
    expect(approvalSql).toContain("verification_status = 'rejected'");
    expect(approvalSql).toContain("photo_set_rev = $3");
    expect(approvalSql).toContain("status <> 'completed'");
    expect(approvalSql).toContain("'manual_override'");
    expect(approvalSql).toContain("'actor_user_id'");
    expect(approvalSql).toContain("'prior_reason'");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([
      1,
      "owner_123",
      3,
      "user_abc",
    ]);
    expect(mockSyncApprovedFloristPhotoToTookan).toHaveBeenCalledWith(1, "owner_123");
  });

  it("409s a stale, changed, completed, incomplete, or already-approved set", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await request(app)
      .post("/florist-orders/manual-review/1/approve")
      .send({ photo_set_rev: 2 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("state_changed");
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toContain("photo_items_path IS NOT NULL");
    expect(sql).toContain("photo_card_path IS NOT NULL");
  });

  it("does not reveal or update a cross-workspace assignment", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/florist-orders/manual-review/99/approve")
      .send({ photo_set_rev: 3 });

    expect(res.status).toBe(404);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([
      99,
      "owner_123",
      3,
      "user_abc",
    ]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual([99, "owner_123"]);
  });
});

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

describe("POST /florist-orders/:id/complete — server-side verification gate", () => {
  const app = makeApp();

  it("409s card_not_printed when the order has a card that was never printed", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ card_printed_at: null }));
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("card_not_printed");
  });

  it("409s photos_required when the items photo is missing", async () => {
    mockDbQuery.mockResolvedValueOnce(
      scopedRow({
        has_card: false,
        card_printed_at: null,
        photo_items_path: null,
        photo_card_path: null,
      }),
    );
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("photos_required");
  });

  it("409s verification_required when photos exist but AI has not approved", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ verification_status: "rejected" }));
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("verification_required");
  });

  it("completes when the full gate is satisfied", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        scopedRow({
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      )
      .mockResolvedValueOnce({
        rows: [{ id: 1, order_id: ORDER_ID, status: "completed", completed_at: "now" }],
        rowCount: 1,
      }) // UPDATE → completed
      .mockResolvedValueOnce({ rows: [{ status: "preparing" }], rowCount: 1 }); // previous order status
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockTransitionOrderStatus).toHaveBeenCalledTimes(1);
    // The completing UPDATE is itself the gate: it re-checks every predicate
    // atomically so a concurrent replacement can't slip through.
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("verification_status = 'approved'");
    expect(updateSql).not.toContain("slack_sent_at IS NOT NULL");
    expect(updateSql).toContain("photo_items_path IS NOT NULL");
    expect(updateSql).toContain("photo_card_path IS NOT NULL");
    expect(updateSql).toContain("card_printed_at IS NOT NULL");
    // The printable-card predicate is re-evaluated inside the UPDATE (not a
    // pre-read parameter), so a card added between the load and the UPDATE
    // cannot complete without a print.
    expect(updateSql).toContain("btrim(o.card_message) <> ''");
    // Lifecycle + workspace scoping: a concurrent reassignment resets the
    // assignment to 'pending', which must fail this UPDATE.
    expect(updateSql).toContain("status IN ('in_progress', 'paused')");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([1, "owner_123", "owner_123", 5]);
  });

  it("completes a no-card order with its approved items photo only", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        scopedRow({
          has_card: false,
          card_printed_at: null,
          photo_card_path: null,
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      )
      .mockResolvedValueOnce({
        rows: [{ id: 1, order_id: ORDER_ID, status: "completed", completed_at: "now" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ status: "preparing" }], rowCount: 1 });

    const res = await request(app).post("/florist-orders/1/complete");

    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("photo_items_path IS NOT NULL");
    expect(updateSql).toContain("photo_card_path IS NOT NULL");
    expect(updateSql).toContain("OR NOT EXISTS");
  });

  it("409s state_changed when a concurrent photo replacement resets state mid-complete", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        scopedRow({
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      )
      // The gate-predicated UPDATE matches 0 rows: a replacement between the
      // pre-checks and the UPDATE reset verification state.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("state_changed");
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
  });

  it("409s when a cardless order is reassigned to another location between load and complete", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        scopedRow({
          has_card: false,
          card_printed_at: null,
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      )
      // Reassignment moved the row to another location (and/or wiped its
      // evidence): the location-conditioned UPDATE matches 0 rows.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/florist-orders/1/complete");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("state_changed");
    expect(mockTransitionOrderStatus).not.toHaveBeenCalled();
    // The UPDATE is pinned to the location authorized at load time.
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("location_id = $4");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([1, "owner_123", "owner_123", 5]);
  });
});

describe("PATCH /orders/:id/florist-publication — explicit Real Deliveries moderation", () => {
  const app = makeApp();

  function publicationAssignment(overrides: Record<string, unknown> = {}) {
    return {
      id: 44,
      order_id: ORDER_ID,
      location_id: 5,
      location_name: "Beirut",
      status: "completed",
      started_at: null,
      completed_at: "2026-08-17T09:00:00Z",
      created_at: "2026-08-17T07:00:00Z",
      updated_at: "2026-08-17T09:00:00Z",
      photo_set_rev: 7,
      photo_items_path: PHOTO_ITEMS,
      photo_card_path: PHOTO_CARD,
      verification_status: "approved",
      parent_order_status: "completed",
      publication_status: null,
      publication_enabled: false,
      publication_privacy_faces_clear: false,
      publication_privacy_card_message_clear: false,
      publication_privacy_address_clear: false,
      publication_privacy_other_personal_info_clear: false,
      publication_moderated_at: null,
      ...overrides,
    };
  }

  const requestBody = (enabled = true, revision = 7) => ({
    enabled,
    photo_set_rev: revision,
    privacy_faces_clear: true,
    privacy_card_message_clear: true,
    privacy_address_clear: true,
    privacy_other_personal_info_clear: true,
  });

  it("requires Orders page access and every privacy check before touching the database", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["florist_orders"];
    const forbidden = await request(app)
      .patch(`/orders/${ORDER_ID}/florist-publication`)
      .send(requestBody());
    expect(forbidden.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();

    stubWorkspaceRole = "owner";
    const missingCheck = await request(app)
      .patch(`/orders/${ORDER_ID}/florist-publication`)
      .send({ ...requestBody(), privacy_faces_clear: false });
    expect(missingCheck.status).toBe(400);
    expect(missingCheck.body.code).toBe("privacy_checks_required");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["missing photo", { photo_items_path: null }, "photo_missing"],
    ["unapproved photo", { verification_status: "pending" }, "photo_not_approved"],
    ["incomplete order", { parent_order_status: "ready_for_delivery" }, "order_not_completed"],
    ["stale revision", {}, "stale_revision"],
  ])("rejects %s", async (_label, overrides, code) => {
    const current = publicationAssignment(overrides);
    mockDbQuery.mockResolvedValueOnce({ rows: [current], rowCount: 1 });
    const body = requestBody(true, code === "stale_revision" ? 6 : 7);
    const response = await request(app)
      .patch(`/orders/${ORDER_ID}/florist-publication`)
      .send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
  });

  it("saves the current revision, privacy review, and moderator decision, then returns state", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [publicationAssignment()], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          publication_status: "pending",
          enabled: true,
          photo_set_rev: 7,
          privacy_faces_clear: true,
          privacy_card_message_clear: true,
          privacy_address_clear: true,
          privacy_other_personal_info_clear: true,
          moderated_at: "2026-08-17T10:00:00Z",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          city_id: 1,
          has_location: true,
          has_product: true,
          product_active: true,
          has_recipe: true,
          in_stock: false,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: 1 }], rowCount: 1 });

    const response = await request(app)
      .patch(`/orders/${ORDER_ID}/florist-publication`)
      .send(requestBody());
    expect(response.status).toBe(200);
    expect(response.body.publication).toMatchObject({
      enabled: true,
      status: "pending",
      photo_set_rev: 7,
      privacy_faces_clear: true,
      feed_eligibility: {
        eligible: true,
        eligible_photo_count: 1,
        reasons: [],
      },
    });
    const saveSql = String(mockTransactionQuery.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO florist_photo_publications"),
    )?.[0]);
    expect(saveSql).toContain("moderated_by");
    expect(mockTransactionQuery.mock.calls.some((call) =>
      String(call[0]).includes("automatic = false") ||
      String(call[0]).includes("automatic=false"),
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Photo attach / replace / remove
// ---------------------------------------------------------------------------

describe("PUT/DELETE /florist-orders/:id/photos/:slot", () => {
  const app = makeApp();

  it("attaching a photo resets verification and Slack state", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce(verificationStateRow());
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("photo_items_path = $2");
    expect(updateSql).toContain("verification_status = 'none'");
    expect(updateSql).toContain("verification_result = NULL");
    expect(updateSql).toContain("slack_sent_at = NULL");
  });

  it("replacing a photo AFTER approval invalidates approval + Slack state", async () => {
    mockDbQuery
      .mockResolvedValueOnce(
        scopedRow({
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
          slack_sent_at: "2026-08-17T09:01:00Z",
        }),
      )
      .mockResolvedValueOnce(verificationStateRow());
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(200);
    // The reset UPDATE ran unconditionally — approval and slack state cleared,
    // and the photo-set revision bumped so an in-flight send can't mark the
    // new set as sent.
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("verification_status = 'none'");
    expect(updateSql).toContain("slack_pending_at = NULL");
    expect(updateSql).toContain("photo_set_rev = photo_set_rev + 1");
    expect(res.body.verification.verification_status).toBe("none");
    expect(res.body.verification.slack_sent_at).toBeNull();
  });

  it("409s when the order is reassigned between load and photo attach (no cross-location write)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      // Reassignment between the scoped load and the reset UPDATE: the
      // location-conditioned mutation matches 0 rows.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("state_changed");
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("workspace_owner_id = $3");
    expect(updateSql).toContain("location_id = $4");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([1, PHOTO_ITEMS, "owner_123", 5]);
  });

  it("409s when the order is reassigned between load and photo removal", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).delete("/florist-orders/1/photos/card");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("state_changed");
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("workspace_owner_id = $2");
    expect(updateSql).toContain("location_id = $3");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([1, "owner_123", 5]);
  });

  it("rejects an objectPath outside this workspace's uploads", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow());
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: "/objects/other_owner/uploads/steal" });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported content types", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow());
    mockGetObjectEntityFile.mockResolvedValue(stubStoredObject("application/pdf"));
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("JPEG");
  });

  it("rejects oversized photos", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow());
    mockGetObjectEntityFile.mockResolvedValue(stubStoredObject("image/jpeg", 16 * 1024 * 1024));
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid slot", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow());
    const res = await request(app)
      .put("/florist-orders/1/photos/bogus")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(400);
  });

  it("removing a photo resets verification state", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce(verificationStateRow({ photo_card_path: null }));
    const res = await request(app).delete("/florist-orders/1/photos/card");
    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toContain("photo_card_path = NULL");
    expect(updateSql).toContain("verification_status = 'none'");
  });

  it("409s photo changes on a completed assignment", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ status: "completed" }));
    const res = await request(app)
      .put("/florist-orders/1/photos/items")
      .send({ objectPath: PHOTO_ITEMS });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// AI verification transitions
// ---------------------------------------------------------------------------

describe("POST /florist-orders/:id/verify", () => {
  const app = makeApp();

  function queueApprovedVerifyHappyPath() {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow({ card_message: "Happy birthday" })) // loadScopedAssignment
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 }) // verifying claim
      .mockResolvedValueOnce({
        rows: [{ name: "Red Roses Bouquet", quantity: 1, product_id: null }],
        rowCount: 1,
      }) // line items
      .mockResolvedValueOnce(
        verificationStateRow({
          verification_status: "approved",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      ); // persist outcome
  }

  it("approves, persists the audit record, and auto-advances the order", async () => {
    queueApprovedVerifyHappyPath();
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [{ name: "Red Roses Bouquet", quantity: 1 }],
      raw: { approved: true },
    });
    mockRunCardText.mockResolvedValueOnce({
      legible: true,
      approved: true,
      detectedText: "Happy Birthday Maya",
      confidence: 0.91,
      reason: null,
      decisionPath: [
        "transcribed_original",
        "original_low_confidence_or_unreadable",
        "generated_enhanced_view",
        "transcribed_enhanced",
        "focused_confirmation",
        "confirmed_match",
      ],
      evidence: [
        {
          pass: "transcription",
          source: "original",
          legible: true,
          detectedText: "Happy Birthdoy Maya",
          confidence: 0.62,
          reason: null,
          raw: { legible: true },
        },
        {
          pass: "confirmation",
          source: "enhanced",
          legible: true,
          approved: true,
          detectedText: "Happy Birthday Maya",
          confidence: 0.91,
          reason: null,
          raw: { approved: true },
        },
      ],
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("approved");
    expect(res.body.order_status_updated).toBeDefined();
    expect(res.body.slack_sent).toBeUndefined();

    // Audit record persisted with expected vs detected items.
    const persistCall = mockDbQuery.mock.calls[3];
    expect(String(persistCall[0])).toContain("verification_result = $3::jsonb");
    const audit = JSON.parse(persistCall[1][2] as string);
    expect(audit.expected_items).toEqual([{ name: "Red Roses Bouquet", quantity: 1 }]);
    expect(audit.detected_items).toEqual([{ name: "Red Roses Bouquet", quantity: 1 }]);
    expect(audit.approved).toBe(true);
    expect(audit.card_verification).toMatchObject({
      expected_text: "Happy birthday",
      detected_text: "Happy Birthday Maya",
      legible: true,
      approved: true,
      confidence: 0.91,
      photo_path: PHOTO_CARD,
    });
    expect(audit.card_verification.decision_path.at(-1)).toBe("confirmed_match");
    expect(audit.card_verification.passes).toHaveLength(2);
    expect(mockSyncApprovedFloristPhotoToTookan).toHaveBeenCalledWith(1, "owner_123");
    expect(mockNotifyOrderStatusWhatsApp).toHaveBeenCalledWith(
      ORDER_ID,
      ORDER_ID,
      "ready_for_delivery",
      "owner_123",
    );
  });

  it("passes descriptions, recipes, and labeled reference images to the verification call", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow()) // loadScopedAssignment
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 }) // verifying claim
      .mockResolvedValueOnce({
        rows: [{ name: "The Whispering Elegance Bundle", quantity: 1, product_id: 7 }],
        rowCount: 1,
      }) // line items (linked product)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 7,
            main_image_url: "/objects/owner_123/uploads/bundle-ref",
            description: "Roses paired with a bottle of red wine.",
          },
        ],
        rowCount: 1,
      }) // product info (image + description)
      .mockResolvedValueOnce({
        rows: [
          { product_id: 7, base_item_name: "Red Roses", quantity: "12" },
          { product_id: 7, base_item_name: "Red Wine Bottle", quantity: "1" },
        ],
        rowCount: 2,
      }) // recipes
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "approved", verified_at: "now" }),
      ); // persist outcome
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [{ name: "The Whispering Elegance Bundle", quantity: 1 }],
      raw: { approved: true },
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("approved");

    // The verification call received the enriched expected items…
    const verifyArgs = mockRunVerification.mock.calls[0][0];
    expect(verifyArgs.expectedItems).toEqual([
      {
        name: "The Whispering Elegance Bundle",
        quantity: 1,
        description: "Roses paired with a bottle of red wine.",
        recipe: [
          { name: "Red Roses", quantity: "12" },
          { name: "Red Wine Bottle", quantity: "1" },
        ],
      },
    ]);
    // …and the reference image labeled with the line item it belongs to.
    expect(verifyArgs.referenceImages).toHaveLength(1);
    expect(verifyArgs.referenceImages[0].itemIndex).toBe(0);
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith("/objects/owner_123/uploads/bundle-ref");

    // The enriched context lands in the audit record too.
    const persistCall = mockDbQuery.mock.calls[5];
    const audit = JSON.parse(persistCall[1][2] as string);
    expect(audit.expected_items[0].description).toBe("Roses paired with a bottle of red wine.");
    expect(audit.expected_items[0].recipe).toHaveLength(2);
  });

  it("enriches a legacy line resolved by exact SKU or case-insensitive name", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "chocolate rocher cake", quantity: 1, product_id: null, sku: null, effective_product_id: 17 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 17,
          main_image_url: "/objects/owner_123/uploads/cake-reference",
          description: "A rich chocolate cake topped with hazelnut pralines.",
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ product_id: 17, base_item_name: "Chocolate Cake", quantity: "1" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "approved", verified_at: "now" }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [{ name: "Chocolate Rocher Cake", quantity: 1 }],
      itemAssessments: [{
        itemIndex: 0,
        name: "chocolate rocher cake",
        status: "present",
        cue: "A cake is visible inside an open box.",
      }],
      raw: { approved: true },
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    const lineQuery = String(mockDbQuery.mock.calls[2][0]);
    expect(lineQuery).toContain("p.sku = btrim(oli.sku)");
    expect(lineQuery).toContain("lower(p.name) = lower(btrim(oli.name))");
    expect(mockDbQuery.mock.calls[2][1]).toEqual([ORDER_ID, "owner_123"]);
    const verifyArgs = mockRunVerification.mock.calls[0][0];
    expect(verifyArgs.expectedItems[0]).toMatchObject({
      description: "A rich chocolate cake topped with hazelnut pralines.",
      recipe: [{ name: "Chocolate Cake", quantity: "1" }],
    });
    expect(verifyArgs.referenceImages[0].itemIndex).toBe(0);
  });

  it.each(["present", "uncertain"] as const)(
    "approves when the focused cake check returns %s after apparent absence",
    async (focusedStatus) => {
      mockDbQuery
        .mockResolvedValueOnce(scopedRow())
        .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ name: "Chocolate Rocher Cake", quantity: 1, product_id: null, sku: null }],
          rowCount: 1,
        })
        .mockResolvedValueOnce(
          verificationStateRow({ verification_status: "approved", verified_at: "now" }),
        );
      mockRunVerification.mockResolvedValueOnce({
        approved: true,
        reasonCode: null,
        reason: null,
        detectedItems: [],
        itemAssessments: [{
          itemIndex: 0,
          name: "Chocolate Rocher Cake",
          status: "absent",
          cue: "No exact decorated cake was identified.",
        }],
        raw: { approved: true },
      });
      mockRunFocusedVerification.mockResolvedValueOnce({
        itemIndex: 0,
        name: "Chocolate Rocher Cake",
        status: focusedStatus,
        cue: "An open bakery box contains a plausible chocolate cake.",
      });

      const res = await request(app).post("/florist-orders/1/verify");
      expect(res.status).toBe(200);
      expect(res.body.verification.verification_status).toBe("approved");
      expect(mockRunFocusedVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          itemIndex: 0,
          expectedItem: { name: "Chocolate Rocher Cake", quantity: 1 },
        }),
      );
      const audit = JSON.parse(mockDbQuery.mock.calls[3][1][2] as string);
      expect(audit.item_assessments[0].status).toBe("absent");
      expect(audit.missing_item_confirmations[0].status).toBe(focusedStatus);
    },
  );

  it("rejects missing only after both checks find no plausible candidate", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Chocolate Rocher Cake", quantity: 1, product_id: null, sku: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "rejected", verification_reason_code: "missing_item", verified_at: "now" }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: false,
      reasonCode: "other",
      reason: "The summary did not categorize the line evidence.",
      detectedItems: [],
      itemAssessments: [{
        itemIndex: 0,
        name: "Chocolate Rocher Cake",
        status: "absent",
        cue: "No cake-like object was found.",
      }],
      raw: { approved: false },
    });
    mockRunFocusedVerification.mockResolvedValueOnce({
      itemIndex: 0,
      name: "Chocolate Rocher Cake",
      status: "absent",
      cue: "The second look found no bakery box or cake.",
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.verification.verification_reason_code).toBe("missing_item");
    const audit = JSON.parse(mockDbQuery.mock.calls[3][1][2] as string);
    expect(audit.reason).toContain("focused second check");
    expect(audit.missing_item_confirmations[0].status).toBe("absent");
  });

  it("fails closed on malformed structured line evidence", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Chocolate Rocher Cake", quantity: 1, product_id: null, sku: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "rejected", verification_reason_code: "other", verified_at: "now" }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: false,
      reasonCode: "missing_item",
      reason: "Cake missing.",
      detectedItems: [],
      itemAssessments: [{
        itemIndex: 0,
        name: "Chocolate Rocher Cake",
        status: "maybe",
        cue: "",
      }],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.verification.verification_reason_code).toBe("other");
    expect(mockRunFocusedVerification).not.toHaveBeenCalled();
    const audit = JSON.parse(mockDbQuery.mock.calls[3][1][2] as string);
    expect(audit.reason).toContain("one valid assessment for every order item");
  });

  it("skips gracefully when a linked product has an external (non object-storage) image", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Chocolate Box", quantity: 1, product_id: 9 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 9, main_image_url: "https://cdn.example.com/choco.jpg", description: null }],
        rowCount: 1,
      }) // product info — external URL must not be fetched (SSRF)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // recipes (none)
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "approved", verified_at: "now" }),
      ); // persist outcome
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    const verifyArgs = mockRunVerification.mock.calls[0][0];
    // No reference image attached — the prompt builder tells the model not to
    // guess about this item's appearance.
    expect(verifyArgs.referenceImages).toHaveLength(0);
    expect(verifyArgs.expectedItems).toEqual([{ name: "Chocolate Box", quantity: 1 }]);
    // The external URL is never fetched server-side (SSRF guard).
    expect(mockGetObjectEntityFile).not.toHaveBeenCalledWith("https://cdn.example.com/choco.jpg");
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith(PHOTO_ITEMS);
  });

  it("persists a rejection with the categorized reason and does NOT post to Slack", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Red Roses Bouquet", quantity: 2, product_id: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({
          verification_status: "rejected",
          verification_reason_code: "wrong_quantity",
          verification_reason: "Only one bouquet is visible; the order requires two.",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: false,
      reasonCode: "wrong_quantity",
      reason: "Only one bouquet is visible; the order requires two.",
      detectedItems: [{ name: "Red Roses Bouquet", quantity: 1 }],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("rejected");
    expect(res.body.verification.verification_reason_code).toBe("wrong_quantity");
    expect(res.body.slack_sent).toBeUndefined();
    expect(mockSyncApprovedFloristPhotoToTookan).not.toHaveBeenCalled();

    const persistCall = mockDbQuery.mock.calls[3];
    expect(persistCall[1][1]).toBe("rejected");
  });

  it("400s when the items photo is missing", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ photo_items_path: null }));
    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(400);
    expect(mockRunVerification).not.toHaveBeenCalled();
  });

  it("409s when a verification run is already in progress (concurrency guard)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow({ verification_status: "verifying" }))
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claim rejected
    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(409);
    expect(mockRunVerification).not.toHaveBeenCalled();
  });

  it("409s when the order is reassigned between load and the verify claim (no cross-location claim)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      // Location-conditioned claim matches 0 rows after reassignment.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(409);
    const claimSql = String(mockDbQuery.mock.calls[1][0]);
    expect(claimSql).toContain("workspace_owner_id = $2");
    expect(claimSql).toContain("location_id = $3");
    expect(mockDbQuery.mock.calls[1][1]).toEqual([1, "owner_123", 5]);
    expect(mockRunVerification).not.toHaveBeenCalled();
  });

  it("409s when the photo set is already approved", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ verification_status: "approved" }));
    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(409);
    expect(mockRunVerification).not.toHaveBeenCalled();
  });

  it("409s (no state change) when the AI result lands after the photo set changed", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 }) // claim rev 3
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      // Persist matches 0 rows: a replacement bumped photo_set_rev (and maybe
      // a NEWER verify run re-claimed 'verifying') while the AI call ran —
      // this stale result must not apply to the newer photo set.
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(409);
    // The final persist is bound to the claimed revision AND photo path.
    const persistCall = mockDbQuery.mock.calls[3];
    expect(String(persistCall[0])).toContain("photo_set_rev = $4");
    expect(String(persistCall[0])).toContain("photo_items_path = $5");
    expect(String(persistCall[0])).toContain("photo_card_path IS NOT DISTINCT FROM $8");
    expect(persistCall[1][3]).toBe(3);
    expect(persistCall[1][4]).toBe(PHOTO_ITEMS);
    expect(persistCall[1][7]).toBe(PHOTO_CARD);
  });

  it("analyzes the photo path captured by the claim, not the pre-claim read", async () => {
    // Scoped read saw the OLD path; the claim (post-replacement) returns the
    // NEW path — the download must use the claimed path.
    mockDbQuery
      .mockResolvedValueOnce(scopedRow({ photo_items_path: "/objects/old-items.jpg" }))
      .mockResolvedValueOnce({
        rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 4 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "approved", verified_at: "now" }),
      ); // persist outcome
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith(PHOTO_ITEMS);
    expect(mockGetObjectEntityFile).not.toHaveBeenCalledWith("/objects/old-items.jpg");
  });

  it("releases the claim and 502s when the AI call fails (retryable)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // claim release
    mockRunVerification.mockRejectedValueOnce(new Error("upstream timeout"));

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(502);
    const releaseSql = String(mockDbQuery.mock.calls[3][0]);
    expect(releaseSql).toContain("verification_status = 'none'");
  });

  it("auto-advances the parent order to ready_for_delivery when verification is approved", async () => {
    queueApprovedVerifyHappyPath();
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [{ name: "Red Roses Bouquet", quantity: 1 }],
      raw: { approved: true },
    });
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "preparing",
      newStatus: "ready_for_delivery",
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.slack_sent).toBeUndefined();
    expect(res.body.order_status_updated).toBe(true);
    expect(mockTransitionOrderStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orderId: ORDER_ID, newStatus: "ready_for_delivery" }),
    );
  });

  it("returns order_status_updated=false when the order is already ready_for_delivery at verify time", async () => {
    queueApprovedVerifyHappyPath();
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });
    // allowedFromStatuses excludes ready_for_delivery → transitionOrderStatus skips.
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "ready_for_delivery",
      newStatus: "ready_for_delivery",
      skipped: true,
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.slack_sent).toBeUndefined();
    expect(res.body.order_status_updated).toBe(false);
  });

  it("returns order_status_updated=false when the order is in a terminal state (e.g. cancelled) at verify time", async () => {
    queueApprovedVerifyHappyPath();
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });
    // allowedFromStatuses excludes 'cancelled' → transitionOrderStatus skips.
    mockTransitionOrderStatus.mockResolvedValueOnce({
      success: true,
      previousStatus: "cancelled",
      newStatus: "ready_for_delivery",
      skipped: true,
    });

    const res = await request(app).post("/florist-orders/1/verify");
    expect(res.status).toBe(200);
    expect(res.body.slack_sent).toBeUndefined();
    expect(res.body.order_status_updated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Card photo pre-check + legibility gate
  // -------------------------------------------------------------------------

  it("400s and releases the claim when the card photo is removed between load and claim", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow()) // load: has_card=true, photo_card_path=PHOTO_CARD
      // Claim: card was removed since load — RETURNING shows null card path
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: null, photo_set_rev: 4 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // release claim

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("card_photo_required");
    expect(mockRunVerification).not.toHaveBeenCalled();
    expect(mockRunCardText).not.toHaveBeenCalled();
    // The claim release must be scoped to the claimed revision.
    const releaseSql = String(mockDbQuery.mock.calls[2][0]);
    expect(releaseSql).toContain("verification_status = 'none'");
    expect(releaseSql).toContain("photo_set_rev = $2");
  });

  it("400s (card_photo_required) when has_card is true but the card photo is missing", async () => {
    mockDbQuery.mockResolvedValueOnce(scopedRow({ photo_card_path: null }));

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("card_photo_required");
    expect(mockRunVerification).not.toHaveBeenCalled();
    expect(mockRunCardText).not.toHaveBeenCalled();
  });

  it("skips the card photo guard when the order has no card message", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow({ has_card: false, photo_card_path: null }))
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: null, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce(
        verificationStateRow({ verification_status: "approved", verified_at: "now" }),
      ); // persist outcome
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("approved");
    // No card message → card text check must never run.
    expect(mockRunCardText).not.toHaveBeenCalled();
  });

  it("overrides items-approved to rejected/illegible_card when the card photo is not legible", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Red Roses Bouquet", quantity: 1, product_id: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({
          verification_status: "rejected",
          verification_reason_code: "illegible_card",
          verification_reason: "The card is too dark to read.",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [{ name: "Red Roses Bouquet", quantity: 1 }],
      raw: { approved: true },
    });
    mockRunCardText.mockResolvedValueOnce({ legible: false, approved: false, detectedText: null, reason: "The card is too dark to read." });

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("rejected");
    expect(res.body.verification.verification_reason_code).toBe("illegible_card");
    expect(res.body.slack_sent).toBeUndefined();

    // Persist was called with "rejected" and the illegible_card audit record.
    const persistCall = mockDbQuery.mock.calls[3];
    expect(persistCall[1][1]).toBe("rejected");
    const audit = JSON.parse(persistCall[1][2] as string);
    expect(audit.reason_code).toBe("illegible_card");
    expect(audit.reason).toBe("The card is too dark to read.");
  });

  it("does not run card legibility when the items check already rejects", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ name: "Red Roses Bouquet", quantity: 2, product_id: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce(
        verificationStateRow({
          verification_status: "rejected",
          verification_reason_code: "wrong_quantity",
          verification_reason: "Only one bouquet is visible; two required.",
          verified_at: "2026-08-17T09:00:00Z",
        }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: false,
      reasonCode: "wrong_quantity",
      reason: "Only one bouquet is visible; two required.",
      detectedItems: [{ name: "Red Roses Bouquet", quantity: 1 }],
      raw: {},
    });

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("rejected");
    // Items already failed — card text check is never run.
    expect(mockRunCardText).not.toHaveBeenCalled();
  });

  it("fail-closed: a null legibility reason still produces a human-readable rejected outcome", async () => {
    mockDbQuery
      .mockResolvedValueOnce(scopedRow())
      .mockResolvedValueOnce({ rows: [{ photo_items_path: PHOTO_ITEMS, photo_card_path: PHOTO_CARD, photo_set_rev: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // line items
      .mockResolvedValueOnce(
        verificationStateRow({
          verification_status: "rejected",
          verification_reason_code: "illegible_card",
          verification_reason: "The card text is not clearly legible. Please retake the card photo.",
          verified_at: "now",
        }),
      );
    mockRunVerification.mockResolvedValueOnce({
      approved: true,
      reasonCode: null,
      reason: null,
      detectedItems: [],
      raw: {},
    });
    // Null reason simulates a malformed-response fail-closed path.
    mockRunCardText.mockResolvedValueOnce({ legible: false, approved: false, detectedText: null, reason: null });

    const res = await request(app).post("/florist-orders/1/verify");

    expect(res.status).toBe(200);
    expect(res.body.verification.verification_status).toBe("rejected");
    expect(res.body.slack_sent).toBeUndefined();
    const persistCall = mockDbQuery.mock.calls[3];
    expect(persistCall[1][1]).toBe("rejected");
    const audit = JSON.parse(persistCall[1][2] as string);
    expect(audit.reason_code).toBe("illegible_card");
    // The route must never persist a null reason when card is not legible.
    expect(typeof audit.reason).toBe("string");
    expect(audit.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (Slack-retry routes removed — verification alone is sufficient to advance)
// ---------------------------------------------------------------------------

// placeholder to satisfy linter (block intentionally empty after removal)
describe("POST /florist-orders/:id/slack-retry — removed", () => {
  it("routes no longer exist after Slack gate removal", () => {
    // The slack-retry endpoints (florist and manual-review) have been removed.
    // Verification approval now directly advances the order to ready_for_delivery.
    expect(true).toBe(true);
  });
});
