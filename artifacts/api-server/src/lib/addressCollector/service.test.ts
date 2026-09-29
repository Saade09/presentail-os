import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbQuery, mockLoggerInfo, mockLoggerWarn } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock("../db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../logger", () => ({
  logger: {
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  createAddressCollectionRequest,
  createAutomaticAddressCollectionRequest,
  cancelAddressCollectionForOrder,
  scheduleSmsFallback,
  isActiveStatus,
  ingestRespondIoTemplateSend,
  applyProviderStatus,
  claimWhatsappTemplateAttempt,
  recalcScheduleForOrder,
  reconcileOrphanedAddressCollectionRequests,
  finalizeAddressCollectionForOrder,
} from "./service";

beforeEach(() => {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
});

const baseInput = {
  workspaceOwnerId: "user_1",
  orderId: "33333333-3333-3333-3333-333333333333",
  recipientName: "Maya Khalil",
  recipientPhone: "+961 81 865 589",
  preferredLanguage: "ar",
  windowStart: new Date(Date.now() + 6 * 3600_000),
  windowEnd: new Date(Date.now() + 9 * 3600_000),
  source: "wizard" as const,
};

describe("reconcileOrphanedAddressCollectionRequests", () => {
  it("terminally closes exact missing-order requests without relinking", async () => {
    mockDbQuery.mockImplementation((sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("WITH candidates AS")) {
        return Promise.resolve({
          rows: [{ id: "request-orphan", previous_status: "needs_review" }],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 2 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(reconcileOrphanedAddressCollectionRequests(undefined, 10)).resolves.toBe(1);

    const closeSql = String(mockDbQuery.mock.calls[0]?.[0]);
    expect(closeSql).toContain("NOT EXISTS");
    expect(closeSql).toContain("resolution_outcome = 'order_deleted'");
    expect(closeSql).toContain("closure_source = 'orphan_reconciliation'");
    expect(closeSql).not.toMatch(/SET[\s\S]*order_id\s*=/i);
    const eventCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_events"));
    expect(eventCall).toBeTruthy();
    expect(JSON.stringify(eventCall?.[1])).toContain("order_deleted");
  });
});

describe("finalizeAddressCollectionForOrder order deletion", () => {
  it("closes and cancels the exact order request with an order_deleted audit outcome", async () => {
    mockDbQuery.mockImplementation((sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("UPDATE address_collection_requests")) {
        return Promise.resolve({
          rows: [{ id: "request-1", status: "processing" }],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 2 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(finalizeAddressCollectionForOrder({
      query: (...args: unknown[]) => mockDbQuery(...args),
    } as never, {
      orderId: baseInput.orderId,
      workspaceOwnerId: baseInput.workspaceOwnerId,
      outcome: "order_deleted",
      reason: "Parent order was deleted",
      source: "order_hard_delete",
      actor: "owner-1",
    })).resolves.toBe(1);

    const requestUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE address_collection_requests"));
    expect(requestUpdate?.[1]).toEqual(expect.arrayContaining([
      baseInput.orderId,
      baseInput.workspaceOwnerId,
      "cancelled",
      "order_deleted",
      "order_hard_delete",
    ]));
    const eventCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_events"));
    expect(JSON.stringify(eventCall?.[1])).toContain("order_deleted");
  });

  it("fails the surrounding deletion transaction when the required audit event cannot be written", async () => {
    mockDbQuery.mockImplementation((sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("UPDATE address_collection_requests")) {
        return Promise.resolve({
          rows: [{ id: "request-1", status: "processing" }],
          rowCount: 1,
        });
      }
      if (sql.includes("UPDATE address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("INSERT INTO address_collection_events")) {
        return Promise.reject(new Error("audit unavailable"));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(finalizeAddressCollectionForOrder({
      query: (...args: unknown[]) => mockDbQuery(...args),
    } as never, {
      orderId: baseInput.orderId,
      workspaceOwnerId: baseInput.workspaceOwnerId,
      outcome: "order_deleted",
      reason: "Parent order was deleted",
      source: "order_hard_delete",
    })).rejects.toThrow("audit unavailable");
  });
});

describe("createAddressCollectionRequest", () => {
  it("refuses to create without recipient name or phone", async () => {
    expect((await createAddressCollectionRequest({ ...baseInput, recipientName: "" })).created).toBe(false);
    expect((await createAddressCollectionRequest({ ...baseInput, recipientPhone: null })).created).toBe(false);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("creates an awaiting request with normalized E.164 phone and one scheduled outreach", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await createAddressCollectionRequest(baseInput);
    expect(result.created).toBe(true);
    if (result.created) expect(result.token.length).toBeGreaterThanOrEqual(24);

    const insertCall = mockDbQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO address_collection_requests"),
    )!;
    const params = insertCall[1] as unknown[];
    expect(params[3]).toBe("+96181865589"); // normalized E.164
    expect(params[4]).toBe("ar");
    expect(params[5]).toBe("awaiting_address");
    // Idempotency via the partial-unique ON CONFLICT
    expect(String(insertCall[0])).toContain("ON CONFLICT (order_id)");

    // The plan can shorten near the delivery window, but it must always queue
    // exactly one idempotent first message.
    const actionInserts = mockDbQuery.mock.calls.filter((c) =>
      String(c[0]).includes("INSERT INTO address_collection_actions"),
    );
    expect(actionInserts.filter((c) => (c[1] as unknown[])[1] === "first_message")).toHaveLength(1);
    for (const c of actionInserts) {
      expect(String(c[0])).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    }
  });

  it("defers automatic collection while an order is pending", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ status: "pending", delivery_address: null }],
      rowCount: 1,
    });

    await expect(createAddressCollectionRequest(baseInput)).resolves.toEqual({
      created: false,
      reason: "order_not_eligible",
    });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("allows an explicit request while an order is pending", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "pending", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-explicit" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(createAddressCollectionRequest({
      ...baseInput,
      explicitRequest: true,
    })).resolves.toMatchObject({ created: true, requestId: "req-explicit" });
  });

  it("is idempotent: duplicate order → no-op with no duplicate scheduled action", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("SELECT id") && String(sql).includes("address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-existing" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 }); // ON CONFLICT swallowed
    });
    const result = await createAddressCollectionRequest(baseInput);
    expect(result).toEqual({
      created: false,
      reason: "duplicate",
      requestId: "req-existing",
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-existing" }),
      expect.stringContaining("active request already exists"),
    );
    expect(
      mockDbQuery.mock.calls.filter((c) => String(c[0]).includes("address_collection_actions")).length,
    ).toBe(0);
  });

  it("creates invalid-phone requests in needs_review with NO outreach actions", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-2" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await createAddressCollectionRequest({ ...baseInput, recipientPhone: "not a phone" });
    expect(result.created).toBe(true);
    const insertCall = mockDbQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO address_collection_requests"),
    )!;
    expect((insertCall[1] as unknown[])[5]).toBe("needs_review");
    expect(
      mockDbQuery.mock.calls.filter((c) => String(c[0]).includes("address_collection_actions")).length,
    ).toBe(0);
  });

  it.each([
    {
      noAddress: true,
      address: "To be confirmed — ask recipient for address — To be confirmed",
      address_1: "To be confirmed — ask recipient for address — To be confirmed",
    },
    { noAddress: true, address: "To be confirmed" },
    { address: "ask recipient for address" },
  ])("creates a request and first action for missing-address shape %#", async (deliveryAddress) => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: deliveryAddress }],
          rowCount: 1,
        });
      }
      if (String(sql).includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-placeholder" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(createAddressCollectionRequest({
      ...baseInput,
      source: "external",
    })).resolves.toMatchObject({ created: true, requestId: "req-placeholder" });
    expect(
      mockDbQuery.mock.calls.filter(([sql, params]) =>
        String(sql).includes("INSERT INTO address_collection_actions")
        && (params as unknown[])[1] === "first_message",
      ),
    ).toHaveLength(1);
  });

  it("does not create a request for a real usable address", async () => {
    mockDbQuery.mockResolvedValueOnce({
       rows: [{ status: "processing", delivery_address: { address: "12 Main Street" } }],
      rowCount: 1,
    });

    await expect(createAddressCollectionRequest(baseInput)).resolves.toEqual({
      created: false,
      reason: "address_present",
    });
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO address_collection_requests"),
      ),
    ).toBe(false);
  });

  it("does not mislabel an unmatched insert guard as a duplicate", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    await expect(createAddressCollectionRequest(baseInput)).resolves.toEqual({
      created: false,
      reason: "order_not_eligible",
    });
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("active request already exists"),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: baseInput.orderId }),
      expect.stringContaining("insert guard no longer matched"),
    );
  });

  it("reuses the same automatic request path after promotion to processing", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      const text = String(sql);
      if (text.includes("SELECT o.status, o.delivery_address")) {
        return Promise.resolve({
          rows: [{
            status: "processing",
            delivery_address: null,
            delivery_type: "standard",
            window_start: null,
            window_end: null,
            source: "external",
            raw_payload: {
              delivery: {
                date: "2026-09-23",
                slot: "4–7 PM",
                countryCode: "LB",
                preferredLanguage: "ar",
              },
            },
            recipient_name: "Maya Khalil",
            recipient_phone: "+96181865589",
          }],
          rowCount: 1,
        });
      }
      if (text.includes("SELECT status, delivery_address")) {
        return Promise.resolve({
          rows: [{ status: "processing", delivery_address: null }],
          rowCount: 1,
        });
      }
      if (text.includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "req-promoted" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(createAutomaticAddressCollectionRequest({
      workspaceOwnerId: baseInput.workspaceOwnerId,
      orderId: baseInput.orderId,
    })).resolves.toMatchObject({ created: true, requestId: "req-promoted" });
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_actions"),
    )).toBe(true);
  });
});

describe("cancelAddressCollectionForOrder", () => {
  it("cancels the active request, expires the token, and cancels pending actions", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("SET status = 'cancelled'")) {
        return Promise.resolve({ rows: [{ id: "req-1", status: "cancelled" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await cancelAddressCollectionForOrder("order-1", "order cancelled");
    const sqls = mockDbQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("token_expires_at = now()"))).toBe(true);
    expect(sqls.some((s) => s.includes("address_collection_actions") && s.includes("'cancelled'"))).toBe(true);
    expect(sqls.some((s) => s.includes("address_collection_events"))).toBe(true);
  });
});

describe("scheduleSmsFallback", () => {
  it("uses a stable idempotency key so repeated failure signals schedule only one SMS", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // conflict — already scheduled
    await scheduleSmsFallback("req-1", "whatsapp failed");
    const call = mockDbQuery.mock.calls[0];
    expect(String(call[0])).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect((call[1] as unknown[])[2]).toBe("req-1:sms_fallback");
    // No event written when nothing was inserted
    expect(mockDbQuery.mock.calls.length).toBe(1);
  });
});

describe("WhatsApp template attempt guard", () => {
  it("uses one atomic request update as the concurrency boundary", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: "req-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(claimWhatsappTemplateAttempt({
      requestId: "req-1",
      actionId: "action-1",
    })).resolves.toBe(true);
    await expect(claimWhatsappTemplateAttempt({
      requestId: "req-1",
      actionId: "action-2",
    })).resolves.toBe(false);

    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toContain("whatsapp_template_attempted_at IS NULL");
    expect(sql).toContain("RETURNING r.id");
    expect(sql).toContain("a.status IN ('sent', 'failed', 'blocked')");
    expect(sql).not.toContain("delivery_address->>'address'");
  });
});

describe("recalcScheduleForOrder", () => {
  it("replans only escalation once WhatsApp outreach has been attempted", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT * FROM address_collection_requests")) {
        return Promise.resolve({
          rows: [{
            ...baseInput,
            id: "req-1",
            workspace_owner_id: "user_1",
            order_id: baseInput.orderId,
            recipient_name: baseInput.recipientName,
            recipient_phone: "+96181865589",
            preferred_language: "ar",
            status: "whatsapp_sent",
            risk_level: "normal",
            token_hash: "hash",
            token_expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
            window_start: baseInput.windowStart.toISOString(),
            window_end: baseInput.windowEnd.toISOString(),
            delivery_timezone: "Asia/Beirut",
            delivery_country_code: "LB",
            sms_opt_out: false,
            respondio_contact_id: "contact-1",
            respondio_channel_id: "543704",
            source: "wizard",
            link_first_opened_at: null,
            address_received_at: null,
            whatsapp_template_attempted_at: new Date().toISOString(),
            whatsapp_template_provider_ref: "message-1",
            whatsapp_template_status: "accepted",
            created_at: new Date().toISOString(),
          }],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT COUNT(*)::text")) {
        return Promise.resolve({ rows: [{ n: "4" }], rowCount: 1 });
      }
      if (sql.includes("SELECT DISTINCT action_type")) {
        return Promise.resolve({ rows: [{ action_type: "first_message" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await recalcScheduleForOrder(
      baseInput.orderId,
      new Date(Date.now() + 8 * 3600_000),
      new Date(Date.now() + 11 * 3600_000),
    );

    const insertedTypes = mockDbQuery.mock.calls
      .filter(([sql]) => String(sql).includes("INSERT INTO address_collection_actions"))
      .map(([, params]) => (params as unknown[])[1]);
    expect(insertedTypes).toEqual(["escalation"]);
  });
});

describe("Respond.io receiver lifecycle", () => {
  it("records a manual template send as an already-sent action without scheduling OS outreach", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT request_id FROM address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO address_collection_actions")) {
        return Promise.resolve({ rows: [{ request_id: "standalone-1" }], rowCount: 1 });
      }
      if (sql.includes("SELECT id") && sql.includes("address_collection_requests")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("INSERT INTO address_collection_requests")) {
        return Promise.resolve({ rows: [{ id: "standalone-1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await ingestRespondIoTemplateSend({
      providerMessageId: "msg-manual-1",
      workspaceOwnerId: "workspace-1",
      contactId: "contact-1",
      channelId: "543704",
      recipientPhone: "+96181865589",
      recipientName: "Maya Khalil",
      languageCode: "en",
      sentAt: new Date("2026-08-31T10:00:00.000Z"),
    });
    expect(result).toEqual({ requestId: "standalone-1", duplicate: false });
    const actionInserts = mockDbQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_actions"),
    );
    expect(actionInserts).toHaveLength(1);
    expect(String(actionInserts[0][0])).toContain("'template_send'");
    expect(String(actionInserts[0][0])).toContain("'sent'");
  });

  it("enriches one unambiguous order request and cancels its pending WhatsApp sends", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT request_id FROM address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT id, order_id, source")) {
        return Promise.resolve({
          rows: [{ id: "order-request-1", order_id: "order-1", source: "wizard" }],
          rowCount: 1,
        });
      }
      if (sql.includes("INSERT INTO address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("RETURNING status")) {
        return Promise.resolve({ rows: [{ status: "whatsapp_sent" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const result = await ingestRespondIoTemplateSend({
      providerMessageId: "msg-manual-order-1",
      workspaceOwnerId: "workspace-1",
      contactId: "contact-1",
      channelId: "543704",
      recipientPhone: "+96181865589",
      recipientName: "Maya Khalil",
      languageCode: "en",
      sentAt: new Date("2026-08-31T10:00:00.000Z"),
    });
    expect(result.requestId).toBe("order-request-1");
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("superseded by manual respond.io send"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_requests"),
    )).toBe(false);
  });

  it("treats a replayed provider message as a duplicate without creating another request", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ request_id: "standalone-1" }],
      rowCount: 1,
    });
    const result = await ingestRespondIoTemplateSend({
      providerMessageId: "msg-replayed",
      workspaceOwnerId: "workspace-1",
      contactId: "contact-1",
      channelId: "543704",
      recipientPhone: "+96181865589",
      recipientName: "Maya Khalil",
      languageCode: "en",
      sentAt: new Date("2026-08-31T10:00:00.000Z"),
    });
    expect(result).toEqual({ requestId: "standalone-1", duplicate: true });
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(String(mockDbQuery.mock.calls[1][0])).toContain(
      "whatsapp_template_attempted_at = COALESCE",
    );
  });

  it("suppresses a different provider message once the request already recorded an attempt", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT request_id FROM address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes("SELECT id, order_id, source")) {
        return Promise.resolve({
          rows: [{ id: "order-request-1", order_id: "order-1", source: "wizard" }],
          rowCount: 1,
        });
      }
      if (sql.includes("whatsapp_template_attempted_at IS NULL")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const result = await ingestRespondIoTemplateSend({
      providerMessageId: "msg-different-replay",
      workspaceOwnerId: "workspace-1",
      contactId: "contact-1",
      channelId: "543704",
      recipientPhone: "+96181865589",
      recipientName: "Maya Khalil",
      languageCode: "en",
      sentAt: new Date("2026-08-31T10:05:00.000Z"),
    });

    expect(result).toEqual({ requestId: "order-request-1", duplicate: true });
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("VALUES ($1, 'template_send'"),
    )).toBe(false);
  });

  it("correlates provider status to the exact provider message and never schedules SMS for standalone receivers", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("RETURNING status")) {
        return Promise.resolve({ rows: [{ status: "whatsapp_failed" }], rowCount: 1 });
      }
      if (sql.includes("SELECT status, sms_opt_out, source")) {
        return Promise.resolve({
          rows: [{ status: "whatsapp_failed", sms_opt_out: false, source: "respondio" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    await applyProviderStatus({
      requestId: "standalone-1",
      providerRef: "msg-manual-1",
      providerStatus: "failed",
    });
    const exactUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("provider_ref = $3"),
    );
    expect((exactUpdate?.[1] as unknown[])?.slice(0, 3)).toEqual([
      "standalone-1",
      "failed",
      "msg-manual-1",
    ]);
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes("'sms_fallback'")),
    ).toBe(false);
  });

  it("allows a webhook to reconcile an ambiguous attempt without scheduling another template", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("UPDATE address_collection_actions")) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes("RETURNING status")) {
        return Promise.resolve({ rows: [{ status: "whatsapp_delivered" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await applyProviderStatus({
      requestId: "req-unknown-1",
      providerRef: "msg-late-1",
      providerStatus: "delivered",
    });

    const updateSql = String(mockDbQuery.mock.calls[0][0]);
    expect(updateSql).toContain("status = 'failed' AND provider_status = 'unknown'");
    expect(updateSql).toContain("provider_status = 'unknown' OR status = 'processing'");
    expect(updateSql).toContain("THEN 'sent'");
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO address_collection_actions"),
    )).toBe(false);
  });
});

describe("isActiveStatus", () => {
  it("classifies terminal vs active statuses", () => {
    expect(isActiveStatus("scheduled")).toBe(true);
    expect(isActiveStatus("escalated")).toBe(true);
    expect(isActiveStatus("address_received")).toBe(false);
    expect(isActiveStatus("cancelled")).toBe(false);
    expect(isActiveStatus("expired")).toBe(false);
  });
});
