import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockAssessAndGeocode = vi.fn();
const mockAssessPlaceValidity = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn(async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    })),
  },
  withTransaction: vi.fn(async (_client: unknown, callback: () => Promise<void>) => callback()),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./addressBookAutoLink", () => ({
  assessAndGeocode: (...args: unknown[]) => mockAssessAndGeocode(...args),
}));
vi.mock("./placeAiAssessor", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
}));

import {
  enqueueAddressReverificationRun,
  processPendingAddressReverificationJobs,
} from "./addressReverificationJob";

const RUN = {
  id: "run-1",
  status: "PENDING",
  queued: 2,
  running: 0,
  succeeded: 0,
  invalid: 0,
  unresolved: 0,
  failed: 0,
  skipped: 0,
  total: 2,
  created_at: "2026-08-27T00:00:00.000Z",
  completed_at: null,
};

const JOB = {
  id: "job-1",
  run_id: "run-1",
  workspace_owner_id: "ws-1",
  place_id: "place-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "usable address" });
});

describe("enqueueAddressReverificationRun", () => {
  it("queues active unverified and AI-verified places in the workspace and returns durable totals", async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO address_reverification_runs/i.test(sql)) return Promise.resolve({ rows: [{ id: "run-1" }] });
      return Promise.resolve({ rows: [] });
    });
    mockDbQuery.mockImplementation((sql: string) =>
      /SELECT r\.id, r\.status/i.test(sql)
        ? Promise.resolve({ rows: [RUN] })
        : Promise.resolve({ rows: [] }),
    );

    await expect(enqueueAddressReverificationRun("ws-1", "owner-1")).resolves.toEqual({
      ...RUN,
      reused: false,
    });

    const queueCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO address_reverification_jobs/i.test(String(call[0])),
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      ["address-reverification:ws-1"],
    );
    expect(String(queueCall?.[0])).toContain("p.workspace_owner_id = $2");
    expect(String(queueCall?.[0])).toContain("p.archived_at IS NULL");
    expect(String(queueCall?.[0])).toContain("p.verification_state IN ('unverified', 'estimated', 'ai_verified')");
    expect(String(queueCall?.[0])).toContain("p.coordinate_source IN ('ai', 'legacy')");
    expect(String(queueCall?.[0])).toContain("p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL");
    expect(String(queueCall?.[0])).not.toContain("p.coordinate_source IN ('manual'");
    expect(String(queueCall?.[0])).not.toContain("'gps'");
    expect(String(queueCall?.[0])).not.toContain("'import'");
    expect(String(queueCall?.[0])).toContain("round(duplicate_pin.latitude, 5) = round(p.latitude, 5)");
    expect(String(queueCall?.[0])).toContain("RETRY_WAITING");
    expect(queueCall?.[1]).toEqual(["run-1", "ws-1"]);
  });

  it("reuses the existing active workspace run instead of creating a duplicate", async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO address_reverification_runs/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id[\s\S]*FROM address_reverification_runs/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "run-existing" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockDbQuery.mockImplementation((sql: string) =>
      /SELECT r\.id, r\.status/i.test(sql)
        ? Promise.resolve({ rows: [{ ...RUN, id: "run-existing" }] })
        : Promise.resolve({ rows: [] }),
    );

    const result = await enqueueAddressReverificationRun("ws-1", "owner-1");
    expect(result.id).toBe("run-existing");
    expect(result.reused).toBe(true);
    const queueCall = mockClientQuery.mock.calls.find((call) =>
      /INSERT INTO address_reverification_jobs/i.test(String(call[0])),
    );
    expect(queueCall).toBeUndefined();
    expect(String(mockClientQuery.mock.calls.find((call) =>
      /SELECT id[\s\S]*FROM address_reverification_runs/i.test(String(call[0])),
    )?.[0])).toContain("FOR UPDATE");
  });
});

describe("processPendingAddressReverificationJobs", () => {
  function baseWorkerMock(
    placeState = "unverified",
    providerHealth: Record<string, unknown> = {},
  ) {
    let claimed = false;
    mockDbQuery.mockImplementation((sql: string) => {
      if (/SELECT provider_health FROM address_reverification_runs/i.test(sql)) {
        return Promise.resolve({ rows: [{ provider_health: providerHealth }] });
      }
      if (/UPDATE address_reverification_jobs[\s\S]*status = CASE/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/WITH next_job/i.test(sql)) {
        if (claimed) return Promise.resolve({ rows: [] });
        claimed = true;
        return Promise.resolve({ rows: [JOB] });
      }
      if (/SELECT p\.canonical_name/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            canonical_name: "Saadiyat Beach Villas",
            canonical_address: "Saadiyat Beach Villas",
            area: "Saadiyat",
            verification_state: placeState,
            city_name: "Abu Dhabi",
            country_code: "AE",
            aliases: ["Saadiyat villas"],
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  async function runWorker(): Promise<void> {
    vi.useFakeTimers();
    const pending = processPendingAddressReverificationJobs();
    await vi.advanceTimersByTimeAsync(1_100);
    await pending;
    vi.useRealTimers();
  }

  it("passes canonical data, approved aliases, and locality context to assessment", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "landmark",
      coordinatesUpdated: true,
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi",
    });

    await runWorker();

    expect(mockAssessAndGeocode).toHaveBeenCalledWith(
      "place-1",
      "Saadiyat Beach Villas",
      ["Saadiyat villas"],
      "ws-1",
      { valid: true, reason: "usable address" },
      {
        canonicalAddress: "Saadiyat Beach Villas",
        area: "Saadiyat",
        city: "Abu Dhabi",
        country: "AE",
        geographyConflict: false,
      },
      expect.objectContaining({
        skipProviders: [],
        onProviderHealth: expect.any(Function),
      }),
    );
    const completion = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(completion?.[1]?.[1]).toBe("SUCCEEDED");
  });

  it("reassesses an AI-verified place so its automated pin can be replaced or cleared", async () => {
    baseWorkerMock("ai_verified");
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      coordinatesCleared: true,
    });

    await runWorker();

    expect(mockAssessAndGeocode).toHaveBeenCalledWith(
      "place-1",
      "Saadiyat Beach Villas",
      ["Saadiyat villas"],
      "ws-1",
      { valid: true, reason: "usable address" },
      expect.objectContaining({
        canonicalAddress: "Saadiyat Beach Villas",
        city: "Abu Dhabi",
      }),
      expect.objectContaining({
        skipProviders: [],
        onProviderHealth: expect.any(Function),
      }),
    );
    const completion = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(completion?.[1]?.[1]).toBe("UNRESOLVED");
    expect(completion?.[1]?.[2]).toBe("cleared");
  });

  it("does not call AI assessment when trusted delivery countries conflict", async () => {
    baseWorkerMock();
    const baseImplementation = mockDbQuery.getMockImplementation()!;
    mockDbQuery.mockImplementation((sql: string, ...args: unknown[]) => {
      if (/p\.trusted_country_code AS stored_country/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            city_name: "Beirut",
            stored_country: "LB",
            stored_country_source: "order_ingest",
            city_country: "LB",
            linked_countries: ["AE", "LB"],
          }],
        });
      }
      return baseImplementation(sql, ...args);
    });
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "geography_conflict",
      coordinatesCleared: true,
    });

    await runWorker();

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(mockAssessAndGeocode).toHaveBeenCalledWith(
      "place-1",
      "Saadiyat Beach Villas",
      ["Saadiyat villas"],
      "ws-1",
      undefined,
      expect.objectContaining({
        city: null,
        country: null,
        geographyConflict: true,
      }),
      expect.objectContaining({
        skipProviders: [],
        onProviderHealth: expect.any(Function),
      }),
    );
  });

  it("reports a previously mapped automated place as repaired", async () => {
    baseWorkerMock("estimated");
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT p\.canonical_name/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            canonical_name: "Rue Hamra",
            canonical_address: "Rue Hamra, près de Pain Dor",
            area: "Hamra",
            verification_state: "estimated",
            city_name: "Beirut",
            country_code: "LB",
            aliases: ["شارع الحمرا"],
            latitude: "33.900",
            longitude: "35.480",
            coordinate_source: "geocoder",
            canonical_name_source: "auto",
          }],
        });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      coordinatesUpdated: true,
      matchedLocation: "Hamra Street, Beirut, Lebanon",
    });

    await runWorker();

    const completion = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(completion?.[1]?.[1]).toBe("SUCCEEDED");
    expect(completion?.[1]?.[2]).toBe("repaired");
  });

  it("skips a place whose verification changed while it was queued", async () => {
    baseWorkerMock("staff_verified");

    await runWorker();

    expect(mockAssessAndGeocode).not.toHaveBeenCalled();
    const completion = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(completion?.[1]?.[1]).toBe("SKIPPED");
    expect(completion?.[1]?.[4]).toContain("staff_verified");
  });

  it.each(["invalid", "unresolved"] as const)(
    "marks a write-time protected %s outcome as skipped",
    async (status) => {
      baseWorkerMock();
      mockAssessAndGeocode.mockResolvedValue({
        status,
        preservedVerifiedCoordinates: true,
      });

      await runWorker();

      const completion = mockDbQuery.mock.calls.find((call) =>
        /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
      );
      expect(completion?.[1]?.[1]).toBe("SKIPPED");
      expect(completion?.[1]?.[4]).toContain("staff- or delivery-verified");
    },
  );

  it("retries transient provider failures and records a retry time", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({ status: "unresolved", reason: "assessment_failed" });
    let claimed = false;
    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE address_reverification_jobs[\s\S]*status = CASE/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/WITH next_job/i.test(sql)) {
        if (claimed) return Promise.resolve({ rows: [] });
        claimed = true;
        return Promise.resolve({ rows: [JOB] });
      }
      if (/SELECT p\.canonical_name/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            canonical_name: "Place",
            canonical_address: "Address",
            area: "Area",
            verification_state: "unverified",
            city_name: "City",
            country_code: "AE",
            aliases: [],
          }],
        });
      }
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await runWorker();

    const retry = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(retry?.[1]?.[1]).toBe("RETRY_WAITING");
    expect(String(retry?.[0])).toContain("next_retry_at");
  });

  it("uses bounded backoff when a provider sends an invalid retry-after value", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        retryAfter: "not-a-date",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 1 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const retry = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(retry?.[1]?.[1]).toBe("RETRY_WAITING");
    expect(retry?.[1]?.[5]).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(retry?.[1]?.[5])).toBe(true);
  });

  it("marks a structured transient provider failure terminal at the retry limit", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        httpStatus: 503,
        stage: "geocode",
        query: "Saadiyat Beach Villas",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 4 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const terminal = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(terminal?.[1]?.[1]).toBe("FAILED");
    expect(terminal?.[1]?.[2]).toBe("provider_failure");
    expect(terminal?.[1]?.[4]).toBe("Nominatim returned HTTP 503");
    expect(terminal?.[1]?.[10]).toBe("nominatim");
    expect(terminal?.[1]?.[11]).toBe("upstream_5xx");
    expect(terminal?.[1]?.[12]).toBe(503);
    expect(terminal?.[1]?.[14]).toBe("geocode");
    expect(terminal?.[1]?.[15]).toBe("Saadiyat Beach Villas");
  });

  it("retries a structured application error without counting it as a provider failure", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "application_error",
      failure: {
        provider: "application",
        failureType: "application_error",
        stage: "assessment",
        retryable: true,
        message: "Cannot read properties of undefined (reading 'lat')",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 1 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const retry = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(retry?.[1]?.[1]).toBe("RETRY_WAITING");
    expect(retry?.[1]?.[2]).toBe("application_failure");
    expect(retry?.[1]?.[4]).toBe("Cannot read properties of undefined (reading 'lat')");
    // Application errors must never be attributed to a map provider, or they
    // could inflate provider_failures and trip the outage circuit breaker.
    expect(retry?.[1]?.[10]).toBeNull();
    expect(
      mockDbQuery.mock.calls.some((call) => /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0]))),
    ).toBe(false);
  });

  it("marks a structured application error terminal at the retry limit", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "application_error",
      failure: {
        provider: "application",
        failureType: "application_error",
        stage: "assessment",
        retryable: true,
        message: "Unexpected AI response shape",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 4 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const terminal = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(terminal?.[1]?.[1]).toBe("FAILED");
    expect(terminal?.[1]?.[2]).toBe("application_failure");
    expect(terminal?.[1]?.[4]).toBe("Unexpected AI response shape");
  });

  it("applies the retry limit to structured AI-originated failures", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "openai",
        failureType: "timeout_network",
        stage: "ai_assessment",
        query: "Saadiyat Beach Villas",
        retryable: true,
        message: "AI assessment timed out",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 4 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const terminal = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(terminal?.[1]?.[1]).toBe("FAILED");
    expect(terminal?.[1]?.[4]).toBe("AI assessment timed out");
    expect(terminal?.[1]?.[10]).toBe("openai");
    expect(terminal?.[1]?.[14]).toBe("ai_assessment");
  });

  it("keeps Google disabled after its 403 while later jobs continue through healthy Nominatim", async () => {
    const jobs = [
      { ...JOB },
      { ...JOB, id: "job-2", place_id: "place-2" },
    ];
    const runProviderHealth: Record<string, { status: string; httpStatus: number | null }> = {};
    const claimedStatuses: Array<{ jobId: unknown; status: unknown }> = [];
    let nextJobIndex = 0;

    mockDbQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/SELECT provider_health FROM address_reverification_runs/i.test(sql)) {
        return { rows: [{ provider_health: runProviderHealth }] };
      }
      if (/UPDATE address_reverification_runs[\s\S]*provider_health = jsonb_set/i.test(sql)) {
        const update = JSON.parse(String(params?.[2])) as {
          status: string;
          httpStatus: number | null;
        };
        runProviderHealth[String(params?.[1])] = update;
        return { rows: [] };
      }
      if (/UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(sql)) {
        claimedStatuses.push({ jobId: params?.[0], status: params?.[1] });
        return { rows: [] };
      }
      if (/WITH next_job/i.test(sql)) {
        const job = jobs[nextJobIndex++];
        return { rows: job ? [job] : [] };
      }
      if (/SELECT p\.canonical_name/i.test(sql)) {
        const placeId = String(params?.[0]);
        return {
          rows: [{
            canonical_name: `Test premise ${placeId}`,
            canonical_address: null,
            area: null,
            verification_state: "unverified",
            city_name: "Beirut",
            country_code: "LB",
            aliases: [],
            latitude: null,
            longitude: null,
            coordinate_source: null,
            canonical_name_source: "user",
            google_place_id: null,
            source_order_id: null,
          }],
        };
      }
      return { rows: [] };
    });

    const assessmentOptions: Array<{
      skipProviders: string[];
      onProviderHealth: (update: {
        provider: "google_places" | "nominatim";
        status: "configuration_failure" | "healthy";
        httpStatus: number;
        errorCategory: string | null;
        providerMessage: string | null;
        lastChecked: string;
      }) => Promise<void>;
    }> = [];
    mockAssessAndGeocode.mockImplementation(async (...args: unknown[]) => {
      const options = args[6] as (typeof assessmentOptions)[number];
      assessmentOptions.push(options);
      if (assessmentOptions.length === 1) {
        await options.onProviderHealth({
          provider: "google_places",
          status: "configuration_failure",
          httpStatus: 403,
          errorCategory: "permission_denied_unclassified",
          providerMessage: "The caller does not have permission",
          lastChecked: "2026-09-24T00:00:00.000Z",
        });
        await options.onProviderHealth({
          provider: "nominatim",
          status: "healthy",
          httpStatus: 200,
          errorCategory: null,
          providerMessage: null,
          lastChecked: "2026-09-24T00:00:01.000Z",
        });
      }
      return {
        status: "exact",
        coordinatesUpdated: true,
        matchedLocation: "Test premise, Beirut",
      };
    });

    vi.useFakeTimers();
    const pending = processPendingAddressReverificationJobs();
    try {
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(assessmentOptions).toHaveLength(2);
    expect(assessmentOptions[0].skipProviders).toEqual([]);
    expect(assessmentOptions[1].skipProviders).toEqual(["google_places"]);
    expect(runProviderHealth.google_places).toMatchObject({
      status: "configuration_failure",
      httpStatus: 403,
    });
    expect(runProviderHealth.nominatim).toMatchObject({
      status: "healthy",
      httpStatus: 200,
    });
    expect(claimedStatuses).toEqual([
      { jobId: "job-1", status: "SUCCEEDED" },
      { jobId: "job-2", status: "SUCCEEDED" },
    ]);
    expect(mockDbQuery.mock.calls.some((call) =>
      /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0])),
    )).toBe(false);
  });

  it("keeps processing when Google configuration fails but Nominatim is healthy", async () => {
    baseWorkerMock("unverified", {
      google_places: { status: "configuration_failure", httpStatus: 403 },
      nominatim: { status: "healthy", httpStatus: 200 },
    });
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "google_places",
        failureType: "configuration_authentication",
        httpStatus: 403,
        stage: "text_search",
        query: "Saadiyat Beach Villas",
        retryable: false,
        message: "Google Places credentials were rejected",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 1 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const unresolved = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(unresolved?.[1]?.[1]).toBe("UNRESOLVED");
    expect(unresolved?.[1]?.[10]).toBe("google_places");
    expect(unresolved?.[1]?.[11]).toBe("configuration_authentication");
    expect(unresolved?.[1]?.[12]).toBe(403);
    expect(mockDbQuery.mock.calls.some((call) =>
      /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0])),
    )).toBe(false);
  });

  it("pauses only after all configured providers are unavailable and the outage threshold is met", async () => {
    baseWorkerMock("unverified", {
      google_places: { status: "configuration_failure", httpStatus: 403 },
      nominatim: { status: "temporarily_unavailable", httpStatus: 503 },
    });
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        httpStatus: 503,
        retryAfter: "120",
        stage: "geocode",
        query: "Saadiyat Beach Villas",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 1 }] });
      }
      if (/SELECT COUNT\(\*\)::int AS failures/i.test(sql)) {
        return Promise.resolve({ rows: [{ failures: 3 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const pause = mockDbQuery.mock.calls.find((call) =>
      /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0])),
    );
    expect(pause).toBeDefined();
    expect(pause?.[1]?.[4]).toBe("nominatim");
    expect(pause?.[1]?.[5]).toBe("upstream_5xx");
  });

  it.each(["ambiguity", "zero_results"] as const)(
    "does not treat %s as a provider outage",
    async (failureType) => {
      baseWorkerMock();
      mockAssessAndGeocode.mockResolvedValue({
        status: "unresolved",
        reason: "assessment_failed",
        failure: {
          provider: "google_places",
          failureType,
          retryable: false,
          message: `Address result: ${failureType}`,
        },
      });
      await runWorker();
      expect(mockDbQuery.mock.calls.some((call) =>
        /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0])),
      )).toBe(false);
      const unresolved = mockDbQuery.mock.calls.find((call) =>
        /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
      );
      expect(unresolved?.[1]?.[1]).toBe("UNRESOLVED");
    },
  );

  it.each([
    ["street", "review_required_precision", "insufficient_precision"],
    ["unresolved", "geography_conflict", "locality_contradiction"],
  ] as const)(
    "keeps %s outcomes as per-address review results, not provider outages",
    async (status, reason, failureType) => {
      baseWorkerMock();
      mockAssessAndGeocode.mockResolvedValue({
        status,
        reason,
        ...(failureType === "insufficient_precision"
          ? { failure: { provider: "nominatim", failureType, retryable: false } }
          : {}),
      });

      await runWorker();

      const unresolved = mockDbQuery.mock.calls.find((call) =>
        /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
      );
      expect(unresolved?.[1]?.[1]).toBe("UNRESOLVED");
      expect(unresolved?.[1]?.[11]).toBe(failureType);
      expect(mockDbQuery.mock.calls.some((call) =>
        /SET status = 'PAUSED_PROVIDER_OUTAGE'/i.test(String(call[0])),
      )).toBe(false);
    },
  );

  it("classifies an exception thrown out of the worker loop as an application failure, not a provider outage", async () => {
    // Nothing thrown here comes from assessAndGeocode's provider calls (those
    // are already caught and returned as a structured result). An exception
    // that reaches the outer worker loop is a worker/database-level bug and
    // must never be recorded as `provider_failure` — that misclassification
    // previously caused real application bugs to look like map-provider
    // outages and could trip the provider-outage circuit breaker.
    baseWorkerMock();
    mockAssessAndGeocode.mockRejectedValue(new Error("unexpected worker exception"));
    const baseImplementation = mockDbQuery.getMockImplementation();
    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (/SELECT attempts FROM address_reverification_jobs/i.test(sql)) {
        return Promise.resolve({ rows: [{ attempts: 4 }] });
      }
      return baseImplementation?.(sql, params) ?? Promise.resolve({ rows: [] });
    });

    await runWorker();

    const terminal = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs[\s\S]*SET status = \$2/i.test(String(call[0])),
    );
    expect(terminal?.[1]?.[1]).toBe("FAILED");
    expect(terminal?.[1]?.[2]).toBe("application_failure");
    expect(terminal?.[1]?.[4]).toContain("Worker retries exhausted");
    expect(terminal?.[1]?.[11]).toBe("application_error");
  });

  it("recovers stale jobs and completes idle runs even when there is no new claim", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH next_job/i.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await processPendingAddressReverificationJobs();

    expect(mockDbQuery.mock.calls.some((call) =>
      /status = CASE WHEN attempts >= \$1 THEN 'FAILED' ELSE 'PENDING'/i.test(String(call[0])),
    )).toBe(true);
    expect(mockDbQuery.mock.calls.some((call) =>
      /UPDATE address_reverification_runs r[\s\S]*NOT EXISTS/i.test(String(call[0])),
    )).toBe(true);
  });

  it("normalizes null retry timestamps so legacy retry jobs are claimed immediately", async () => {
    baseWorkerMock();
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Saadiyat Beach Villas",
      latitude: 24.5,
      longitude: 54.4,
      coordinatesUpdated: true,
      precision: "exact",
      method: "exact_match",
    });

    await runWorker();

    const recovery = mockDbQuery.mock.calls.find((call) =>
      /UPDATE address_reverification_jobs j[\s\S]*next_retry_at = now\(\)/i.test(String(call[0])),
    );
    expect(recovery).toBeDefined();
    const claim = mockDbQuery.mock.calls.find((call) => /WITH next_job/i.test(String(call[0])));
    expect(String(claim?.[0])).toContain("j.next_retry_at IS NULL");
  });
});