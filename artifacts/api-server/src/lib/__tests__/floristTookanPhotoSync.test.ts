import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn();
vi.mock("../db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
}));

const mockWarn = vi.fn();
vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

const mockCopyPrivateObjectToPublic = vi.fn();
vi.mock("../objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: (...args: unknown[]) =>
      mockCopyPrivateObjectToPublic(...args),
  },
  buildPublicObjectUrl: (key: string | null | undefined) =>
    key ? `https://os.presentail.com/api/storage/public-objects/${key}` : null,
}));

const mockEditTookanDeliveryTask = vi.fn();
const mockIsTookanEnabled = vi.fn();
vi.mock("../tookan", () => ({
  editTookanDeliveryTask: (...args: unknown[]) =>
    mockEditTookanDeliveryTask(...args),
  isTookanEnabled: () => mockIsTookanEnabled(),
}));

import {
  floristPhotoPublicKey,
  syncApprovedFloristPhotoForOrderToTookan,
  syncApprovedFloristPhotoToTookan,
} from "../floristTookanPhotoSync";

const APPROVED_ROW = {
  assignment_id: 17,
  order_id: "11111111-2222-3333-4444-555555555555",
  photo_items_path: "/objects/owner_123/uploads/prepared-photo",
  photo_set_rev: 4,
  verification_status: "approved",
  tookan_job_id: "tookan-job-42",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTookanEnabled.mockReturnValue(true);
  mockCopyPrivateObjectToPublic.mockResolvedValue(
    "florist-orders/owner_123/11111111-2222-3333-4444-555555555555/prepared-order-rev-4.jpg",
  );
  mockEditTookanDeliveryTask.mockResolvedValue(undefined);
  mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: (...args: unknown[]) => mockClientRelease(...args),
  });
});

describe("syncApprovedFloristPhotoToTookan", () => {
  it("publishes the current approved items photo and sends its public URL to Tookan", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await syncApprovedFloristPhotoToTookan(17, "owner_123");

    expect(mockCopyPrivateObjectToPublic).toHaveBeenCalledWith(
      APPROVED_ROW.photo_items_path,
      "florist-orders/owner_123/11111111-2222-3333-4444-555555555555/prepared-order-rev-4",
      "owner_123",
    );
    expect(mockEditTookanDeliveryTask).toHaveBeenCalledWith(
      "tookan-job-42",
      null,
      {
        referenceImages: [
          "https://os.presentail.com/api/storage/public-objects/florist-orders/owner_123/11111111-2222-3333-4444-555555555555/prepared-order-rev-4.jpg",
        ],
      },
    );
    const commitCallOrder = mockClientQuery.mock.invocationCallOrder[2];
    expect(mockEditTookanDeliveryTask.mock.invocationCallOrder[0]).toBeLessThan(
      commitCallOrder,
    );
    expect(mockClientRelease.mock.invocationCallOrder[0]).toBeGreaterThan(
      commitCallOrder,
    );
    expect(String(mockDbQuery.mock.calls[0][0])).toContain(
      "ofa.workspace_owner_id = $1",
    );
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123", 17]);
  });

  it("does not attach a revision that was replaced after the public copy", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await syncApprovedFloristPhotoToTookan(17, "owner_123");

    expect(mockCopyPrivateObjectToPublic).toHaveBeenCalledTimes(1);
    expect(mockEditTookanDeliveryTask).not.toHaveBeenCalled();
    const recheckSql = String(mockClientQuery.mock.calls[1][0]);
    expect(recheckSql).toContain("ofa.photo_set_rev = $3");
    expect(recheckSql).toContain("ofa.photo_items_path = $4");
    expect(recheckSql).toContain("o.tookan_job_id = $5");
    expect(recheckSql).toContain("LIMIT 1");
    expect(recheckSql).toContain("FOR UPDATE OF ofa, o");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "rejected evidence",
      row: { ...APPROVED_ROW, verification_status: "rejected" },
    },
    {
      name: "missing Tookan task",
      row: { ...APPROVED_ROW, tookan_job_id: null },
    },
    {
      name: "missing items photo",
      row: { ...APPROVED_ROW, photo_items_path: null },
    },
  ])("does not publish $name", async ({ row }) => {
    mockDbQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    await syncApprovedFloristPhotoToTookan(17, "owner_123");

    expect(mockCopyPrivateObjectToPublic).not.toHaveBeenCalled();
    expect(mockEditTookanDeliveryTask).not.toHaveBeenCalled();
  });

  it("does nothing when the integration is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);

    await syncApprovedFloristPhotoToTookan(17, "owner_123");

    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockCopyPrivateObjectToPublic).not.toHaveBeenCalled();
  });

  it("finds approved evidence by order after delayed Tookan task creation", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await syncApprovedFloristPhotoForOrderToTookan(
      APPROVED_ROW.order_id,
      "owner_123",
    );

    expect(String(mockDbQuery.mock.calls[0][0])).toContain("ofa.order_id = $2");
    expect(mockDbQuery.mock.calls[0][1]).toEqual([
      "owner_123",
      APPROVED_ROW.order_id,
    ]);
    expect(mockEditTookanDeliveryTask).toHaveBeenCalledTimes(1);
  });

  it("fails softly on storage and Tookan provider errors", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockCopyPrivateObjectToPublic.mockRejectedValueOnce(new Error("storage down"));

    await expect(
      syncApprovedFloristPhotoToTookan(17, "owner_123"),
    ).resolves.toBeUndefined();

    mockDbQuery.mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [APPROVED_ROW], rowCount: 1 });
    mockEditTookanDeliveryTask.mockRejectedValueOnce(new Error("Tookan down"));

    await expect(
      syncApprovedFloristPhotoToTookan(17, "owner_123"),
    ).resolves.toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockClientQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  it("uses a deterministic revisioned public key", () => {
    expect(floristPhotoPublicKey("owner_123", "order-1", 9)).toBe(
      "florist-orders/owner_123/order-1/prepared-order-rev-9",
    );
  });
});