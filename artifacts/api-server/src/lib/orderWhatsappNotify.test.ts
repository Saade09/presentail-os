import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLeaseQuery = vi.fn();
const mockLeaseRelease = vi.fn();
vi.mock("./db", () => ({
  db: {
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: (...args: unknown[]) => mockLeaseQuery(...args),
      release: mockLeaseRelease,
    })),
  },
}));
vi.mock("./respondio", () => ({
  isRespondIoEnabled: vi.fn(() => true),
  findOrCreateContactByPhone: vi.fn(),
  sendWhatsAppTemplateToContact: vi.fn(),
  normalizePhone: (phone: string) => phone,
  isStrictE164: (phone: string) => /^\+[1-9]\d{1,14}$/.test(phone),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockCopyPrivateObjectToPublic =
  vi.fn<(sourcePath: string, destinationPath: string, workspaceOwnerId: string) => Promise<string>>();
vi.mock("./objectStorage", () => ({
  buildPublicObjectUrl: vi.fn((path: string | null) =>
    path ? `https://os.presentail.com/api/storage/public-objects/${path}` : null,
  ),
  objectStorageService: {
    copyPrivateObjectToPublic: (...args: [string, string, string]) =>
      mockCopyPrivateObjectToPublic(...args),
  },
}));
vi.mock("./orderInvoicePdf", () => ({
  isWhishPayment: (method: string | null, provider: string | null) =>
    [method, provider].some((value) => value?.trim().toLowerCase() === "whish"),
}));
vi.mock("./orderComms", () => ({
  recordCommActivityEvent: vi.fn().mockResolvedValue(undefined),
  trackOrderWhatsApp: vi.fn(async (_opts: unknown, sendFn?: () => Promise<unknown>) =>
    sendFn ? sendFn() : null,
  ),
}));

import { db } from "./db";
import {
  isRespondIoEnabled,
  findOrCreateContactByPhone,
  sendWhatsAppTemplateToContact,
} from "./respondio";
import { recordCommActivityEvent, trackOrderWhatsApp } from "./orderComms";
import { RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS } from "./respondioOrderTemplates";
import { buildOrderPaymentTemplateSendOptions } from "./respondioOrderTemplates";
import {
  notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions,
} from "./orderWhatsappNotify";
import {
  enqueueDeliveredWhatsappNotification,
  processDeliveredNotification,
  runDeliveredWhatsappSweep,
  backoffMinutesForDeliveredAttempt,
  MAX_DELIVERED_WHATSAPP_ATTEMPTS,
} from "./deliveredWhatsappJob";

const mockQuery = vi.mocked(db.query);
const mockEnabled = vi.mocked(isRespondIoEnabled);
const mockFindOrCreate = vi.mocked(findOrCreateContactByPhone);
const mockSend = vi.mocked(sendWhatsAppTemplateToContact);
const mockRecordActivity = vi.mocked(recordCommActivityEvent);
const mockTrackWhatsApp = vi.mocked(trackOrderWhatsApp);

const CONTACT = {
  id: "c1",
  phone: "+96170123456",
  whatsapp_consent: true,
  unsubscribed_at: null,
  first_name: "Rana",
  last_name: "K",
  display_name: "Rana K",
  respondio_contact_id: "rio-9",
};

/** Branded per-event header images (public bucket, auth-free for Meta). */
const IMG_BASE = "https://os.presentail.com/api/storage/public-objects/whatsapp";
const IMG_RECEIVED = `${IMG_BASE}/new-order-received.png`;
const IMG_READY = `${IMG_BASE}/order-ready.png`;
const IMG_DELIVERED = `${IMG_BASE}/order-delivered.png`;

const WINDOW = {
  rows: [{ window_start: "2026-08-20T16:00:00.000Z", window_end: "2026-08-20T19:00:00.000Z" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("RESPONDIO_CHANNEL_ID", "17");
  mockEnabled.mockReturnValue(true);
  mockSend.mockResolvedValue({ ok: true, providerRef: "m1" });
  mockLeaseQuery.mockImplementation(async (sql: string) =>
    sql.includes("SELECT 1")
      ? { rows: [{ "?column?": 1 }], rowCount: 1 }
      : { rows: [], rowCount: null },
  );
});
afterEach(() => vi.restoreAllMocks());

describe("notifyOrderStatusWhatsApp", () => {
  // ── early exits ───────────────────────────────────────────────────────────

  it("records an unavailable attempt when respond.io is not configured", async () => {
    mockEnabled.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockTrackWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "Respond.io is not configured" }),
    );
  });

  it("no-ops for statuses without a mapped template", async () => {
    await notifyOrderStatusWhatsApp("o1", "1001", "out_for_delivery", "w1");
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records a skip when no linked opted-in customer contact exists", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("c.whatsapp_consent");
    expect(sql).toContain("oc.role = 'customer'");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockTrackWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "No linked customer contact is available" }),
    );
  });

  // ── ready_for_delivery ────────────────────────────────────────────────────

  it("sends order_ready with first name, order number, and the branded ready header image", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
      bodyParameters: ["Rana", "1001"],
      channelId: 17,
      headerImageUrl: IMG_READY,
    }));
  });

  it("uses the RESPONDIO_IMG_ORDER_READY env override when set", async () => {
    vi.stubEnv("RESPONDIO_IMG_ORDER_READY", "https://brand.example.com/ready.jpg");
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      headerImageUrl: "https://brand.example.com/ready.jpg",
    }));
  });

  it("uses the florist items photo as the header when an approved assignment exists", async () => {
    const FLORIST_PHOTO_PATH = "/objects/w1/uploads/florist-uuid";
    const FLORIST_PUBLIC_KEY = "whatsapp-order-ready/w1/o1/rev-7.jpg";
    const FLORIST_PUBLIC_URL = `https://os.presentail.com/api/storage/public-objects/${FLORIST_PUBLIC_KEY}`;

    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)                               // contact
      .mockResolvedValueOnce({
        rows: [{ id: 41, photo_items_path: FLORIST_PHOTO_PATH, photo_set_rev: 7 }],
      } as never); // assignment
    mockCopyPrivateObjectToPublic.mockResolvedValueOnce(FLORIST_PUBLIC_KEY);

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockCopyPrivateObjectToPublic).toHaveBeenCalledWith(
      FLORIST_PHOTO_PATH,
      "whatsapp-order-ready/w1/o1/rev-7",
      "w1",
    );
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
      bodyParameters: ["Rana", "1001"],
      headerImageUrl: FLORIST_PUBLIC_URL,
    }));
    expect(mockLeaseQuery).toHaveBeenCalledWith(
      expect.stringContaining("FOR SHARE"),
      [41, "o1", "w1", FLORIST_PHOTO_PATH, 7],
    );
    expect(mockLeaseQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it("falls back to the static header image when no approved florist assignment exists", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)   // contact
      .mockResolvedValueOnce({ rows: [] } as never);          // assignment — none found

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockCopyPrivateObjectToPublic).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      headerImageUrl: IMG_READY,
    }));
  });

  it("falls back to the static header image when the florist photo copy fails", async () => {
    const FLORIST_PHOTO_PATH = "/objects/w1/uploads/florist-uuid";

    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 41, photo_items_path: FLORIST_PHOTO_PATH, photo_set_rev: 7 }],
      } as never);
    mockCopyPrivateObjectToPublic.mockRejectedValueOnce(new Error("storage unavailable"));

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockCopyPrivateObjectToPublic).toHaveBeenCalled();
    // Send must not be blocked — the static fallback is used instead
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      headerImageUrl: IMG_READY,
    }));
  });

  it("falls back to the static ready header when the approved photo is replaced during publication", async () => {
    const floristPhotoPath = "/objects/w1/uploads/florist-replaced";
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 42, photo_items_path: floristPhotoPath, photo_set_rev: 8 }],
      } as never);
    mockCopyPrivateObjectToPublic.mockResolvedValueOnce(
      "whatsapp-order-ready/w1/o1/rev-8.jpg",
    );
    mockLeaseQuery.mockImplementation(async (sql: string) =>
      sql.includes("SELECT 1")
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: null },
    );

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockLeaseQuery).toHaveBeenCalledWith(
      expect.stringContaining("FOR SHARE"),
      [42, "o1", "w1", floristPhotoPath, 8],
    );
    expect(mockLeaseQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      "rio-9",
      expect.objectContaining({ headerImageUrl: IMG_READY }),
    );
  });

  it("releases the ready-photo lease after a provider failure", async () => {
    const floristPhotoPath = "/objects/w1/uploads/florist-provider-failure";
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 44, photo_items_path: floristPhotoPath, photo_set_rev: 9 }],
      } as never);
    mockCopyPrivateObjectToPublic.mockResolvedValueOnce(
      "whatsapp-order-ready/w1/o1/rev-9.jpg",
    );
    mockSend.mockResolvedValueOnce({
      ok: false,
      retryable: true,
      errorCode: "network_error",
      errorMessage: "timed out",
    });

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockLeaseQuery).toHaveBeenCalledWith(
      "SET LOCAL idle_in_transaction_session_timeout = '20s'",
    );
    expect(mockLeaseQuery).toHaveBeenLastCalledWith("COMMIT");
    expect(mockLeaseRelease).toHaveBeenCalledWith();
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  it("destroys the leased client when transaction cleanup cannot be confirmed", async () => {
    const floristPhotoPath = "/objects/w1/uploads/florist-cleanup-failure";
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 45, photo_items_path: floristPhotoPath, photo_set_rev: 10 }],
      } as never);
    mockCopyPrivateObjectToPublic.mockResolvedValueOnce(
      "whatsapp-order-ready/w1/o1/rev-10.jpg",
    );
    mockLeaseQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT 1")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      if (sql === "COMMIT") throw new Error("connection lost");
      return { rows: [], rowCount: null };
    });

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");

    expect(mockLeaseRelease).toHaveBeenCalledWith(true);
    expect(mockLeaseRelease).toHaveBeenCalledTimes(1);
  });

  // ── created (new_order_received) ──────────────────────────────────────────

  it("sends new_order_received with name, number, date, time window, and the received header image", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)   // contact
      .mockResolvedValueOnce(WINDOW as never);                // delivery window
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.new_order_received,
      bodyParameters: ["Rana", "1001", "20 August 2026", expect.stringMatching(/4:00\sPM–7:00\sPM/)],
      channelId: 17,
      headerImageUrl: IMG_RECEIVED,
    }));
  });

  it("falls back to 'To be confirmed' when the order has no delivery window or delivery_address date/slot", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ window_start: null, window_end: null, addr_date: null, addr_slot: null }],
      } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      bodyParameters: ["Rana", "1001", "To be confirmed", "To be confirmed"],
      channelId: 17,
      headerImageUrl: IMG_RECEIVED,
    }));
  });

  it("uses delivery_address date and slot when window_start/window_end are null", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ window_start: null, window_end: null, addr_date: "2026-09-10", addr_slot: "2:00 PM–6:00 PM" }],
      } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      bodyParameters: ["Rana", "1001", "10 September 2026", "2:00 PM–6:00 PM"],
      channelId: 17,
      headerImageUrl: IMG_RECEIVED,
    }));
  });

  it("prefers window_start for time but falls back to addr_slot when window_start is null", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ window_start: null, window_end: null, addr_date: "2026-09-15", addr_slot: "Morning" }],
      } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      bodyParameters: ["Rana", "1001", "15 September 2026", "Morning"],
    }));
  });

  it("still falls back to 'To be confirmed' for time when window is null and addr_slot is empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ window_start: null, window_end: null, addr_date: "2026-09-20", addr_slot: "" }],
      } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "created", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      bodyParameters: ["Rana", "1001", "20 September 2026", "To be confirmed"],
    }));
  });

  // ── completed (order_delivered) ───────────────────────────────────────────

  it("sends order_delivered with no body parameters and the delivered header image", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "completed", "w1");
    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
      bodyParameters: [],
      channelId: 17,
      headerImageUrl: IMG_DELIVERED,
    }));
    // completed needs no extra queries beyond the contact lookup
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockCopyPrivateObjectToPublic).not.toHaveBeenCalled();
  });

  it("never applies the ready florist-photo capability to order_delivered", () => {
    const options = buildOrderPaymentTemplateSendOptions(
      "order_delivered",
      [],
      {
        kind: "order_ready_florist_item_photo",
        publicUrl: "https://photos.example.com/florist-order.jpg",
      },
    );

    expect(options.headerImageUrl).toBe(IMG_DELIVERED);
  });

  // ── contact find-or-create ────────────────────────────────────────────────

  it("finds-or-creates and persists the respond.io contact when unsynced", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...CONTACT, respondio_contact_id: null }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);          // persist UPDATE
    mockFindOrCreate.mockResolvedValueOnce("rio-new");
    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    expect(mockFindOrCreate).toHaveBeenCalledWith("+96170123456", "Rana", "K");
    const updateSql = mockQuery.mock.calls[1][0] as string;
    expect(updateSql).toContain("SET respondio_contact_id = $1");
    expect(mockQuery.mock.calls[1][1]).toEqual(["rio-new", "c1"]);
    expect(mockSend).toHaveBeenCalledWith("rio-new", expect.objectContaining({
      headerImageUrl: IMG_READY,
    }));
  });

  it("skips (no send) when the phone format is invalid", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...CONTACT, phone: "not a phone", respondio_contact_id: null }],
    } as never);
    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockTrackWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "Customer WhatsApp number is not valid E.164" }),
    );
  });

  // ── error resilience ──────────────────────────────────────────────────────

  it("never throws when the send fails", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    mockSend.mockResolvedValueOnce({
      ok: false, retryable: true, errorCode: "http_500", errorMessage: "boom",
    });
    await expect(
      notifyOrderStatusWhatsApp("o1", "1001", "completed", "w1"),
    ).resolves.toMatchObject({ ok: false, errorCode: "http_500" });
  });

  it("never throws when the db lookup fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(
      notifyOrderStatusWhatsApp("o1", "1001", "completed", "w1"),
    ).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("sendWhishPaymentInstructions", () => {
  it("sends the approved template with the stored USD pair and full customer name", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ currency: "USD", amount: "90", claim_token: "attempt-1" }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          ...CONTACT,
          first_name: "Ahmad",
          last_name: "Saade",
          display_name: "Ahmad Saade",
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await expect(sendWhishPaymentInstructions("o1", "w1")).resolves.toEqual({
      ok: true,
      providerRef: "m1",
    });
    expect(mockSend).toHaveBeenCalledWith("rio-9", {
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment,
      bodyParameters: ["Ahmad Saade", "USD", "90.00"],
      channelId: 17,
      headerImageUrl: null,
    });
    expect(mockQuery.mock.calls[0][0]).toContain("whish_instructions_sent_at IS NULL");
    expect(mockQuery.mock.calls[3][0]).toContain("whish_instructions_provider_ref");
    expect(mockQuery.mock.calls[3][1]).toEqual(["o1", "m1", "attempt-1"]);
  });

  it("uses the customer display name and preserves a non-USD stored pair on manual resend", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ currency: "AED", amount: "200", claim_token: "attempt-2" }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          ...CONTACT,
          first_name: null,
          last_name: null,
          display_name: "Ahmad Saade",
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await sendWhishPaymentInstructions("o1", "w1", { manual: true, actorUserId: "staff-1" });

    expect(mockSend).toHaveBeenCalledWith("rio-9", expect.objectContaining({
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment,
      bodyParameters: ["Ahmad Saade", "AED", "200.00"],
    }));
    expect(mockQuery.mock.calls[0][1]).toEqual(["o1", true]);
    expect(mockRecordActivity).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "whish_payment_instructions_resent",
      actorUserId: "staff-1",
      payload: expect.objectContaining({
        template: "whishpayment",
        currency: "AED",
        amount: "200.00",
      }),
    }));
  });

  it("does not send a duplicate automatic instruction after another worker has claimed or sent it", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    await expect(sendWhishPaymentInstructions("o1", "w1")).resolves.toMatchObject({
      ok: false,
      errorCode: "not_eligible",
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("does not claim or send instructions for a paid Whish payment", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);

    await expect(sendWhishPaymentInstructions("o1", "w1")).resolves.toMatchObject({
      ok: false,
      errorCode: "not_eligible",
    });

    expect(mockQuery.mock.calls[0][0]).toContain("NOT IN ('paid', 'refunded')");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records a retryable failure when the authoritative stored amount is unavailable", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ currency: "AED", amount: null, claim_token: "attempt-3" }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    await expect(sendWhishPaymentInstructions("o1", "w1")).resolves.toMatchObject({
      ok: false,
      errorCode: "missing_amount",
      retryable: true,
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls[1][0]).toContain("whish_instructions_status = 'failed'");
  });
});

// ── deliveredWhatsappJob ────────────────────────────────────────────────────

describe("backoffMinutesForDeliveredAttempt", () => {
  it("returns 1 minute after the first failure", () => {
    expect(backoffMinutesForDeliveredAttempt(1)).toBe(1);
  });
  it("returns 5 minutes after the second failure", () => {
    expect(backoffMinutesForDeliveredAttempt(2)).toBe(5);
  });
  it("caps at the last backoff value for higher counts", () => {
    expect(backoffMinutesForDeliveredAttempt(10)).toBe(5);
  });
});

describe("enqueueDeliveredWhatsappNotification", () => {
  it("inserts a pending row with a 3-minute delay and never calls sendWhatsAppTemplateToContact", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await enqueueDeliveredWhatsappNotification("o1", "1001", "w1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("whatsapp_delivered_notifications");
    expect(sql).toContain("3 minutes");
    expect(sql).toContain("ON CONFLICT (order_id) DO NOTHING");
    expect(mockQuery.mock.calls[0][1]).toEqual(["o1", "w1", "1001"]);
    // The deliver template must NOT be dispatched immediately
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("is idempotent — a second enqueue for the same order is a silent no-op", async () => {
    // ON CONFLICT DO NOTHING → rowCount 0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await enqueueDeliveredWhatsappNotification("o1", "1001", "w1");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never throws when the database insert fails", async () => {
    mockQuery.mockRejectedValueOnce(new Error("db down"));

    await expect(
      enqueueDeliveredWhatsappNotification("o1", "1001", "w1"),
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("processDeliveredNotification", () => {
  const ROW = {
    id: "n1",
    order_id: "o1",
    workspace_owner_id: "w1",
    order_number: "1001",
    attempt_count: 0,
  };

  it("claims the row, calls notifyOrderStatusWhatsApp for completed, and marks it sent", async () => {
    // claim UPDATE → returns the row
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never);
    // contact lookup inside notifyOrderStatusWhatsApp
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    // final UPDATE → mark sent
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processDeliveredNotification("n1");

    // The template sent must be order_delivered
    expect(mockSend).toHaveBeenCalledWith(
      "rio-9",
      expect.objectContaining({ bodyParameters: [] }),
    );

    // Final UPDATE marks status = 'sent'
    const updateSql = mockQuery.mock.calls[2][0] as string;
    expect(updateSql).toContain("whatsapp_delivered_notifications");
    const updateParams = mockQuery.mock.calls[2][1] as unknown[];
    expect(updateParams[1]).toBe("sent");
  });

  it("preserves ready-photo then delivered-template payload order end to end", async () => {
    const floristPhotoPath = "/objects/w1/uploads/approved-items";
    const floristPublicKey = "whatsapp-order-ready/w1/o1/rev-11.jpg";
    const floristPublicUrl =
      `https://os.presentail.com/api/storage/public-objects/${floristPublicKey}`;

    mockQuery
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 43, photo_items_path: floristPhotoPath, photo_set_rev: 11 }],
      } as never)
      .mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [CONTACT] } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    mockCopyPrivateObjectToPublic.mockResolvedValueOnce(floristPublicKey);

    await notifyOrderStatusWhatsApp("o1", "1001", "ready_for_delivery", "w1");
    await processDeliveredNotification("n1");

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0]).toEqual([
      "rio-9",
      expect.objectContaining({
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
        headerImageUrl: floristPublicUrl,
      }),
    ]);
    expect(mockSend.mock.calls[1]).toEqual([
      "rio-9",
      expect.objectContaining({
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
        headerImageUrl: IMG_DELIVERED,
      }),
    ]);
    expect(mockSend.mock.calls[1][1].headerImageUrl).not.toBe(floristPublicUrl);
    expect(mockCopyPrivateObjectToPublic).toHaveBeenCalledTimes(1);
  });

  it("leaves rows that are not yet due unclaimed (claim returns no rows)", async () => {
    // Simulate next_attempt_at > now() — claim returns empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await processDeliveredNotification("n1");

    // Only the claim query ran; no send, no final update
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reschedules with back-off on a retryable WhatsApp failure", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never);
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    mockSend.mockResolvedValueOnce({
      ok: false,
      retryable: true,
      errorCode: "http_500",
      errorMessage: "upstream error",
    });
    // back-off UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processDeliveredNotification("n1");

    const backoffSql = mockQuery.mock.calls[2][0] as string;
    expect(backoffSql).toContain("next_attempt_at");
    expect(backoffSql).toContain("status = 'pending'");
  });

  it("marks the row failed permanently after MAX_DELIVERED_WHATSAPP_ATTEMPTS exhausted", async () => {
    const exhaustedRow = { ...ROW, attempt_count: MAX_DELIVERED_WHATSAPP_ATTEMPTS - 1 };
    mockQuery.mockResolvedValueOnce({ rows: [exhaustedRow], rowCount: 1 } as never);
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    mockSend.mockResolvedValueOnce({
      ok: false,
      retryable: true,
      errorCode: "http_500",
      errorMessage: "still failing",
    });
    // failed UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processDeliveredNotification("n1");

    const failSql = mockQuery.mock.calls[2][0] as string;
    expect(failSql).toContain("status = 'failed'");
  });

  it("marks sent when notify returns null (skipped — no consent, etc.)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never);
    // contact lookup returns empty → notifyOrderStatusWhatsApp returns null
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    // final UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await processDeliveredNotification("n1");

    const updateParams = mockQuery.mock.calls[2][1] as unknown[];
    expect(updateParams[1]).toBe("sent");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

const SWEEP_ROW = {
  id: "n1",
  order_id: "o1",
  workspace_owner_id: "w1",
  order_number: "1001",
  attempt_count: 0,
};

describe("runDeliveredWhatsappSweep", () => {
  it("processes all due rows returned by the sweep query", async () => {
    // Sweep SELECT → two due rows
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "n1" }, { id: "n2" }],
      rowCount: 2,
    } as never);

    // For n1: claim + contact + sent update
    mockQuery.mockResolvedValueOnce({ rows: [{ ...SWEEP_ROW, id: "n1" }], rowCount: 1 } as never);
    mockQuery.mockResolvedValueOnce({ rows: [CONTACT] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    // For n2: claim returns empty (already claimed by another instance)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await runDeliveredWhatsappSweep();

    // Sweep SELECT + 3 (n1 claim, contact, update) + 1 (n2 claim) = 5 queries
    expect(mockQuery).toHaveBeenCalledTimes(5);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("skips the sweep when there are no due rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await runDeliveredWhatsappSweep();

    // Only the SELECT ran; nothing to process
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
