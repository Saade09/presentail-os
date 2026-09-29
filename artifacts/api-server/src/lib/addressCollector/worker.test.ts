import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDbQuery, mockDbConnect, mockSendWhatsApp, mockSendSms, mockEditTookan } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockDbConnect: vi.fn(),
  mockSendWhatsApp: vi.fn(),
  mockSendSms: vi.fn(),
  mockEditTookan: vi.fn(),
}));

vi.mock("../db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./providers", () => ({
  formatWindowLabel: () => "soon",
  sendWhatsAppAddressRequest: (...args: unknown[]) => mockSendWhatsApp(...args),
  sendSmsAddressRequest: (...args: unknown[]) => mockSendSms(...args),
}));

vi.mock("../tookan", () => ({
  editTookanDeliveryTask: (...args: unknown[]) => mockEditTookan(...args),
  buildTookanAddressUpdate: (address: Record<string, unknown> | null) => {
    if (!address) return null;
    const text =
      typeof address.address === "string" && address.address.trim()
        ? address.address.trim()
        : typeof address.address_1 === "string" ? address.address_1.trim() : "";
    const latitude = address.latitude ?? address.lat;
    const longitude = address.longitude ?? address.lng;
    if (!text && (latitude == null || longitude == null)) return null;
    return {
      ...(text ? { address: text } : {}),
      ...(latitude != null && longitude != null ? { latitude, longitude } : {}),
    };
  },
}));

import { __test } from "./worker";

const action = {
  id: "action-1",
  request_id: "request-1",
  action_type: "first_message",
  channel: "whatsapp",
  scheduled_at: new Date().toISOString(),
  attempt_count: 0,
  idempotency_key: "request-1:first_message:g1",
};

const requestRow = {
  id: "request-1",
  workspace_owner_id: "workspace-1",
  order_id: "11111111-1111-1111-1111-111111111111",
  recipient_name: "Maya Khalil",
  recipient_phone: "+96181865589",
  preferred_language: "en",
  status: "scheduled",
  risk_level: "normal",
  token_hash: "hash",
  token_expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  window_start: null,
  window_end: null,
  delivery_timezone: "Asia/Beirut",
  delivery_country_code: "LB",
  sms_opt_out: false,
  respondio_contact_id: null,
  source: "wizard",
  link_first_opened_at: null,
  last_contact_at: null,
  submitted_address: null,
  tookan_job_id: null,
  order_status: "pending",
  delivery_address: null,
  current_recipient_name: "Maya Khalil",
  current_recipient_phone: "+96181865589",
  closed_at: null,
  resolution_outcome: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockDbQuery(...args),
    release: vi.fn(),
  });
  vi.stubEnv("ADDRESS_COLLECTOR_QUIET_HOURS", "0-0");
  vi.stubEnv("APP_PUBLIC_URL", "https://os.example.com");
  mockSendWhatsApp.mockResolvedValue({
    ok: false,
    retryable: false,
    errorCode: "http_400",
    errorMessage: "template rejected",
  });
  mockEditTookan.mockResolvedValue(undefined);
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM address_collection_requests r")) {
      return Promise.resolve({ rows: [requestRow], rowCount: 1 });
    }
    if (sql.includes("SELECT display_order_number")) {
      return Promise.resolve({ rows: [{ display_order_number: "M-1001", external_order_id: "checkout-1001" }] });
    }
    if (sql.includes("UPDATE address_collection_requests") && sql.includes("RETURNING status")) {
      return Promise.resolve({ rows: [{ status: "whatsapp_failed" }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Address Collector worker", () => {
  it("keeps LB-2522-style placeholder addresses dispatchable", () => {
    expect(__test.requestIsDispatchable({
      ...requestRow,
      order_status: "pending",
      closed_at: null,
      resolution_outcome: null,
      delivery_address: {
        noAddress: true,
        address: "To be confirmed — ask recipient for address — To be confirmed",
        address_1: "To be confirmed — ask recipient for address — To be confirmed",
      },
    })).toBe(true);
  });

  it("attempts Respond.io for an immediately due LB-2522-style first message", async () => {
    const lb2522 = {
      ...requestRow,
      recipient_name: "Stale recipient",
      recipient_phone: "+96170000000",
      current_recipient_name: "Maya Khalil",
      current_recipient_phone: "+96170902183",
      delivery_address: {
        noAddress: true,
        address: "To be confirmed — ask recipient for address — To be confirmed",
        address_1: "To be confirmed — ask recipient for address — To be confirmed",
      },
    };
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({ rows: [lb2522], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    mockSendWhatsApp.mockResolvedValue({
      ok: true,
      providerRef: "respondio-message-1",
      respondioContactId: "respondio-contact-1",
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      phone: "+96170902183",
      recipientName: "Maya Khalil",
      requestRef: "request-1",
    }));
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("request_no_longer_actionable"),
    )).toBe(false);
  });

  it("rechecks the address under dispatch locks before calling Respond.io", async () => {
    const missingAddress = {
      ...requestRow,
      delivery_address: {
        noAddress: true,
        address: "To be confirmed — ask recipient for address — To be confirmed",
      },
    };
    const realAddress = {
      ...missingAddress,
      delivery_address: { address: "12 Main Street, Beirut" },
    };
    let fullLoadCount = 0;
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT r.*")) {
        fullLoadCount += 1;
        return Promise.resolve({
          rows: [fullLoadCount === 1 ? missingAddress : realAddress],
          rowCount: 1,
        });
      }
      if (sql.includes("SELECT r.order_id")) {
        return Promise.resolve({ rows: [missingAddress], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("address_already_present"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql) === "COMMIT")).toBe(true);
  });

  it("stops dispatch when the order has a real usable address", () => {
    expect(__test.requestIsDispatchable({
      ...requestRow,
      order_status: "pending",
      closed_at: null,
      resolution_outcome: null,
      delivery_address: { address: "12 Main Street, Beirut" },
    })).toBe(false);
  });

  it("cancels a real-address action and resolves the parent request", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{ ...requestRow, delivery_address: { address: "12 Main Street, Beirut" } }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("address_already_present"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("resolution_outcome = $4")
        && Array.isArray(params)
        && params.includes("manual_resolution"),
    )).toBe(true);
  });

  it("rolls back action cancellation when parent reconciliation fails", async () => {
    const realAddress = {
      ...requestRow,
      delivery_address: { address: "12 Main Street, Beirut" },
    };
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({ rows: [realAddress], rowCount: 1 });
      }
      if (sql.includes("resolution_outcome = $4")) {
        return Promise.reject(new Error("reconciliation failed"));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(__test.processAction(action)).rejects.toThrow("reconciliation failed");

    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql) === "ROLLBACK")).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql) === "COMMIT")).toBe(false);
  });

  it("does not send for a resolved request", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{
            ...requestRow,
            status: "resolved",
            closed_at: new Date().toISOString(),
            resolution_outcome: "manual_resolution",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("request_closed"),
    )).toBe(true);
  });

  it("does not send for a terminal order and closes the parent request", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{ ...requestRow, order_status: "delivered" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("resolution_outcome = $4")
        && Array.isArray(params)
        && params.includes("order_delivered"),
    )).toBe(true);
  });

  it("does not send to an invalid current recipient and marks the request for review", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{ ...requestRow, current_recipient_phone: "not-a-phone" }],
          rowCount: 1,
        });
      }
      if (sql.includes("RETURNING status")) {
        return Promise.resolve({ rows: [{ status: "needs_review" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("recipient_invalid"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("SET status = $1")
        && Array.isArray(params)
        && params[0] === "needs_review",
    )).toBe(true);
  });

  it("recovers stale WhatsApp processing claims as unknown instead of retrying them", async () => {
    await __test.recoverStaleProcessingActions();

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'processing'");
    expect(String(sql)).toContain("provider_status = 'unknown'");
    expect(String(sql)).toContain("stale_processing_recovered");
    expect(String(sql)).not.toContain("SET status = 'pending'");
    expect(params).toEqual([expect.arrayContaining(["scheduled", "whatsapp_sent"])]);
  });

  it("updates an existing Tookan task from the durable destination action without creating one", async () => {
    const tookanAction = {
      ...action,
      action_type: "tookan_destination_update",
      channel: "tookan",
      idempotency_key: "address-reply:message-1:tookan-destination",
    };
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{
            ...requestRow,
            status: "resolved",
            tookan_job_id: "tookan-job-1",
            submitted_address: {
              address: "Sassine Square, Beirut",
              latitude: 33.8938,
              longitude: 35.5018,
            },
            delivery_address: {
              address: "Sassine Square, Beirut",
              latitude: 33.8938,
              longitude: 35.5018,
            },
            order_window_start: "2026-08-15T09:00:00Z",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(tookanAction);

    expect(mockEditTookan).toHaveBeenCalledWith(
      "tookan-job-1",
      "2026-08-15T09:00:00Z",
      {
        address: "Sassine Square, Beirut",
        latitude: 33.8938,
        longitude: 35.5018,
      },
    );
    expect(mockSendWhatsApp).not.toHaveBeenCalled();
  });

  it("cancels a claimed Tookan action after a support correction supersedes its address", async () => {
    const tookanAction = {
      ...action,
      action_type: "tookan_destination_update",
      channel: "tookan",
      idempotency_key: "address-reply:message-stale:tookan-destination",
    };
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{
            ...requestRow,
            status: "resolved",
            tookan_job_id: "tookan-job-1",
            submitted_address: {
              address: "Old Collector Address, Beirut",
              latitude: 33.88,
              longitude: 35.49,
            },
            delivery_address: {
              address: "Corrected Support Address, Beirut",
              latitude: 33.9,
              longitude: 35.51,
            },
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(tookanAction);

    expect(mockEditTookan).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions")
        && Array.isArray(params)
        && params.includes("destination_superseded"),
    )).toBe(true);
  });

  it("keeps a transient Tookan edit failure pending for retry", async () => {
    const tookanAction = {
      ...action,
      action_type: "tookan_destination_update",
      channel: "tookan",
      idempotency_key: "address-reply:message-1:tookan-destination",
    };
    mockEditTookan.mockRejectedValue(new Error("Tookan 503"));
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({
          rows: [{
            ...requestRow,
            status: "resolved",
            tookan_job_id: "tookan-job-1",
            submitted_address: {
              address: "Sassine Square, Beirut",
              latitude: 33.8938,
              longitude: 35.5018,
            },
            delivery_address: {
              address: "Sassine Square, Beirut",
              latitude: 33.8938,
              longitude: 35.5018,
            },
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(tookanAction);

    const retry = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET status = 'pending', attempt_count"),
    );
    expect(retry?.[1]).toEqual(expect.arrayContaining([
      "action-1",
      1,
      "tookan_update_failed",
      "Tookan 503",
    ]));
  });

  it("sends the approved reply template without order or secure-link variables and records permanent rejections", async () => {
    await __test.processAction(action);

    expect(mockSendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientName: "Maya Khalil",
        orderReference: "your order",
        secureUrl: "",
      }),
    );
    const actionUpdate = mockDbQuery.mock.calls.find(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions") &&
        Array.isArray(params) &&
        params[1] === "failed",
    );
    expect(actionUpdate?.[1]).toEqual(
      expect.arrayContaining(["failed", "failed", "http_400", "template rejected"]),
    );
    expect(
      mockDbQuery.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes("SET status = $1") &&
          Array.isArray(params) &&
          params[0] === "whatsapp_failed",
      ),
    ).toBe(true);
  });

  it("falls back to a non-identifying order label when no display reference exists", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT display_order_number")) {
        return Promise.resolve({ rows: [{ display_order_number: null, external_order_id: null }] });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await expect(__test.loadOrderReference(requestRow.order_id)).resolves.toBe("your order");
  });

  it("does not require a public secure-link origin for the WhatsApp reply template", async () => {
    vi.stubEnv("APP_PUBLIC_URL", "https://[::ffff:127.0.0.1]");

    await __test.processAction(action);

    expect(mockSendWhatsApp).toHaveBeenCalledWith(
      expect.objectContaining({ orderReference: "your order", secureUrl: "" }),
    );
  });

  it.each(["reminder", "final_reminder", "manual_reminder"])(
    "cancels legacy %s actions without dispatching WhatsApp",
    async (actionType) => {
      await __test.processAction({
        ...action,
        action_type: actionType,
        idempotency_key: `request-1:${actionType}:legacy`,
      });

      expect(mockSendWhatsApp).not.toHaveBeenCalled();
      expect(mockDbQuery.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes("UPDATE address_collection_actions") &&
          Array.isArray(params) &&
          params[1] === "cancelled" &&
          params.includes("legacy_repeat_suppressed"),
      )).toBe(true);
    },
  );

  it("suppresses a duplicate action when the request-level gate is already claimed", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM address_collection_requests r")) {
        return Promise.resolve({ rows: [requestRow], rowCount: 1 });
      }
      if (sql.includes("whatsapp_template_attempted_at IS NULL")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    await __test.processAction(action);

    expect(mockSendWhatsApp).not.toHaveBeenCalled();
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions") &&
        Array.isArray(params) &&
        params.includes("duplicate_whatsapp_suppressed"),
    )).toBe(true);
  });

  it("does not retry an ambiguous post-dispatch transport failure", async () => {
    mockSendWhatsApp.mockResolvedValue({
      ok: false,
      retryable: true,
      errorCode: "network_error",
      errorMessage: "connection closed after dispatch",
    });

    await __test.processAction(action);

    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'pending', attempt_count"),
    )).toBe(false);
    expect(mockDbQuery.mock.calls.some(
      ([sql, params]) =>
        String(sql).includes("UPDATE address_collection_actions") &&
        Array.isArray(params) &&
        params.includes("unknown"),
    )).toBe(true);
  });

  it("allows a safe retry after a confirmed pre-send contact lookup failure", async () => {
    mockSendWhatsApp.mockResolvedValue({
      ok: false,
      retryable: true,
      preSendFailure: true,
      errorCode: "contact_lookup_failed",
      errorMessage: "contact was not resolved",
    });

    await __test.processAction(action);

    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("whatsapp_template_attempted_at = NULL"),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("SET status = 'pending', attempt_count"),
    )).toBe(true);
  });
});