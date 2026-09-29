import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDbQuery, mockFindOrCreate, mockIsEnabled } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockFindOrCreate: vi.fn(),
  mockIsEnabled: vi.fn(),
}));

vi.mock("./db.js", () => ({
  db: { query: (...a: unknown[]) => mockDbQuery(...a) },
}));

vi.mock("./respondio.js", () => ({
  isRespondIoEnabled: () => mockIsEnabled(),
  findOrCreateContactByPhone: (...a: unknown[]) => mockFindOrCreate(...a),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { backfillRespondioContactIds } from "./backfillRespondioContactIds";

const contact = (n: number) => ({
  id: `00000000-0000-0000-0000-00000000000${n}`,
  phone: `+9618186558${n}`,
  first_name: `First${n}`,
  last_name: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
});

describe("backfillRespondioContactIds", () => {
  it("no-ops without any DB queries when respond.io is not configured", async () => {
    mockIsEnabled.mockReturnValue(false);
    await backfillRespondioContactIds();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("exits after the count query when everything is already synced", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });
    await backfillRespondioContactIds();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });

  it("never writes when respond.io returns null for every contact", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 }) // count
      .mockResolvedValueOnce({ rows: [contact(1), contact(2)], rowCount: 2 }) // batch 1
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // batch 2 (empty → stop)
    mockFindOrCreate.mockResolvedValue(null);

    await backfillRespondioContactIds();

    expect(mockFindOrCreate).toHaveBeenCalledTimes(2);
    const updates = mockDbQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE contacts"),
    );
    expect(updates).toHaveLength(0);
  });

  it("skips invalid phone formats, writes phone_format_invalid status, and syncs valid contacts", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [contact(1), contact(2)], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockFindOrCreate
      .mockResolvedValueOnce("phone_format_invalid")
      .mockResolvedValueOnce("42");
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 }); // UPDATEs

    await backfillRespondioContactIds();

    const updates = mockDbQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE contacts"),
    );
    // 2 UPDATEs: one respondio_sync_status write for the invalid-phone contact,
    // one respondio_contact_id + status write for the successfully synced contact.
    expect(updates).toHaveLength(2);
    expect(String(updates[0]![0])).toContain("phone_format_invalid");
    expect(updates[0]![1]).toEqual([contact(1).id]);
    expect(String(updates[1]![0])).toContain("respondio_contact_id");
    expect(updates[1]![1]).toEqual(["42", contact(2).id]);
  });

  it("preserves first-batch writes when the second batch query fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "6" }], rowCount: 1 }) // count
      .mockResolvedValueOnce({
        rows: [contact(1), contact(2), contact(3), contact(4), contact(5)],
        rowCount: 5,
      }) // full batch 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update 2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update 3
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update 4
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // update 5
      .mockRejectedValueOnce(new Error("db down")); // batch 2 query fails
    mockFindOrCreate.mockImplementation(async () => "77");

    await expect(backfillRespondioContactIds()).resolves.toBeUndefined();

    const updates = mockDbQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE contacts"),
    );
    expect(updates).toHaveLength(5);
  });
});
