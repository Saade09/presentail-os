import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });

vi.mock("resend", () => ({
  Resend: function ResendMock() {
    return {
      emails: { send: (...args: unknown[]) => mockSend(...args) },
    };
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildNewOrderStaffHtml, sendNewOrderStaffEmail } from "./email";

const richDetails = {
  orderNumber: "WEB-1042",
  customerName: "Sarah Khalil",
  customerEmail: "sarah@example.com",
  customerPhone: "+96170000001",
  recipientName: "Ahmad Mansour",
  recipientPhone: "+96170000002",
  deliveryAddress: "17 Bliss Street",
  deliveryDistrict: "Hamra",
  deliveryCity: "Beirut",
  deliveryCountry: "Lebanon",
  deliveryInstructions: "Ring the doorbell twice",
  deliveryDateText: "10 June 2026",
  deliveryTimeSlot: "2:00 PM – 5:00 PM",
  items: [{ name: "White Roses", quantity: 1, priceText: "$79.99" }],
  subtotalText: "$79.99",
  deliveryFeeText: "$5.00",
  amountPaidText: "$84.99",
  cardMessage: "Happy birthday, Ahmad!",
  cardFrom: "Sarah",
  cardTo: "Ahmad",
};

describe("new-order staff emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test-key";
  });

  it("includes complete persisted order context in both HTML and plain text", async () => {
    await sendNewOrderStaffEmail({
      toEmails: ["owner@example.com"],
      ...richDetails,
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["owner@example.com"],
        subject: "New order received: WEB-1042",
      }),
    );
    const message = mockSend.mock.calls[0]?.[0] as { html: string; text: string };

    for (const value of [
      "Customer",
      "Sarah Khalil",
      "sarah@example.com",
      "+96170000001",
      "Recipient",
      "Ahmad Mansour",
      "+96170000002",
      "Delivery",
      "17 Bliss Street",
      "Hamra",
      "Beirut",
      "Lebanon",
      "Ring the doorbell twice",
      "10 June 2026",
      "2:00 PM – 5:00 PM",
      "White Roses",
      "$84.99",
      "Happy birthday, Ahmad!",
      "From: Sarah",
      "To: Ahmad",
    ]) {
      expect(message.html).toContain(value);
      expect(message.text).toContain(value);
    }
  });

  it("omits empty optional sections and labels cleanly in both MIME bodies", async () => {
    const emptyDetails = {
      orderNumber: "WEB-1043",
      customerName: "  ",
      customerEmail: null,
      recipientName: "",
      recipientPhone: null,
      deliveryAddress: null,
      deliveryDistrict: " ",
      deliveryCity: null,
      deliveryCountry: null,
      deliveryInstructions: "",
      deliveryDateText: null,
      deliveryTimeSlot: null,
      cardMessage: null,
      cardFrom: "ignored without a card message",
      cardTo: null,
    };
    const html = buildNewOrderStaffHtml(emptyDetails);
    await sendNewOrderStaffEmail({ toEmails: ["owner@example.com"], ...emptyDetails });
    const message = mockSend.mock.calls[0]?.[0] as { html: string; text: string };

    for (const body of [html, message.html, message.text]) {
      expect(body).not.toContain("Customer:");
      expect(body).not.toContain(">Customer<");
      expect(body).not.toContain(">Recipient<");
      expect(body).not.toContain(">Delivery<");
      expect(body).not.toContain(">Card message<");
      expect(body).not.toContain("ignored without a card message");
    }
  });
});