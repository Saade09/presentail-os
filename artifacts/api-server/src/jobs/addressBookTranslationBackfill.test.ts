import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDbQuery,
  mockClientQuery,
  mockConnect,
  mockTranslateAddressToEnglish,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockTranslateAddressToEnglish: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockConnect(),
    end: vi.fn(),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/translation", () => ({
  detectScript: (text: string) => /[\u0600-\u06ff]/.test(text) ? "arabic" : "latin",
  translateAddressToEnglish: (...args: unknown[]) =>
    mockTranslateAddressToEnglish(...args),
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  normalizePlaceName: (text: string) => text.toLowerCase().trim(),
}));

import { runTranslationBackfill } from "./addressBookTranslationBackfill";

describe("runTranslationBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rows: [{ id: "updated" }], rowCount: 1 });
    mockConnect.mockReturnValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    });
  });

  it("translates all Address Book fields and preserves place originals as aliases", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, canonical_name, canonical_address")) {
        return Promise.resolve({
          rows: [{
            id: "place-1",
            canonical_name: "مبنى الأرز",
            canonical_address: "شارع بلس",
          }],
        });
      }
      if (sql.includes("SELECT id, raw_address")) {
        return Promise.resolve({
          rows: [{ id: "address-1", raw_address: "شارع ساسين" }],
        });
      }
      if (sql.includes("UPDATE contact_addresses")) {
        return Promise.resolve({ rows: [{ id: "address-1" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockTranslateAddressToEnglish.mockImplementation(async (text: string) => {
      if (text === "مبنى الأرز") return "Cedar Building";
      if (text === "شارع بلس") return "Bliss Street";
      if (text === "شارع ساسين") return "Sassine Street";
      return null;
    });

    const summary = await runTranslationBackfill({ workspaceId: "ws-1" });

    expect(summary).toMatchObject({
      place_names_updated: 1,
      place_addresses_updated: 1,
      contact_addresses_updated: 1,
      aliases_added: 2,
      skipped_translation: 0,
    });
    expect(mockClientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO place_aliases"),
    )).toHaveLength(2);
    expect(mockTranslateAddressToEnglish).toHaveBeenCalledWith(
      "مبنى الأرز",
      { workspaceOwnerId: "ws-1" },
    );
    expect(mockLoggerInfo.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            table: "places",
            id: "place-1",
            field: "canonical_name",
            before: "مبنى الأرز",
            after: "Cedar Building",
            dryRun: false,
          }),
          "addressBookTranslationBackfill: translated Address Book field",
        ],
      ]),
    );
  });

  it("is write-free in dry-run mode and reports translation failures for retry", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, canonical_name, canonical_address")) {
        return Promise.resolve({
          rows: [{
            id: "place-1",
            canonical_name: "مبنى الأرز",
            canonical_address: "شارع بلس",
          }],
        });
      }
      if (sql.includes("SELECT id, raw_address")) {
        return Promise.resolve({
          rows: [{ id: "address-1", raw_address: "شارع ساسين" }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockTranslateAddressToEnglish.mockImplementation(async (text: string) =>
      text === "شارع بلس" ? null : `English ${text.length}`,
    );

    const summary = await runTranslationBackfill({
      workspaceId: "ws-1",
      dryRun: true,
    });

    expect(summary).toMatchObject({
      place_names_updated: 1,
      place_addresses_updated: 0,
      contact_addresses_updated: 1,
      aliases_added: 0,
      skipped_translation: 1,
    });
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      /^\s*(UPDATE|INSERT)/i.test(String(sql)),
    )).toBe(false);
  });

  it("is idempotent after stored fields no longer contain Arabic", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id, canonical_name, canonical_address")) {
        return Promise.resolve({
          rows: [{
            id: "place-1",
            canonical_name: "Cedar Building",
            canonical_address: "Bliss Street",
          }],
        });
      }
      if (sql.includes("SELECT id, raw_address")) {
        return Promise.resolve({
          rows: [{ id: "address-1", raw_address: "Sassine Street" }],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const summary = await runTranslationBackfill({ workspaceId: "ws-1" });

    expect(summary).toMatchObject({
      place_names_updated: 0,
      place_addresses_updated: 0,
      contact_addresses_updated: 0,
      aliases_added: 0,
      skipped_translation: 0,
    });
    expect(mockTranslateAddressToEnglish).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });
});