import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const verify = vi.fn();
const getEmail = vi.fn();
const getAttachment = vi.fn();
const processInbound = vi.fn();
const query = vi.fn();
vi.mock("svix", () => ({ Webhook: class { verify(...args: unknown[]) { return verify(...args); } } }));
vi.mock("../lib/email", () => ({
  getResendClient: () => ({ emails: { receiving: {
    get: (...args: unknown[]) => getEmail(...args),
    attachments: { get: (...args: unknown[]) => getAttachment(...args) },
  } } }),
}));
vi.mock("../lib/supplierStatementDelivery", () => ({
  processSupplierStatementResendInbound: (...args: unknown[]) => processInbound(...args),
  isSupplierStatementPayload: () => false,
  isSupplierStatementReceivingAddress: (addresses: string[]) => addresses.includes("statements@example.com"),
  processSupplierStatementResendStatus: vi.fn(),
}));
vi.mock("../lib/db", () => ({ db: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import router from "./resendWebhook";

function app() {
  const application = express();
  application.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
      next();
    });
  });
  application.use("/api", router);
  return application;
}
const post = () => request(app()).post("/api/webhooks/resend")
  .set("svix-id", "evt1").set("svix-timestamp", "1700000000").set("svix-signature", "v1,sig")
  .send({ type: "email.received" });

beforeEach(() => {
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  verify.mockReset().mockReturnValue({ type: "email.received", data: { email_id: "received-1" } });
  getEmail.mockReset().mockResolvedValue({ data: {
    id: "received-1", to: ["statements@example.com"], from: "supplier@example.com",
    created_at: "2026-09-23T10:00:00Z", subject: "statement", message_id: "<msg@example.com>",
    text: "attached", html: null, headers: null, cc: null, bcc: null, reply_to: null,
    attachments: [{ id: "a1", filename: "statement.pdf", size: 4, content_type: "application/pdf", content_id: null, content_disposition: "attachment" }],
  }, error: null });
  getAttachment.mockReset().mockResolvedValue({ data: { download_url: "https://example.com/attachment", size: 4 }, error: null });
  processInbound.mockReset().mockResolvedValue({ handled: true, classification: "ambiguous_document" });
  query.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(Buffer.from("abcd"), { status: 200 })));
});

describe("shared Resend webhook native received emails", () => {
  it("rejects invalid signatures before fetching the email", async () => {
    verify.mockImplementation(() => { throw new Error("signature invalid"); });
    expect((await post()).status).toBe(400);
    expect(getEmail).not.toHaveBeenCalled();
  });

  it("loads the webhook email ID and its attachment using installed receiving SDK", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ namespace: "supplier_statement_collection" });
    expect(getEmail).toHaveBeenCalledWith("received-1");
    expect(getAttachment).toHaveBeenCalledWith({ emailId: "received-1", id: "a1" });
    expect(processInbound.mock.calls[0][0].email.attachments[0].bytes).toEqual(Buffer.from("abcd"));
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps failed receipt processing retryable instead of acknowledging lost mail", async () => {
    getEmail.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    expect((await post()).status).toBe(503);
  });

  it("ignores unrelated receiving mail without downloading its attachments", async () => {
    getEmail.mockResolvedValueOnce({ data: {
      id: "received-1", to: ["support@example.com"], attachments: [{ id: "a1" }],
    }, error: null });
    const response = await post();
    expect(response.body).toMatchObject({ received: true, ignored: true });
    expect(getAttachment).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("returns 503 on transient attachment failure so Resend can retry", async () => {
    getAttachment.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await post()).status).toBe(503);
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("records oversized attachments as unavailable without downloading them", async () => {
    getAttachment.mockResolvedValueOnce({ data: { size: 21 * 1024 * 1024, download_url: "https://example.com" }, error: null });
    expect((await post()).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(processInbound.mock.calls[0][0].email.attachments[0].download_error).toBe("attachment_too_large");
  });
});