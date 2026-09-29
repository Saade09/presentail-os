import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockAssessAndGeocode = vi.fn();
const mockEnqueueReverificationRun = vi.fn();
const mockGetReverificationRun = vi.fn();
const mockProcessReverificationJobs = vi.fn();
const mockAuditExistingAiVerifiedPlaces = vi.fn();
const mockDiagnoseMapProviders = vi.hoisted(() => vi.fn());
const workspaceState = vi.hoisted(() => ({ role: "owner" }));
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockWithTransaction = vi.fn(async (_client: unknown, callback: () => Promise<void>) => callback());

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn(async () => ({ query: mockClientQuery, release: mockClientRelease })),
  },
  withTransaction: (client: unknown, callback: unknown) =>
    mockWithTransaction(client, callback as () => Promise<void>),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  workspace: () => ({
    workspaceOwnerId: "ws-1",
    workspaceRole: workspaceState.role,
    userId: "user-1",
    userEmail: "owner@example.com",
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  assessAndGeocode: (...args: unknown[]) => mockAssessAndGeocode(...args),
  qualifySharedAlias: (alias: string) => ({
    accepted: true,
    normalizedAlias: alias.toLowerCase().trim(),
    reason: "accepted",
    requiresOwnerApproval: false,
  }),
}));

vi.mock("../jobs/addressBookBackfill", () => ({
  runBackfill: vi.fn(),
}));

vi.mock("../lib/addressReverificationJob.js", () => ({
  enqueueAddressReverificationRun: (...args: unknown[]) => mockEnqueueReverificationRun(...args),
  getAddressReverificationRun: (...args: unknown[]) => mockGetReverificationRun(...args),
  processPendingAddressReverificationJobs: (...args: unknown[]) => mockProcessReverificationJobs(...args),
}));

vi.mock("../lib/addressBookAccuracyAudit.js", () => ({
  auditExistingAiVerifiedPlaces: (...args: unknown[]) => mockAuditExistingAiVerifiedPlaces(...args),
}));

vi.mock("../lib/mapProvider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/mapProvider.js")>(),
  diagnoseMapProviders: (...args: unknown[]) => mockDiagnoseMapProviders(...args),
}));

import addressBookRouter from "./addressBook";

const PLACE_ID = "11111111-1111-4111-8111-111111111111";

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api", addressBookRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceState.role = "owner";
  mockDbQuery.mockImplementation((sql: string) => {
    if (/SELECT p\.canonical_name, p\.canonical_address/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          canonical_name: "Saadiyat Beach Villas",
          canonical_address: null,
          area: "Saadiyat",
          city_name: "Abu Dhabi",
          country_code: "AE",
        }],
      });
    }
    if (/SELECT alias_text FROM place_aliases/i.test(sql)) {
      return Promise.resolve({ rows: [{ alias_text: "Saadiyat villas" }] });
    }
    if (/UPDATE places SET ai_invalid = NULL/i.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    if (/SELECT ai_invalid, latitude, longitude, verification_state/i.test(sql)) {
      return Promise.resolve({
        rows: [{
          ai_invalid: false,
          latitude: "24.514",
          longitude: "54.380",
          verification_state: "ai_verified",
        }],
      });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe("POST /api/address-book/places/:id/ai-assess", () => {
  it("returns an AI-verified approximate map match", async () => {
    mockAssessAndGeocode.mockResolvedValue({
      status: "approximate",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      coordinatesUpdated: true,
    });

    const res = await request(app()).post(`/api/address-book/places/${PLACE_ID}/ai-assess`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      assessment_status: "approximate",
      matched_location: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      verification_state: "ai_verified",
      latitude: 24.514,
      longitude: 54.38,
      coordinates_updated: true,
      coordinates_cleared: false,
      preserved_verified_coordinates: false,
    });
    expect(mockAssessAndGeocode).toHaveBeenCalledWith(
      PLACE_ID,
      "Saadiyat Beach Villas",
      ["Saadiyat villas"],
      "ws-1",
      undefined,
      {
        canonicalAddress: null,
        area: "Saadiyat",
        city: "Abu Dhabi",
        country: "AE",
        geographyConflict: false,
      },
    );
  });

  it("keeps invalid and unresolved outcomes distinct", async () => {
    mockAssessAndGeocode.mockResolvedValueOnce({ status: "invalid" });
    const invalid = await request(app()).post(`/api/address-book/places/${PLACE_ID}/ai-assess`);
    expect(invalid.body.assessment_status).toBe("invalid");

    mockAssessAndGeocode.mockResolvedValueOnce({ status: "unresolved" });
    const unresolved = await request(app()).post(`/api/address-book/places/${PLACE_ID}/ai-assess`);
    expect(unresolved.body.assessment_status).toBe("unresolved");
  });

  it("reports when an unsupported stale AI pin was cleared", async () => {
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      coordinatesCleared: true,
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/SELECT p\.canonical_name, p\.canonical_address/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            canonical_name: "Cedar Heights",
            canonical_address: "Cedar Heights, Main Street",
            area: "Hamra",
            city_name: "Beirut",
            country_code: "LB",
          }],
        });
      }
      if (/SELECT alias_text FROM place_aliases/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT ai_invalid, latitude, longitude, verification_state/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            ai_invalid: false,
            latitude: null,
            longitude: null,
            verification_state: "unverified",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app()).post(`/api/address-book/places/${PLACE_ID}/ai-assess`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      assessment_status: "unresolved",
      verification_state: "unverified",
      latitude: null,
      longitude: null,
      coordinates_cleared: true,
    });
  });

  it("reports when a matching result leaves existing verified coordinates untouched", async () => {
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      coordinatesUpdated: false,
      preservedVerifiedCoordinates: true,
    });

    const res = await request(app()).post(`/api/address-book/places/${PLACE_ID}/ai-assess`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      assessment_status: "exact",
      coordinates_updated: false,
      preserved_verified_coordinates: true,
    });
  });
});

describe("bulk address reverification routes", () => {
  const run = {
    id: "22222222-2222-4222-8222-222222222222",
    status: "PENDING",
    queued: 3,
    running: 0,
    succeeded: 0,
    invalid: 0,
    unresolved: 0,
    failed: 0,
    skipped: 0,
    total: 3,
    created_at: "2026-08-27T00:00:00.000Z",
    completed_at: null,
  };

  it("starts one workspace-scoped run and returns its durable progress", async () => {
    mockEnqueueReverificationRun.mockResolvedValue(run);
    mockGetReverificationRun.mockResolvedValue({ ...run, status: "RUNNING", running: 1, queued: 2 });

    const started = await request(app()).post("/api/address-book/reverification-runs");
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ id: run.id, total: 3, queued: 3 });
    expect(mockEnqueueReverificationRun).toHaveBeenCalledWith("ws-1", "user-1");

    const progress = await request(app()).get(`/api/address-book/reverification-runs/${run.id}`);
    expect(progress.status).toBe(200);
    expect(progress.body.run).toMatchObject({ status: "RUNNING", running: 1, queued: 2 });
    expect(mockGetReverificationRun).toHaveBeenCalledWith("ws-1", run.id);
  });

  it("rejects non-owners before a run can be queued or read", async () => {
    workspaceState.role = "member";
    expect((await request(app()).post("/api/address-book/reverification-runs")).status).toBe(403);
    expect((await request(app()).get("/api/address-book/reverification-runs/latest")).status).toBe(403);
    expect(mockEnqueueReverificationRun).not.toHaveBeenCalled();
    expect(mockGetReverificationRun).not.toHaveBeenCalled();
  });

  it("returns the owner-only dry-run accuracy report without starting reverification", async () => {
    const report = {
      dry_run: true,
      metrics: {
        existing_ai_verified_reviewed: 2,
        still_supported: 1,
        materially_different_coordinate: 1,
        locality_contradiction: 0,
        ambiguous: 0,
        insufficient_precision: 0,
        provider_failure: 0,
        protected_coordinate: 0,
        requires_owner_review: 1,
      },
      results: [],
    };
    mockAuditExistingAiVerifiedPlaces.mockResolvedValue(report);

    const response = await request(app())
      .post("/api/address-book/accuracy-audit")
      .send({ limit: 25 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(report);
    expect(mockAuditExistingAiVerifiedPlaces).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      limit: 25,
    });
    expect(mockEnqueueReverificationRun).not.toHaveBeenCalled();
  });

  it("does not expose the accuracy audit to non-owners", async () => {
    workspaceState.role = "member";
    const response = await request(app())
      .post("/api/address-book/accuracy-audit")
      .send({ limit: 25 });

    expect(response.status).toBe(403);
    expect(mockAuditExistingAiVerifiedPlaces).not.toHaveBeenCalled();
  });

  it("provides safe provider status only to owners", async () => {
    mockDiagnoseMapProviders.mockResolvedValue([{
      provider: "google_places",
      endpoint: "https://places.googleapis.com/v1/places:searchText",
      credentialSource: "GOOGLE_PLACES_SERVER_KEY (server-side secret)",
      credentialFingerprint: "0123456789abcdef",
      configured: true,
      reachable: false,
      httpStatus: 403,
      errorCategory: "key_restriction",
      providerMessage: "Requests from this service are restricted",
      providerResponseBody: '{"error":{"status":"PERMISSION_DENIED"}}',
      lastChecked: "2026-09-24T00:00:00.000Z",
    }]);
    const response = await request(app()).post("/api/address-book/provider-diagnostics");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.providers[0]).toMatchObject({
      provider: "google_places",
      configured: true,
      reachable: false,
      httpStatus: 403,
      errorCategory: "key_restriction",
      endpoint: "https://places.googleapis.com/v1/places:searchText",
      credentialSource: "GOOGLE_PLACES_SERVER_KEY (server-side secret)",
    });
    expect(JSON.stringify(response.body)).not.toContain("test-key");

    workspaceState.role = "member";
    expect((await request(app()).post("/api/address-book/provider-diagnostics")).status).toBe(403);
    expect(mockDiagnoseMapProviders).toHaveBeenCalledTimes(1);
  });
});

describe("AI verification Address Book contracts", () => {
  it("accepts the client verification alias, includes AI-verified rows in verified totals, and exposes summary counts", async () => {
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT[\s\S]*p\.id, p\.canonical_name/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: PLACE_ID,
            canonical_name: "AI Verified Place",
            place_type: "home",
            area: "Saadiyat",
            city_id: null,
            city_name: "Abu Dhabi",
            canonical_address: "Saadiyat Beach Villas",
            latitude: "24.514",
            longitude: "54.380",
            entrance_notes: null,
            verification_state: "ai_verified",
            ai_invalid: false,
            delivery_count: "1",
            alias_count: "1",
            contact_count: "1",
            created_at: "2026-08-27T00:00:00.000Z",
            updated_at: "2026-08-27T00:00:00.000Z",
          }],
        });
      }
      if (/SELECT COUNT\(\*\)::text AS total FROM places p WHERE/i.test(sql)) {
        expect(params).toContain("ai_verified");
        return Promise.resolve({ rows: [{ total: "1" }] });
      }
      if (/linked_deliveries_count/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            total: "5",
            unverified: "2",
            verified_count: "3",
            linked_deliveries_count: "8",
            possible_duplicates_count: "1",
            missing_coordinates_count: "2",
            recently_delivered: "4",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app()).get("/api/address-book/places?verification=ai_verified");

    expect(res.status).toBe(200);
    expect(res.body.places[0]).toMatchObject({ verification_state: "ai_verified" });
    expect(res.body.summary).toMatchObject({
      verified_count: 3,
      needs_review_count: 2,
      linked_deliveries_count: 8,
      possible_duplicates_count: 1,
      missing_coordinates_count: 2,
    });
  });

  it("allows an owner to explicitly activate checkout for an AI-verified mapped place", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{
        verification_state: "ai_verified",
        location_conflict: false,
        latitude: "24.514",
        longitude: "54.380",
      }],
    });

    const res = await request(app()).post(`/api/address-book/places/${PLACE_ID}/activate-checkout`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("checkout_ready = true"),
      ["owner@example.com", "ws-1", PLACE_ID],
    );
  });

  it("does not rewrite or duplicate-audit a place already active for checkout", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{
        verification_state: "ai_verified",
        location_conflict: false,
        latitude: "24.514",
        longitude: "54.380",
        checkout_ready: true,
      }],
    });

    const res = await request(app()).post(`/api/address-book/places/${PLACE_ID}/activate-checkout`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, already_active: true });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

describe("bulk checkout activation", () => {
  function clientRows(rows: Array<{
    id: string;
    verification_state: string;
    location_conflict: boolean;
    latitude: string | null;
    longitude: string | null;
    checkout_ready: boolean;
  }>) {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/SELECT id, verification_state/i.test(sql)) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    });
  }

  it("activates only safe places, leaves active rows untouched, and writes one audit event per activation", async () => {
    const activeId = "22222222-2222-4222-8222-222222222222";
    const eligibleId = "33333333-3333-4333-8333-333333333333";
    const unsafeId = "44444444-4444-4444-8444-444444444444";
    clientRows([
      {
        id: activeId,
        verification_state: "staff_verified",
        location_conflict: false,
        latitude: "25.1",
        longitude: "55.1",
        checkout_ready: true,
      },
      {
        id: eligibleId,
        verification_state: "ai_verified",
        location_conflict: false,
        latitude: "25.2",
        longitude: "55.2",
        checkout_ready: false,
      },
      {
        id: unsafeId,
        verification_state: "unverified",
        location_conflict: true,
        latitude: null,
        longitude: null,
        checkout_ready: false,
      },
    ]);

    const res = await request(app()).post("/api/address-book/places/activate-checkout");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      activated: 1,
      already_active: 1,
      skipped: 1,
      blockers: {
        verification_state: 1,
        location_conflict: 1,
        coordinates: 1,
      },
    });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("checkout_ready = true"),
      ["owner@example.com", "ws-1", eligibleId],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("checkout_activated"),
      [eligibleId, "ai_verified", "user-1", "owner@example.com"],
    );
    expect(mockClientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("checkout_ready = true"),
      expect.arrayContaining([activeId]),
    );
  });

  it("is idempotent when every eligible place is already active", async () => {
    clientRows([{
      id: PLACE_ID,
      verification_state: "delivery_verified",
      location_conflict: false,
      latitude: "25.1",
      longitude: "55.1",
      checkout_ready: true,
    }]);

    const res = await request(app()).post("/api/address-book/places/activate-checkout");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activated: 0, already_active: 1, skipped: 0 });
    expect(mockClientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("checkout_activated"),
      expect.anything(),
    );
  });

  it("rejects non-owners before opening a database transaction", async () => {
    workspaceState.role = "member";

    const res = await request(app()).post("/api/address-book/places/activate-checkout");

    expect(res.status).toBe(403);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns a server error and rolls back when the bulk transaction fails", async () => {
    mockClientQuery.mockRejectedValueOnce(new Error("database unavailable"));

    const res = await request(app()).post("/api/address-book/places/activate-checkout");

    expect(res.status).toBe(500);
    expect(mockClientRelease).toHaveBeenCalled();
  });
});