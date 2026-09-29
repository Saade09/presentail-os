import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  requireOrderAccess: vi.fn(),
  notifyOrderStatusWhatsApp: vi.fn(),
  sendWhishPaymentInstructions: vi.fn(),
}));

vi.mock("../lib/db", () => ({ db: { query: mocks.query } }));
vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  workspace: () => ({
    workspaceOwnerId: "ws-1",
    userId: "user-1",
    userEmail: "manager@example.com",
  }),
}));
vi.mock("./orders", () => ({
  requireOrderAccess: mocks.requireOrderAccess,
  lookupOrderCustomerContact: vi.fn(),
  lookupOrderEmailDetails: vi.fn(),
  formatOrderAmount: vi.fn(),
}));
vi.mock("../lib/email", () => ({
  sendOrderConfirmationEmail: vi.fn(),
  sendOrderPaymentInstructionsEmail: vi.fn(),
  sendOrderPaymentReceivedEmail: vi.fn(),
  sendOrderStatusEmail: vi.fn(),
  sendOrderRefundEmail: vi.fn(),
  ORDER_STATUS_EMAIL_STATUSES: [],
}));
vi.mock("../lib/orderComms", () => ({
  trackOrderEmail: vi.fn(),
  ORDER_COMM_TEMPLATE_TYPES: [
    "order_confirmation",
    "payment_instructions",
    "payment_received",
    "status_update",
    "refund",
  ],
}));
vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: mocks.notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions: mocks.sendWhishPaymentInstructions,
}));
vi.mock("../lib/respondio", () => ({
  isRespondIoEnabled: vi.fn(() => true),
  normalizePhone: (phone: string) => phone,
  isStrictE164: (phone: string) => /^\+[1-9]\d{1,14}$/.test(phone),
}));

import router from "./orderCommunications";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Reflect.set(req, "log", { info: vi.fn() });
    next();
  });
  app.use(router);
  return app;
}

describe("order communications WhatsApp send endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOrderAccess.mockReturnValue(true);
    mocks.query.mockResolvedValue({
      rows: [{
        id: "order-1",
        status: "ready_for_delivery",
        external_order_id: "O-100",
        display_order_number: "100",
      }],
    });
    mocks.notifyOrderStatusWhatsApp.mockResolvedValue({
      ok: true,
      providerRef: "rio-message-1",
    });
  });

  it("enforces existing order access before a WhatsApp send", async () => {
    mocks.requireOrderAccess.mockImplementation((_workspace, res) => {
      res.status(403).json({ success: false, error: "Forbidden" });
      return false;
    });

    const res = await request(makeApp())
      .post("/orders/order-1/communications/send")
      .send({ channel: "whatsapp", templateType: "order_confirmation" });

    expect(res.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.notifyOrderStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("sends the approved mapped template only and returns Respond.io acceptance", async () => {
    const res = await request(makeApp())
      .post("/orders/order-1/communications/send")
      .send({ channel: "whatsapp", templateType: "status_update" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      channel: "whatsapp",
      provider_message_id: "rio-message-1",
    });
    expect(mocks.notifyOrderStatusWhatsApp).toHaveBeenCalledWith(
      "order-1",
      "100",
      "ready_for_delivery",
      "ws-1",
      expect.objectContaining({ manual: true, actorUserId: "user-1" }),
    );
  });

  it("rejects an email-only template instead of sending freeform WhatsApp", async () => {
    const res = await request(makeApp())
      .post("/orders/order-1/communications/send")
      .send({ channel: "whatsapp", templateType: "refund" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not approved/i);
    expect(mocks.notifyOrderStatusWhatsApp).not.toHaveBeenCalled();
  });

  it("replays the selected approved WhatsApp status template on resend", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: "order-1",
          status: "completed",
          external_order_id: "O-100",
          display_order_number: "100",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_type: "status_update",
          template_name: "order_ready",
          channel: "whatsapp",
        }],
      });

    const res = await request(makeApp())
      .post("/orders/order-1/communications/send")
      .send({
        channel: "whatsapp",
        templateType: "status_update",
        communicationId: "00000000-0000-4000-8000-000000000001",
      });

    expect(res.status).toBe(200);
    expect(mocks.notifyOrderStatusWhatsApp).toHaveBeenCalledWith(
      "order-1",
      "100",
      "ready_for_delivery",
      "ws-1",
      expect.any(Object),
    );
  });

  it("replays order_delivered for a delivered communication even if the order is currently ready", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{
          id: "order-1",
          status: "ready_for_delivery",
          external_order_id: "O-100",
          display_order_number: "100",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          template_type: "status_update",
          template_name: "order_delivered",
          channel: "whatsapp",
        }],
      });

    const res = await request(makeApp())
      .post("/orders/order-1/communications/send")
      .send({
        channel: "whatsapp",
        templateType: "status_update",
        communicationId: "00000000-0000-4000-8000-000000000002",
      });

    expect(res.status).toBe(200);
    expect(mocks.notifyOrderStatusWhatsApp).toHaveBeenCalledWith(
      "order-1",
      "100",
      "completed",
      "ws-1",
      expect.objectContaining({ manual: true }),
    );
  });
});