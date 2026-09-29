import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockIsRespondIoEnabled = vi.fn();
const mockFindOrCreateContactByPhone = vi.fn();
const mockUpdateContactName = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}));

vi.mock("./genderInference", () => ({
  queueGenderInference: vi.fn(),
}));

vi.mock("./respondio", () => ({
  isRespondIoEnabled: (...args: unknown[]) => mockIsRespondIoEnabled(...args),
  findOrCreateContactByPhone: (...args: unknown[]) => mockFindOrCreateContactByPhone(...args),
  updateContactName: (...args: unknown[]) => mockUpdateContactName(...args),
}));

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  isPhoneNumberPlaceholderName,
  refreshPhonePlaceholderContactAfterFirstOrder,
  syncContactToRespondIo,
  upsertContact,
} from "./contactUpsert";

/** Build a Postgres unique-violation error matching isUniqueViolation's check. */
function pgUniqueViolation(constraintName: string): Error {
  return Object.assign(new Error("unique violation"), {
    code: "23505",
    constraint: constraintName,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsRespondIoEnabled.mockReturnValue(false);
  mockQuery.mockResolvedValue({ rows: [] });
  mockFindOrCreateContactByPhone.mockResolvedValue("respondio-1");
  mockUpdateContactName.mockResolvedValue(true);
});

const firstOrder = {
  workspaceOwnerId: "owner-1",
  contactId: "contact-1",
  orderId: "order-1",
  buyer: { firstName: "Rana", lastName: "K" },
};

const phoneContact = {
  id: "contact-1",
  phone: "+96170000001",
  first_name: "+961 70 000 001",
  last_name: null,
  display_name: "+96170000001",
  respondio_contact_id: null,
};

describe("isPhoneNumberPlaceholderName", () => {
  it("recognizes formatted and unformatted phone-only names", () => {
    expect(isPhoneNumberPlaceholderName("+961 70 000 001", "+96170000001")).toBe(true);
    expect(isPhoneNumberPlaceholderName("96170000001", "+96170000001")).toBe(true);
  });

  it("rejects labels, empty values, and names with letters", () => {
    expect(isPhoneNumberPlaceholderName("WhatsApp +96170000001", "+96170000001")).toBe(false);
    expect(isPhoneNumberPlaceholderName("", "+96170000001")).toBe(false);
    expect(isPhoneNumberPlaceholderName("Rana K", "+96170000001")).toBe(false);
  });
});

describe("syncContactToRespondIo", () => {
  it("links an eligible persisted contact once and stores the provider ID", async () => {
    mockIsRespondIoEnabled.mockReturnValue(true);
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          phone: "+96170000001",
          first_name: "Rana",
          last_name: "K",
          respondio_contact_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await Promise.all([
      syncContactToRespondIo("contact-sync-1"),
      syncContactToRespondIo("contact-sync-1"),
    ]);

    expect(mockFindOrCreateContactByPhone).toHaveBeenCalledTimes(1);
    expect(mockFindOrCreateContactByPhone).toHaveBeenCalledWith("+96170000001", "Rana", "K");
    expect(mockQuery.mock.calls[1]).toEqual([
      expect.stringContaining("respondio_contact_id IS NULL"),
      ["respondio-1", "contact-sync-1"],
    ]);
  });

  it("skips no-phone, invalid-phone, and already-linked contacts", async () => {
    mockIsRespondIoEnabled.mockReturnValue(true);
    mockQuery.mockResolvedValueOnce({ rows: [{ phone: null, respondio_contact_id: null }] });
    await syncContactToRespondIo("contact-no-phone");
    expect(mockQuery).toHaveBeenCalledTimes(1);

    mockQuery.mockResolvedValueOnce({ rows: [{ respondio_contact_id: "already-linked" }] });
    await syncContactToRespondIo("contact-linked");
    expect(mockFindOrCreateContactByPhone).not.toHaveBeenCalled();

    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: "70123456", first_name: null, last_name: null, respondio_contact_id: null }],
    });
    mockFindOrCreateContactByPhone.mockResolvedValueOnce("phone_format_invalid");
    await syncContactToRespondIo("contact-invalid-phone");
    // +1 for the fire-and-forget respondio_sync_status write added when phone_format_invalid
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it("contains provider and persistence failures", async () => {
    mockIsRespondIoEnabled.mockReturnValue(true);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        phone: "+96170000001",
        first_name: null,
        last_name: null,
        respondio_contact_id: null,
      }],
    });
    mockFindOrCreateContactByPhone.mockRejectedValueOnce(new Error("respond.io unavailable"));
    await expect(
      syncContactToRespondIo("contact-provider-failure"),
    ).resolves.toEqual({ status: "provider_unavailable" });

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          phone: "+96170000002",
          first_name: null,
          last_name: null,
          respondio_contact_id: null,
        }],
      })
      .mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      syncContactToRespondIo("contact-persist-failure"),
    ).resolves.toEqual({ status: "persistence_failed" });
  });
});

describe("refreshPhonePlaceholderContactAfterFirstOrder", () => {
  it("repairs local phone placeholders and creates the linked provider contact", async () => {
    mockIsRespondIoEnabled.mockReturnValue(true);
    mockQuery
      .mockResolvedValueOnce({ rows: [phoneContact] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          phone: "+96170000001",
          first_name: "Rana",
          last_name: "K",
          respondio_contact_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(refreshPhonePlaceholderContactAfterFirstOrder(firstOrder)).resolves.toBe(true);

    expect(mockQuery).toHaveBeenCalledTimes(4);
    expect(mockQuery.mock.calls[1]?.[1]).toEqual([
      "Rana",
      null,
      "Rana K",
      "contact-1",
      "owner-1",
    ]);
    expect(mockFindOrCreateContactByPhone).toHaveBeenCalledWith(
      "+96170000001",
      "Rana",
      "K",
    );
    expect(mockQuery.mock.calls[3]?.[1]).toEqual([
      "respondio-1",
      "contact-1",
    ]);
  });

  it("updates a provider contact that was already linked", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...phoneContact, respondio_contact_id: "respondio-9" }],
    });

    await expect(refreshPhonePlaceholderContactAfterFirstOrder(firstOrder)).resolves.toBe(true);

    expect(mockUpdateContactName).toHaveBeenCalledWith("respondio-9", "Rana", "K");
    expect(mockFindOrCreateContactByPhone).not.toHaveBeenCalled();
  });

  it("does not repair a later order or a meaningful local name", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(refreshPhonePlaceholderContactAfterFirstOrder(firstOrder)).resolves.toBe(false);

    mockQuery.mockResolvedValueOnce({
      rows: [{ ...phoneContact, first_name: "Maya", display_name: "Maya" }],
    });
    await expect(refreshPhonePlaceholderContactAfterFirstOrder(firstOrder)).resolves.toBe(false);
    expect(mockUpdateContactName).not.toHaveBeenCalled();
    expect(mockFindOrCreateContactByPhone).not.toHaveBeenCalled();
  });

  it("does not block or throw when the provider sync fails", async () => {
    mockIsRespondIoEnabled.mockReturnValue(true);
    mockQuery
      .mockResolvedValueOnce({ rows: [phoneContact] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          phone: "+96170000001",
          first_name: "Rana",
          last_name: "K",
          respondio_contact_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }); // respondio_sync_status = 'provider_unavailable' write
    mockFindOrCreateContactByPhone.mockRejectedValueOnce(new Error("respond.io unavailable"));

    await expect(refreshPhonePlaceholderContactAfterFirstOrder(firstOrder)).resolves.toBe(false);
    // select + local repair + shared sync lookup + sync status write
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});

describe("upsertContact — cross-constraint conflict", () => {
  /**
   * Scenario: contact A owns email=E, contact B owns phone=P (both in the
   * same workspace).  A wizard-create with email=E AND phone=P must resolve
   * to the phone owner without throwing.
   *
   * Flow inside upsertContactCore:
   *  1. Email INSERT: ON CONFLICT on email tries to UPDATE contact A's phone →
   *     hits contacts_workspace_phone_unique → caught by the inner try/catch.
   *  2. existingPhone SELECT: finds contact B (the phone owner).
   *  3. Phone-owner UPDATE: tries to set email on contact B → hits
   *     contacts_workspace_email_unique → was previously unhandled (→ 500).
   *     After the fix it is caught and the phone-owner ID is returned cleanly.
   */
  it("returns the phone-owner ID when the email merge violates email uniqueness", async () => {
    mockQuery
      // 1. Email INSERT → phone unique violation (contact A's email path)
      .mockRejectedValueOnce(pgUniqueViolation("contacts_workspace_phone_unique"))
      // 2. existingPhone SELECT → contact B found
      .mockResolvedValueOnce({ rows: [{ id: "contact-b-id" }] })
      // 3. Phone-owner UPDATE → email unique violation (contact A owns the email)
      .mockRejectedValueOnce(pgUniqueViolation("contacts_workspace_email_unique"));

    const id = await upsertContact({
      workspaceOwnerId: "ws-1",
      email: "shared@example.com",
      phone: "+45 50 12 57 78",
    });

    expect(id).toBe("contact-b-id");
  });

  it("still re-throws unexpected errors from the phone-owner UPDATE", async () => {
    mockQuery
      .mockRejectedValueOnce(pgUniqueViolation("contacts_workspace_phone_unique"))
      .mockResolvedValueOnce({ rows: [{ id: "contact-b-id" }] })
      .mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      upsertContact({ workspaceOwnerId: "ws-1", email: "x@example.com", phone: "+4550125778" }),
    ).rejects.toThrow("connection lost");
  });
});