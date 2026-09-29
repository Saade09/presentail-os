import { beforeEach, describe, expect, it, vi } from "vitest";

const copy = vi.fn();
const remove = vi.fn();
const query = vi.fn();
vi.mock("./objectStorage", () => ({ objectStorageService: {
  copyPrivateImageToPublicSanitized: (...args: unknown[]) => copy(...args),
  deletePublicObject: (...args: unknown[]) => remove(...args),
} }));
vi.mock("./db", () => ({ db: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  enqueueRealDeliveryPublication, processRealDeliveryPublications,
  startRealDeliveryPublicationWorker, stopRealDeliveryPublicationWorker,
} from "./realDeliveryPublication";

describe("real delivery publication worker", () => {
  beforeEach(() => {
    copy.mockReset();
    remove.mockReset();
    query.mockReset();
    stopRealDeliveryPublicationWorker();
  });

  it("registers only the approved/completed current revision without enabling it", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await enqueueRealDeliveryPublication({ query } as never, 9, "owner");
    expect(String(query.mock.calls[0][0])).toContain("verification_status='approved'");
    expect(String(query.mock.calls[0][0])).toContain("o.status='completed'");
    expect(String(query.mock.calls[0][0])).toContain("false, NULL, false");
    expect(String(query.mock.calls[0][0])).toContain("automatic");
  });

  it("claims explicitly enabled pending work and saves its opaque copied key as ready", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 4, workspace_owner_id: "owner", assignment_id: 2,
        source_photo_path: "/objects/a", lease_token: "lease" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    copy.mockResolvedValue("real-deliveries/opaque.jpg");
    await processRealDeliveryPublications({ query } as never, 1);
    expect(copy).toHaveBeenCalledWith("/objects/a", expect.stringMatching(/^real-deliveries\//), "owner");
    expect(String(query.mock.calls[3][0])).toContain("publication_status='ready'");
  });

  it("discovers every tick and only reclaims processing work after lease expiry", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await processRealDeliveryPublications({ query } as never, 1);
    expect(String(query.mock.calls[0][0])).toContain("INSERT INTO florist_photo_publications");
    const claimSql = String(query.mock.calls[1][0]);
    expect(claimSql).toContain("publication_status IN ('pending','failed')");
    expect(claimSql).toContain("f.publication_status='processing'");
    expect(claimSql).toContain("f.lease_until < now()");
    expect(claimSql).toContain("ORDER BY f.next_attempt_at NULLS FIRST");
  });

  it("records a retryable failure using an attempt-unique base key", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 4, workspace_owner_id: "owner", assignment_id: 2,
        source_photo_path: "/objects/a", lease_token: "lease" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    copy.mockRejectedValue(new Error("copy failed"));
    await processRealDeliveryPublications({ query } as never, 1);
    expect(copy).toHaveBeenCalledWith(
      "/objects/a",
      expect.stringMatching(/^real-deliveries\/[0-9a-f-]+$/),
      "owner",
    );
    expect(String(query.mock.calls[3][0])).toContain("publication_status='failed'");
    expect(String(query.mock.calls[3][0])).toContain("next_attempt_at");
  });

  it("is idempotent and test-stoppable", () => {
    vi.useFakeTimers();
    startRealDeliveryPublicationWorker();
    startRealDeliveryPublicationWorker();
    expect(vi.getTimerCount()).toBe(1);
    stopRealDeliveryPublicationWorker();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});