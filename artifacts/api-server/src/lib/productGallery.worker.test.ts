import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  editImageBuffers: vi.fn(),
  callAI: vi.fn(),
  getObjectEntityFile: vi.fn(),
  savePrivateObject: vi.fn(),
}));

vi.mock("./db", () => ({
  db: { query: mocks.query, connect: mocks.connect },
  withTransaction: vi.fn(),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./objectStorage", () => ({
  objectStorageService: {
    getObjectEntityFile: mocks.getObjectEntityFile,
    savePrivateObject: mocks.savePrivateObject,
  },
}));
vi.mock("./ai/callAI", () => ({
  callAI: mocks.callAI,
}));
vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  editImageBuffers: mocks.editImageBuffers,
}));

import { processProductGalleryWork } from "./productGallery";

function unavailableSlotClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: false }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
}

const claimedCandidate = {
  id: "12",
  run_id: "77",
  gallery_type: "alternative_composition",
  attempts: 1,
  retry_count: 1,
  lease_token: "lease-1",
  workspace_owner_id: "owner-1",
  product_id: 42,
  source_path: "/objects/owner-1/source.png",
  source_version: "source-version",
  product_snapshot: {
    name: "Rose Garden",
    category: "Flowers",
    description: "A bouquet",
    recipe: [],
  },
  model: "gpt-image-2",
  quality: "medium",
  output_size: "1024x1024",
  output_format: "webp",
  prompt_version: "product-gallery-fidelity-v1",
};

function claimingSlotClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock($1)")) return { rows: [{ acquired: true }] };
      if (sql.includes("FOR UPDATE OF c SKIP LOCKED")) return { rows: [{ id: "12" }] };
      if (sql.includes("pg_try_advisory_lock(hashtextextended")) return { rows: [{ acquired: true }] };
      if (sql.includes("UPDATE product_gallery_candidates c")) return { rows: [claimedCandidate] };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

describe("product gallery durable worker ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    mocks.connect.mockImplementation(async () => unavailableSlotClient());
    mocks.callAI.mockImplementation(async (options: any) => options.call(options.requestOptions));
  });

  it("starts the worker before awaited optional startup work and isolates later failures", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source.indexOf("startProductGalleryWorker();")).toBeLessThan(
      source.indexOf("await checkStaleExchangeRates();"),
    );
    expect(source).toContain("product gallery worker remains active");
  });

  it("recovers expired attempts and reconciles their runs before claiming more work", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [{ run_id: "77" }] };
      return { rows: [], rowCount: 0 };
    });

    await processProductGalleryWork();

    const recovery = mocks.query.mock.calls.find(([sql]) => String(sql).includes("WITH expired AS"));
    expect(recovery?.[0]).toContain("WORKER_LEASE_EXPIRED");
    expect(recovery?.[0]).toContain("product_gallery_attempts");
    expect(recovery?.[0]).toContain("retry_count < $1");
    expect(recovery?.[1]).toEqual([3]);

    const reconciliation = mocks.query.mock.calls.find(([sql]) => String(sql).includes("WITH counts AS"));
    expect(reconciliation?.[1]).toEqual([["77"]]);
  });

  it("does not claim work when both database-wide concurrency slots are occupied", async () => {
    const clients = Array.from({ length: 4 }, unavailableSlotClient);
    mocks.connect.mockImplementation(async () => clients.shift()!);

    await Promise.all([processProductGalleryWork(), processProductGalleryWork()]);

    expect(mocks.connect).toHaveBeenCalledTimes(4);
    expect(mocks.editImageBuffers).not.toHaveBeenCalled();
    for (const client of clients) {
      expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"));
    }
  });

  it("does not consume an attempt when another worker still owns the candidate lock", async () => {
    const owningClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock($1)")) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes("FOR UPDATE OF c SKIP LOCKED")) {
          return { rows: [{ id: "12" }] };
        }
        if (sql.includes("hashtextextended")) {
          return { rows: [{ acquired: false }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mocks.connect
      .mockResolvedValueOnce(owningClient)
      .mockImplementation(async () => unavailableSlotClient());

    await processProductGalleryWork();

    expect(owningClient.query).toHaveBeenCalledWith(
      expect.stringContaining("hashtextextended"),
      ["product-gallery-candidate:12"],
    );
    expect(owningClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE product_gallery_candidates c"),
      expect.anything(),
    );
    expect(mocks.editImageBuffers).not.toHaveBeenCalled();
  });

  it("lease-guards claims to active runs", async () => {
    const client = claimingSlotClient();
    mocks.connect
      .mockResolvedValueOnce(client)
      .mockImplementation(async () => unavailableSlotClient());
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [] };
      if (sql.includes("product_gallery_audit_events")) throw new Error("audit unavailable");
      if (sql.includes("UPDATE product_gallery_candidates")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await processProductGalleryWork();

    const dueQuery = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("FOR UPDATE OF c SKIP LOCKED")
    );
    const claimQuery = client.query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE product_gallery_candidates c")
    );
    expect(dueQuery?.[0]).toContain("r.status IN ('PENDING','RUNNING','RETRY_WAITING')");
    expect(claimQuery?.[0]).toContain("r.status IN ('PENDING','RUNNING','RETRY_WAITING')");
  });

  it("durably fails a claimed candidate when attempt setup or audit work fails", async () => {
    const client = claimingSlotClient();
    mocks.connect
      .mockResolvedValueOnce(client)
      .mockImplementation(async () => unavailableSlotClient());
    let auditCalls = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [] };
      if (sql.includes("product_gallery_audit_events") && auditCalls++ === 0) {
        throw new Error("audit unavailable");
      }
      if (sql.includes("UPDATE product_gallery_candidates")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await processProductGalleryWork();

    const fallback = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET status=$3")
    );
    expect(fallback?.[1]).toEqual([
      "12",
      "lease-1",
      "FAILED",
      expect.objectContaining({ code: "GENERATION_FAILED" }),
      false,
      10,
    ]);
    expect(mocks.editImageBuffers).not.toHaveBeenCalled();
  });

  it("retries a transient candidate finalization write under the same lease", async () => {
    const client = claimingSlotClient();
    mocks.connect
      .mockResolvedValueOnce(client)
      .mockImplementation(async () => unavailableSlotClient());
    let auditCalls = 0;
    let finalizationCalls = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [] };
      if (sql.includes("product_gallery_audit_events") && auditCalls++ === 0) {
        throw new Error("audit unavailable");
      }
      if (sql.includes("UPDATE product_gallery_candidates") && sql.includes("SET status=$3")) {
        finalizationCalls += 1;
        if (finalizationCalls === 1) throw new Error("temporary database failure");
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await processProductGalleryWork();

    expect(finalizationCalls).toBe(2);
    const transitions = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("SET status=$3")
    );
    expect(transitions[0]?.[1]?.[1]).toBe("lease-1");
    expect(transitions[1]?.[1]?.[1]).toBe("lease-1");
  });

  it("keeps a successful generated draft reviewable when later audit work fails", async () => {
    const client = claimingSlotClient();
    mocks.connect
      .mockResolvedValueOnce(client)
      .mockImplementation(async () => unavailableSlotClient());
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    mocks.getObjectEntityFile.mockResolvedValue({
      getMetadata: vi.fn().mockResolvedValue([{ contentType: "image/png" }]),
      download: vi.fn().mockResolvedValue([onePixelPng]),
    });
    mocks.editImageBuffers.mockResolvedValue(Buffer.from("generated"));
    mocks.savePrivateObject.mockResolvedValue("/objects/owner-1/generated.webp");
    let auditCalls = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("WITH expired AS")) return { rows: [] };
      if (sql.includes("UPDATE product_gallery_candidates") && sql.includes("status='DRAFT'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("product_gallery_audit_events") && auditCalls++ > 0) {
        throw new Error("audit unavailable");
      }
      return { rows: [], rowCount: 1 };
    });

    await processProductGalleryWork();

    expect(mocks.savePrivateObject).toHaveBeenCalledOnce();
    expect(mocks.editImageBuffers).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      "gpt-image-2",
      expect.objectContaining({ inputFidelity: "high" }),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("status='DRAFT'"),
      ["12", "lease-1", "/objects/owner-1/generated.webp"],
    );
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET status=$3"),
      expect.arrayContaining(["FAILED"]),
    );
  });
});