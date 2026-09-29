import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  mapResendEventType,
  shouldUpgradeCommStatus,
  timestampColumnForStatus,
  isFailureCommStatus,
  trackOrderEmail,
  trackOrderWhatsApp,
} from "./orderComms";

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe("mapResendEventType", () => {
  it("maps known Resend event types to normalized statuses", () => {
    expect(mapResendEventType("email.sent")).toBe("sent");
    expect(mapResendEventType("email.delivered")).toBe("delivered");
    expect(mapResendEventType("email.delivery_delayed")).toBe("deferred");
    expect(mapResendEventType("email.opened")).toBe("opened");
    expect(mapResendEventType("email.clicked")).toBe("clicked");
    expect(mapResendEventType("email.bounced")).toBe("bounced");
    expect(mapResendEventType("email.complained")).toBe("suppressed");
    expect(mapResendEventType("email.failed")).toBe("failed");
    expect(mapResendEventType("email.scheduled")).toBe("scheduled");
  });

  it("returns null for unknown event types", () => {
    expect(mapResendEventType("email.something_else")).toBeNull();
    expect(mapResendEventType("contact.created")).toBeNull();
    expect(mapResendEventType("")).toBeNull();
  });
});

describe("shouldUpgradeCommStatus (precedence)", () => {
  it("upgrades forward through the lifecycle", () => {
    expect(shouldUpgradeCommStatus("sending", "sent")).toBe(true);
    expect(shouldUpgradeCommStatus("sent", "delivered")).toBe(true);
    expect(shouldUpgradeCommStatus("delivered", "opened")).toBe(true);
    expect(shouldUpgradeCommStatus("opened", "clicked")).toBe(true);
  });

  it("never downgrades on out-of-order events", () => {
    expect(shouldUpgradeCommStatus("delivered", "sent")).toBe(false);
    expect(shouldUpgradeCommStatus("opened", "delivered")).toBe(false);
    expect(shouldUpgradeCommStatus("clicked", "opened")).toBe(false);
    expect(shouldUpgradeCommStatus("sent", "sent")).toBe(false);
  });

  it("failure states outrank everything but never each other", () => {
    expect(shouldUpgradeCommStatus("clicked", "bounced")).toBe(true);
    expect(shouldUpgradeCommStatus("delivered", "failed")).toBe(true);
    expect(shouldUpgradeCommStatus("bounced", "failed")).toBe(false);
    expect(shouldUpgradeCommStatus("failed", "delivered")).toBe(false);
  });

  it("unknown stored statuses rank as zero so real events win", () => {
    expect(shouldUpgradeCommStatus("garbage", "sent")).toBe(true);
  });
});

describe("timestampColumnForStatus", () => {
  it("returns the once-set column for milestone statuses", () => {
    expect(timestampColumnForStatus("sent")).toBe("sent_at");
    expect(timestampColumnForStatus("delivered")).toBe("delivered_at");
    expect(timestampColumnForStatus("opened")).toBe("opened_at");
    expect(timestampColumnForStatus("clicked")).toBe("clicked_at");
  });

  it("returns null for non-milestone statuses", () => {
    expect(timestampColumnForStatus("failed")).toBeNull();
    expect(timestampColumnForStatus("bounced")).toBeNull();
    expect(timestampColumnForStatus("deferred")).toBeNull();
    expect(timestampColumnForStatus("not_sent")).toBeNull();
  });
});

describe("isFailureCommStatus", () => {
  it("flags only failure states", () => {
    expect(isFailureCommStatus("failed")).toBe(true);
    expect(isFailureCommStatus("bounced")).toBe(true);
    expect(isFailureCommStatus("dropped")).toBe(true);
    expect(isFailureCommStatus("suppressed")).toBe(true);
    expect(isFailureCommStatus("delivered")).toBe(false);
    expect(isFailureCommStatus("sent")).toBe(false);
  });
});

describe("trackOrderEmail", () => {
  const baseOpts = {
    workspaceOwnerId: "ws1",
    orderId: "ord1",
    templateType: "order_confirmation" as const,
    recipientEmail: "a@b.com",
  };

  it("records not_sent and skips the send when no email", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    const sendFn = vi.fn();
    const result = await trackOrderEmail(
      { ...baseOpts, recipientEmail: null },
      sendFn,
    );
    expect(result).toBeNull();
    expect(sendFn).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("'not_sent'");
  });

  it("inserts a sending row, sends, then marks sent with message id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "comm1" }], rowCount: 1 }) // insert
      .mockResolvedValue({ rows: [], rowCount: 1 }); // update + activity
    const sendFn = vi.fn().mockResolvedValue({
      sent: true,
      skipped: false,
      messageId: "msg_123",
      errorMessage: null,
      subject: "Your order",
    });
    const result = await trackOrderEmail(baseOpts, sendFn);
    expect(result?.sent).toBe(true);
    const updateCall = mockDbQuery.mock.calls[1];
    expect(String(updateCall[0])).toContain("status = 'sent'");
    expect(updateCall[1]).toEqual(["comm1", "msg_123", "Your order"]);
  });

  it("marks failed when the send reports failure", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "comm1" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const sendFn = vi.fn().mockResolvedValue({
      sent: false,
      skipped: false,
      messageId: null,
      errorMessage: "boom",
      subject: "Your order",
    });
    await trackOrderEmail(baseOpts, sendFn);
    const updateCall = mockDbQuery.mock.calls[1];
    expect(String(updateCall[0])).toContain("status = 'failed'");
    expect(updateCall[1][1]).toBe("boom");
  });

  it("marks not_sent when the send is skipped (provider unconfigured)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "comm1" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const sendFn = vi.fn().mockResolvedValue({
      sent: false,
      skipped: true,
      messageId: null,
      errorMessage: null,
      subject: "",
    });
    await trackOrderEmail(baseOpts, sendFn);
    const updateCall = mockDbQuery.mock.calls[1];
    expect(String(updateCall[0])).toContain("'not_sent'");
  });

  it("is fail-open: still sends when the tracking insert throws", async () => {
    mockDbQuery.mockRejectedValue(new Error("db down"));
    const sendFn = vi.fn().mockResolvedValue({
      sent: true,
      skipped: false,
      messageId: "msg_1",
      errorMessage: null,
      subject: "s",
    });
    const result = await trackOrderEmail(baseOpts, sendFn);
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(result?.sent).toBe(true);
  });

  it("records failure and swallows when sendFn throws", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "comm1" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const sendFn = vi.fn().mockRejectedValue(new Error("smtp exploded"));
    const result = await trackOrderEmail(baseOpts, sendFn);
    expect(result).toBeNull();
    const updateCall = mockDbQuery.mock.calls[1];
    expect(String(updateCall[0])).toContain("status = 'failed'");
    expect(updateCall[1][1]).toBe("smtp exploded");
  });
});

describe("trackOrderWhatsApp", () => {
  const baseOpts = {
    workspaceOwnerId: "ws1",
    orderId: "ord1",
    templateType: "order_confirmation",
    templateName: "new_order_received",
    recipientPhone: "+96170123456",
  };

  it("records Respond.io acceptance without claiming delivery", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "comm-wa-1" }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const sendFn = vi.fn().mockResolvedValue({ ok: true, providerRef: "rio-msg-1" });

    const result = await trackOrderWhatsApp(baseOpts, sendFn);

    expect(result).toEqual({ ok: true, providerRef: "rio-msg-1" });
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("'whatsapp'");
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("recipient_phone");
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("template_name");
    expect(String(mockDbQuery.mock.calls[1][0])).toContain("status = 'accepted'");
    expect(String(mockDbQuery.mock.calls[1][0])).not.toContain("delivered_at");
    expect(mockDbQuery.mock.calls[1][1]).toEqual(["comm-wa-1", "rio-msg-1"]);
  });

  it("records unavailable preflight skips without calling Respond.io", async () => {
    mockDbQuery.mockResolvedValue({ rows: [{ id: "comm-wa-2" }], rowCount: 1 });
    const sendFn = vi.fn();

    const result = await trackOrderWhatsApp(
      {
        ...baseOpts,
        recipientPhone: null,
        skipReason: "Customer has not consented to WhatsApp updates",
      },
      sendFn,
    );

    expect(result).toBeNull();
    expect(sendFn).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls[0][1]).toContain(
      "Customer has not consented to WhatsApp updates",
    );
    expect(mockDbQuery.mock.calls[0][1]).toContain("not_sent");
  });
});
