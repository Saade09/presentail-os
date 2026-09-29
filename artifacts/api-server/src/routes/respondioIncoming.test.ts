import { createHmac } from "crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { register, process, ingest, dbQuery, logInfo, logWarn, logError } = vi.hoisted(() => ({
  register: vi.fn(),
  process: vi.fn(),
  ingest: vi.fn(),
  dbQuery: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../lib/addressCollector/incomingReplyHandler", async (original) => {
  const actual = await original<typeof import("../lib/addressCollector/incomingReplyHandler")>();
  return {
    ...actual,
    registerIncomingReply: register,
    processIncomingReply: process,
  };
});
vi.mock("../lib/logger", () => ({
  logger: { info: logInfo, warn: logWarn, error: logError, debug: vi.fn() },
}));
vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => dbQuery(...args) },
}));
vi.mock("../lib/addressCollector/service", () => ({
  ingestRespondIoTemplateSend: (...args: unknown[]) => ingest(...args),
}));

import router, { respondIoRawBodyErrorResponse } from "./respondioIncoming";

function app() {
  const instance = express();
  instance.use(
    [
      "/api/respondio/incoming-message",
      "/api/respondio/outbound-template",
    ],
    (req, res, next) => {
      express.raw({ type: "application/json" })(req, res, (err) => {
        if (err) {
          respondIoRawBodyErrorResponse(
            req,
            res,
            (err as { type?: unknown }).type === "entity.too.large"
              ? "body_too_large"
              : "invalid_body",
          );
          return;
        }
        (req as typeof req & { rawBody: Buffer }).rawBody = req.body as Buffer;
        next();
      });
    },
  );
  instance.use("/api", router);
  return instance;
}

const payload = {
  event_type: "message.received",
  event_id: "sanitized-event-1",
  ignored_history: [{ body: "private prior message" }],
  contact: {
    id: 123,
    firstName: "Maya",
    lastName: "Khalil",
    phone: "+9613159639",
  },
  message: {
    messageId: "wamid-1",
    channelMessageId: "provider-channel-message-1",
    contactId: 123,
    channelId: 543704,
    traffic: "incoming",
    timestamp: 1_725_000_000_000,
    message: { type: "text", text: "Hamra, Beirut" },
  },
  sender: { source: "contact" },
  channel: { id: 543704, source: "whatsapp" },
};

function signature(body: string, _format?: "base64") {
  return createHmac("sha256", "signing-secret").update(body).digest("base64");
}

function loggedInfo(message: string) {
  return logInfo.mock.calls
    .filter((call) => call[1] === message)
    .map((call) => call[0] as Record<string, unknown>);
}

function serializedIncomingLogs() {
  return JSON.stringify(
    logInfo.mock.calls.filter((call) =>
      typeof call[1] === "string" && call[1].startsWith("respondio incoming webhook"),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESPONDIO_STATUS_WEBHOOK_SECRET", "signing-secret");
  vi.stubEnv("RESPONDIO_INCOMING_WEBHOOK_SECRET", "signing-secret");
  register.mockResolvedValue(true);
  process.mockResolvedValue(undefined);
  ingest.mockResolvedValue({ requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", duplicate: false });
  dbQuery.mockResolvedValue({ rows: [{ workspace_owner_id: "workspace-1" }], rowCount: 1 });
});

describe("POST /api/respondio/outbound-template", () => {
  const outbound = {
    event_type: "message.sent",
    data: {
      channel: { id: "543704" },
      contact: { id: "contact-1", phone: "+9613159639", name: "Maya Khalil" },
      message: {
        id: "msg-manual-1",
        direction: "outgoing",
        type: "whatsapp_template",
        sentAt: "2026-08-31T10:00:00.000Z",
        template: { name: "address_collection", languageCode: "en" },
      },
    },
  };

  it("accepts the approved template, resolves its workspace, and records the provider send", async () => {
    const body = JSON.stringify(outbound);
    const response = await request(app())
      .post("/api/respondio/outbound-template")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);
    expect(response.status).toBe(202);
    expect(response.body.accepted).toBe(true);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: "msg-manual-1",
      contactId: "contact-1",
      workspaceOwnerId: "workspace-1",
    }));
  });

  it("rejects unrelated templates and ambiguous workspace mappings", async () => {
    const unrelated = structuredClone(outbound);
    unrelated.data.message.template.name = "order_ready";
    const unrelatedBody = JSON.stringify(unrelated);
    const ignored = await request(app())
      .post("/api/respondio/outbound-template")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(unrelatedBody))
      .send(unrelatedBody);
    expect(ignored.body).toEqual({ accepted: false });
    expect(ingest).not.toHaveBeenCalled();

    dbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "workspace-1" }, { workspace_owner_id: "workspace-2" }],
      rowCount: 2,
    });
    const body = JSON.stringify(outbound);
    const ambiguous = await request(app())
      .post("/api/respondio/outbound-template")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);
    expect(ambiguous.status).toBe(422);
  });
});

describe("POST /api/respondio/incoming-message", () => {
  it("keeps customer address routing when a shared contact has a stale supplier attribute", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const shared = {
      ...payload,
      contact: { ...payload.contact, customAttributes: { supplier_statement_namespace: "supplier_statement_collection" } },
    };
    const body = JSON.stringify(shared);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(register).toHaveBeenCalled();
  });

  it("does not route an explicitly marked but uncorrelated supplier message to customer processing", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const marked = { ...payload, namespace: "supplier_statement_collection" };
    const body = JSON.stringify(marked);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: true, ignored: true });
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without registering the message", async () => {
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", "wrong")
      .send(body);
    expect(response.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toEqual([
      expect.objectContaining({
        method: "POST",
        contentType: "application/json",
        signatureHeaderPresent: true,
        topLevelJsonKeys: ["event_type", "event_id", "contact", "message", "sender", "channel"],
        eventType: "message.received",
        messageType: "text",
        providerMessageId: "wamid-1",
        channelId: "543704",
        contactId: "123",
        phonePresent: true,
        textPresent: true,
        latitudePresent: false,
        longitudePresent: false,
        replyReferencePresent: false,
        locationCoordinates: [],
      }),
    ]);
    expect(loggedInfo("respondio incoming webhook outcome")).toEqual([
      expect.objectContaining({
        httpStatus: 401,
        accepted: false,
        ignored: false,
        parserClassification: "invalid_signature",
        rejectionReason: "invalid_signature",
        errorCode: "invalid_signature",
      }),
    ]);
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toHaveLength(1);
    expect(loggedInfo("respondio incoming webhook outcome")).toHaveLength(1);
    const logs = serializedIncomingLogs();
    expect(logs).not.toContain("+9613159639");
    expect(logs).not.toContain("Maya Khalil");
    expect(logs).not.toContain("Hamra, Beirut");
    expect(logs).not.toContain("private prior message");
    expect(logs).not.toContain("wrong");
    expect(logs).not.toContain("signing-secret");
  });

  it("records a missing signature without exposing the parsed body", async () => {
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(401);
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")[0])
      .toMatchObject({ signatureHeaderPresent: false, phonePresent: true, textPresent: true });
    expect(loggedInfo("respondio incoming webhook outcome")[0])
      .toMatchObject({ parserClassification: "invalid_signature", httpStatus: 401 });
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toHaveLength(1);
    expect(loggedInfo("respondio incoming webhook outcome")).toHaveLength(1);
    expect(serializedIncomingLogs()).not.toContain("Hamra, Beirut");
  });

  it("does not accept the delivery-status secret when the signing key is absent", async () => {
    vi.stubEnv("RESPONDIO_INCOMING_WEBHOOK_SECRET", "");
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        hasConfiguredSigningKey: false,
        signatureHeaderPresent: true,
      }),
      "respondio incoming webhook rejected",
    );
  });

  it("canonicalizes an untrusted content type instead of logging its value", async () => {
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "Maya-Khalil")
      .set("X-Webhook-Signature", "private-signature")
      .send("private-body");

    expect(response.status).toBe(401);
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toEqual([
      expect.objectContaining({ contentType: "other", signatureHeaderPresent: true }),
    ]);
    const logs = serializedIncomingLogs();
    expect(logs).not.toContain("Maya-Khalil");
    expect(logs).not.toContain("private-signature");
    expect(logs).not.toContain("private-body");
  });

  it("records an oversized raw body without logging its contents", async () => {
    const privateMarker = "oversized-private-customer-message";
    const body = JSON.stringify({
      event_type: "message.received",
      data: { text: privateMarker.repeat(5_000) },
    });
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", "private-signature")
      .send(body);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: "body_too_large" });
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toEqual([
      expect.objectContaining({
        payloadKind: "unavailable",
        contentType: "application/json",
        signatureHeaderPresent: true,
        rawBodyBytes: 0,
      }),
    ]);
    expect(loggedInfo("respondio incoming webhook outcome")).toEqual([
      expect.objectContaining({
        httpStatus: 413,
        accepted: false,
        ignored: false,
        parserClassification: "body_too_large",
        rejectionReason: "body_too_large",
        errorCode: "body_too_large",
      }),
    ]);
    const logs = serializedIncomingLogs();
    expect(logs).not.toContain(privateMarker);
    expect(logs).not.toContain("private-signature");
  });

  it("records invalid JSON with a safe receipt and final outcome", async () => {
    const body = "{\"event_type\":\"message.received\",\"data\":";
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid_json" });
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")[0]).toMatchObject({
      payloadKind: "invalid_json",
      topLevelJsonKeys: [],
      signatureHeaderPresent: true,
      parserClassification: "invalid_json",
    });
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      httpStatus: 400,
      accepted: false,
      ignored: false,
      parserClassification: "invalid_json",
      rejectionReason: "invalid_json",
      errorCode: "invalid_json",
    });
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toHaveLength(1);
    expect(loggedInfo("respondio incoming webhook outcome")).toHaveLength(1);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ signatureValid: false }),
      "respondio incoming webhook invalid JSON",
    );
    expect(serializedIncomingLogs()).not.toContain(body);
    expect(serializedIncomingLogs()).not.toContain(signature(body));
  });

  it("acknowledges a valid base64-signed text message before registering it", async () => {
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: "wamid-1",
      rawPhone: "+9613159639",
    }));
    expect(process).toHaveBeenCalledOnce();
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      httpStatus: 200,
      accepted: true,
      ignored: false,
      parserClassification: "text",
    });
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toHaveLength(1);
    expect(loggedInfo("respondio incoming webhook outcome")).toHaveLength(1);
    expect(serializedIncomingLogs()).not.toContain("+9613159639");
    expect(serializedIncomingLogs()).not.toContain("Maya Khalil");
    expect(serializedIncomingLogs()).not.toContain("Hamra, Beirut");
  });

  it("verifies Respond.io's JSON-stringified payload rather than raw whitespace", async () => {
    const canonicalBody = JSON.stringify(payload);
    const prettyBody = JSON.stringify(payload, null, 2);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(canonicalBody))
      .send(prettyBody);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(register).toHaveBeenCalledOnce();
  });

  it("acknowledges replayed provider IDs and safely resumes an unprocessed row", async () => {
    register.mockResolvedValue(false);
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(process).toHaveBeenCalledOnce();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        duplicate: true,
        asynchronousResult: "duplicate_resume",
        providerMessageId: "wamid-1",
      }),
      "respondio incoming webhook registered",
    );
  });

  it("does not let the obsolete status alias share the canonical incoming contract", async () => {
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/webhooks/respondio/status")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: "deprecated_endpoint" });
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "text/plain", body: "not json" },
    { contentType: "application/json", body: "{\"broken\":" },
    { contentType: "application/json", body: JSON.stringify({ data: "x".repeat(150_000) }) },
  ])("always isolates the obsolete alias from incoming diagnostics", async ({ contentType, body }) => {
    const response = await request(app())
      .post("/api/webhooks/respondio/status")
      .set("content-type", contentType)
      .set("X-Webhook-Signature", "private-signature")
      .send(body);

    expect(response.status).toBe(410);
    expect(response.body).toEqual({ error: "deprecated_endpoint" });
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(loggedInfo("respondio incoming webhook diagnostic receipt")).toHaveLength(0);
    expect(loggedInfo("respondio incoming webhook outcome")).toHaveLength(0);
  });

  it("returns 200 for Respond.io sample and unsupported events without business processing", async () => {
    const sample = {
      event_type: "message.received",
      event_id: "sanitized-sample-event",
      contact: { id: "sample-contact" },
      message: {
        messageId: "sample-attachment-message",
        contactId: "sample-contact",
        channelId: 543704,
        traffic: "incoming",
        message: { type: "attachment", url: "https://example.invalid/sample" },
      },
      channel: { id: 543704 },
    };
    const body = JSON.stringify(sample);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, ignored: true });
    expect(register).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "message.received",
        contactId: "sample-contact",
        signatureValid: true,
        acknowledgementStatus: 200,
        asynchronousResult: "ignored",
      }),
      "respondio incoming webhook acknowledged",
    );
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      httpStatus: 200,
      accepted: true,
      ignored: true,
      parserClassification: "missing_content",
      rejectionReason: "missing_content",
    });
  });

  it("classifies an unrelated event as unsupported", async () => {
    const unsupported = {
      event_type: "contact.updated",
      data: {
        channel: { id: "543704" },
        contact: { id: "contact-1", phone: "+9613159639", name: "Maya Khalil" },
        message: { id: "ignored-1", direction: "incoming", text: "private text" },
      },
    };
    const body = JSON.stringify(unsupported);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, ignored: true });
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      parserClassification: "unsupported_event",
      rejectionReason: "unsupported_event",
    });
    expect(serializedIncomingLogs()).not.toContain("+9613159639");
    expect(serializedIncomingLogs()).not.toContain("Maya Khalil");
    expect(serializedIncomingLogs()).not.toContain("private text");
  });

  it("uses the parser's rejection classification for an unsupported direction", async () => {
    const unsupportedDirection = {
      event_type: "message.received",
      data: {
        channel: { id: "543704" },
        contact: { id: "contact-1" },
        message: { id: "draft-1", direction: "draft", type: "text", text: "private text" },
      },
    };
    const body = JSON.stringify(unsupportedDirection);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, ignored: true });
    expect(loggedInfo("respondio incoming webhook outcome")).toEqual([
      expect.objectContaining({
        parserClassification: "unsupported_outbound",
        rejectionReason: "unsupported_outbound",
      }),
    ]);
    expect(serializedIncomingLogs()).not.toContain("private text");
  });

  it("returns 200 when contact and phone metadata are absent", async () => {
    const missingMetadata = {
      event_type: "message.received",
      data: {
        channel: { id: "543704" },
        message: { id: "sample-no-contact", direction: "incoming", text: "sample" },
      },
    };
    const body = JSON.stringify(missingMetadata);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.ignored).toBe(true);
    expect(register).not.toHaveBeenCalled();
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      parserClassification: "missing_identifier",
      rejectionReason: "missing_identifier",
    });
  });

  it.each([
    {
      name: "shared location",
      message: {
        id: "wamid-location",
        direction: "incoming",
        type: "location",
        location: { latitude: 33.8938, longitude: 35.5018, name: "Sassine" },
      },
      expectedType: "location",
    },
    {
      name: "maps link",
      message: {
        id: "wamid-map-link",
        direction: "incoming",
        type: "text",
        text: "https://www.google.com/maps?q=33.8938,35.5018",
      },
      expectedType: "text",
    },
  ])("acknowledges and schedules a signed $name reply", async ({ message, expectedType }) => {
    const incoming = {
      event_type: "message.received",
      event_id: `sanitized-${message.id}`,
      contact: { id: "contact-1", phone: "+9613159639" },
      message: {
        messageId: message.id,
        channelId: 543704,
        contactId: "contact-1",
        traffic: message.direction,
        message: {
          type: message.type,
          ...(message.type === "location"
            ? {
                latitude: message.location!.latitude,
                longitude: message.location!.longitude,
                name: message.location!.name,
              }
            : { text: message.text }),
        },
      },
      channel: { id: 543704, source: "whatsapp" },
    };
    const body = JSON.stringify(incoming);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: expectedType }));
    expect(process).toHaveBeenCalledOnce();
    expect(loggedInfo("respondio incoming webhook outcome")[0]).toMatchObject({
      accepted: true,
      ignored: false,
      parserClassification: expectedType,
    });
    const receipt = loggedInfo("respondio incoming webhook diagnostic receipt")[0];
    if (expectedType === "location") {
      expect(receipt).toMatchObject({
        messageType: "location",
        latitudePresent: true,
        longitudePresent: true,
        textPresent: false,
        locationCoordinates: [
          { path: "message.message.latitude", value: 33.8938 },
          { path: "message.message.longitude", value: 35.5018 },
        ],
      });
      expect(serializedIncomingLogs()).not.toContain("Sassine");
    } else {
      expect(receipt).toMatchObject({
        messageType: "text",
        latitudePresent: false,
        longitudePresent: false,
        textPresent: true,
        locationCoordinates: [],
      });
      expect(serializedIncomingLogs()).not.toContain("https://www.google.com/maps");
    }
    expect(serializedIncomingLogs()).not.toContain("+9613159639");
  });

  it("routes a signed New Incoming Message directly to Address Collector processing", async () => {
    const incoming = {
      event_type: "new_incoming_message",
      data: {
        channelId: "543704",
        contact: { id: "contact-1", phone: "+9613159639" },
        message: {
          messageId: "wamid-direct-address-collector",
          direction: "inbound",
          content: { type: "text", text: "Al Bayada 5th Street Jamil Building" },
        },
      },
    };
    const body = JSON.stringify(incoming);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: "wamid-direct-address-collector",
      type: "text",
      text: "Al Bayada 5th Street Jamil Building",
    }));
    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      providerMessageId: "wamid-direct-address-collector",
    }));
  });

  it("responds before a deliberately slow registration or processor can finish", async () => {
    let releaseRegistration!: () => void;
    register.mockReturnValue(new Promise<boolean>((resolve) => {
      releaseRegistration = () => resolve(true);
    }));
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true });
    expect(process).not.toHaveBeenCalled();
    releaseRegistration();
    await new Promise((resolve) => setImmediate(resolve));
    expect(process).toHaveBeenCalledOnce();
  });

  it("keeps a post-acknowledgement registration failure out of the HTTP response", async () => {
    register.mockRejectedValue(new Error("database unavailable"));
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        asynchronousResult: "failed",
        acknowledgementStatus: 200,
        providerMessageId: "wamid-1",
        errorCode: "asynchronous_processing_failed",
      }),
      "respondio incoming webhook asynchronous processing failed",
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("database unavailable");
  });

  it("keeps a post-acknowledgement processor failure out of the HTTP response", async () => {
    process.mockRejectedValue(new Error("geocoder unavailable"));
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body, "base64"))
      .send(body);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        asynchronousResult: "failed",
        acknowledgementStatus: 200,
        providerMessageId: "wamid-1",
        errorCode: "asynchronous_processing_failed",
      }),
      "respondio incoming webhook asynchronous processing failed",
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("geocoder unavailable");
  });

  it("does not log PII-shaped asynchronous error metadata", async () => {
    const sensitiveError = Object.assign(new Error("private error body"), {
      name: "MayaKhalil",
      code: "9613159639",
    });
    register.mockRejectedValue(sensitiveError);
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set("X-Webhook-Signature", signature(body))
      .send(body);

    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "asynchronous_processing_failed" }),
      "respondio incoming webhook asynchronous processing failed",
    );
    const logs = JSON.stringify(logError.mock.calls);
    expect(logs).not.toContain("MayaKhalil");
    expect(logs).not.toContain("9613159639");
    expect(logs).not.toContain("private error body");
  });

  it("rejects a correctly keyed signature in the undocumented hex format", async () => {
    const body = JSON.stringify(payload);
    const response = await request(app())
      .post("/api/respondio/incoming-message")
      .set("content-type", "application/json")
      .set(
        "X-Webhook-Signature",
        createHmac("sha256", "signing-secret").update(body).digest("hex"),
      )
      .send(body);

    expect(response.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });
});