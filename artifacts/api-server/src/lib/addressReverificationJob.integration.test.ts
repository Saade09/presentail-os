/**
 * Regression coverage for provider-failure bookkeeping in the address
 * reverification worker. These tests intentionally use PostgreSQL instead of
 * inspecting mocked query arguments so untyped parameters fail here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_PREFIX = `__address_reverification_sql_${Date.now()}`;

const mockAssessAndGeocode = vi.fn();
const mockAssessPlaceValidity = vi.fn();

vi.mock("./addressBookAutoLink", () => ({
  assessAndGeocode: (...args: unknown[]) => mockAssessAndGeocode(...args),
}));
vi.mock("./placeAiAssessor", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
}));

import {
  enqueueAddressReverificationRun,
  getAddressReverificationRun,
  processPendingAddressReverificationJobs,
} from "./addressReverificationJob";

describe.skipIf(!DATABASE_URL)("address reverification provider-failure SQL (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let ownerCounter = 0;
  const owners: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(() => {
    mockAssessAndGeocode.mockReset();
    mockAssessPlaceValidity.mockReset();
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "usable address" });
  });

  afterAll(async () => {
    for (const owner of owners) {
      await pool.query(`DELETE FROM address_reverification_runs WHERE workspace_owner_id = $1`, [owner]);
      await pool.query(`DELETE FROM places WHERE workspace_owner_id = $1`, [owner]);
    }
    await pool.end();
  });

  function newOwner(): string {
    const owner = `${OWNER_PREFIX}_${ownerCounter++}`;
    owners.push(owner);
    return owner;
  }

  it("freezes a reused run population and preserves the selected accounting invariant", async () => {
    const owner = newOwner();
    await pool.query(
      `INSERT INTO places (workspace_owner_id, canonical_name, verification_state)
       SELECT $1, 'Population ' || n, 'unverified'
         FROM generate_series(1, 3) n`,
      [owner],
    );
    const first = await enqueueAddressReverificationRun(owner, "owner");
    expect(first.selected).toBe(3);
    expect(first.selected).toBe(first.queued + first.running + first.terminal);
    expect(first.snapshot_place_count).toBe(first.selected + first.excluded);

    await pool.query(
      `INSERT INTO places (workspace_owner_id, canonical_name, verification_state)
       VALUES ($1, 'Created after run snapshot', 'unverified')`,
      [owner],
    );
    const reused = await enqueueAddressReverificationRun(owner, "owner");
    expect(reused.reused).toBe(true);
    expect(reused.selected).toBe(3);
    expect(reused.snapshot_place_count).toBe(first.snapshot_place_count);
    expect(reused.selected).toBe(reused.queued + reused.running + reused.terminal);
    expect(reused.snapshot_place_count).toBe(reused.selected + reused.excluded);

    await pool.query(
      `UPDATE address_reverification_jobs SET status = 'SKIPPED', assessment_status = 'test_cleanup'
        WHERE run_id = $1`,
      [first.id],
    );
    await pool.query(
      `UPDATE address_reverification_runs SET status = 'COMPLETED', completed_at = now()
        WHERE id = $1`,
      [first.id],
    );
  });

  it("creates a fresh snapshot for terminal unresolved places without selecting protected evidence", async () => {
    const owner = newOwner();
    const failedPlace = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name, verification_state)
       VALUES ($1, 'Previously failed place', 'unverified')
       RETURNING id`,
      [owner],
    );
    const protectedPlace = await pool.query<{ id: string }>(
      `INSERT INTO places (
         workspace_owner_id, canonical_name, verification_state,
         latitude, longitude, coordinate_source
       )
       VALUES ($1, 'Protected manual place', 'unverified', 33.9, 35.5, 'manual')
       RETURNING id`,
      [owner],
    );
    const oldRun = await enqueueAddressReverificationRun(owner, "owner");
    expect(oldRun.selected).toBe(1);
    await pool.query(
      `UPDATE address_reverification_jobs
          SET status = 'FAILED', assessment_status = 'provider_failure',
              failure_provider = 'nominatim', failure_type = 'upstream_5xx',
              completed_at = now()
        WHERE run_id = $1 AND place_id = $2`,
      [oldRun.id, failedPlace.rows[0].id],
    );
    await pool.query(
      `UPDATE address_reverification_runs SET status = 'COMPLETED', completed_at = now()
        WHERE id = $1`,
      [oldRun.id],
    );

    const freshRun = await enqueueAddressReverificationRun(owner, "owner");
    expect(freshRun.reused).toBe(false);
    expect(freshRun.selected).toBe(1);
    const selected = await pool.query<{ place_id: string }>(
      `SELECT place_id FROM address_reverification_jobs WHERE run_id = $1`,
      [freshRun.id],
    );
    expect(selected.rows).toEqual([{ place_id: failedPlace.rows[0].id }]);
    expect(selected.rows.some((row) => row.place_id === protectedPlace.rows[0].id)).toBe(false);
    const place = await pool.query<{ verification_state: string }>(
      `SELECT verification_state FROM places WHERE id = $1`,
      [failedPlace.rows[0].id],
    );
    expect(place.rows[0].verification_state).toBe("unverified");
  });

  async function seedRun(owner: string, placeCount = 1): Promise<{
    runId: string;
    placeIds: string[];
  }> {
    const runResult = await pool.query<{ id: string }>(
      `INSERT INTO address_reverification_runs (workspace_owner_id, status)
       VALUES ($1, 'PENDING')
       RETURNING id`,
      [owner],
    );
    const runId = runResult.rows[0].id;
    const placeIds: string[] = [];
    for (let index = 0; index < placeCount; index += 1) {
      const placeResult = await pool.query<{ id: string }>(
        `INSERT INTO places (workspace_owner_id, canonical_name, verification_state)
         VALUES ($1, $2, 'unverified')
         RETURNING id`,
        [owner, `Reverification test place ${index}`],
      );
      const placeId = placeResult.rows[0].id;
      placeIds.push(placeId);
      await pool.query(
        `INSERT INTO address_reverification_jobs (run_id, workspace_owner_id, place_id)
         VALUES ($1, $2, $3)`,
        [runId, owner, placeId],
      );
    }
    return { runId, placeIds };
  }

  it("persists a transient outage, preserves queued work, and resumes it after the retry time", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner, 3);
    await pool.query(
      `UPDATE address_reverification_runs
          SET provider_health = '{
            "google_places": {"status": "temporarily_unavailable", "httpStatus": 503},
            "nominatim": {"status": "temporarily_unavailable", "httpStatus": 503}
          }'::jsonb
        WHERE id = $1`,
      [runId],
    );
    await pool.query(
      `UPDATE address_reverification_jobs
          SET status = 'FAILED',
              attempts = 1,
              assessment_status = 'provider_failure',
              failure_provider = 'nominatim',
              failure_type = 'upstream_5xx',
              updated_at = now() - interval '1 minute'
        WHERE run_id = $1
          AND place_id IN ($2, $3)`,
      [runId, placeIds[1], placeIds[2]],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        httpStatus: 503,
        retryAfter: "120",
        stage: "geocode",
        query: "Reverification test place 0",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });

    await processPendingAddressReverificationJobs();

    const paused = await pool.query<{
      status: string;
      queued: number;
      paused_reason: string | null;
      paused_until: string | null;
      outage_provider: string | null;
      outage_failure_type: string | null;
    }>(
      `SELECT r.status,
              COUNT(j.id) FILTER (WHERE j.status IN ('PENDING', 'RETRY_WAITING'))::int AS queued,
              r.paused_reason, r.paused_until, r.outage_provider, r.outage_failure_type
         FROM address_reverification_runs r
         LEFT JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1
        GROUP BY r.id`,
      [runId],
    );
    expect(paused.rows[0]).toMatchObject({
      status: "PAUSED_PROVIDER_OUTAGE",
      queued: 1,
      paused_reason: "Nominatim returned HTTP 503",
      outage_provider: "nominatim",
      outage_failure_type: "upstream_5xx",
    });
    expect(paused.rows[0].paused_until).not.toBeNull();
    expect(new Date(paused.rows[0].paused_until!).getTime()).toBeGreaterThan(Date.now());

    const retrying = await pool.query<{
      status: string;
      assessment_status: string;
      failure_provider: string | null;
      failure_type: string | null;
      failure_http_status: number | null;
      failure_retry_after: string | null;
      next_retry_at: string | null;
    }>(
      `SELECT status, assessment_status, failure_provider, failure_type,
              failure_http_status, failure_retry_after, next_retry_at
         FROM address_reverification_jobs
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(retrying.rows[0]).toMatchObject({
      status: "RETRY_WAITING",
      assessment_status: "provider_failure",
      failure_provider: "nominatim",
      failure_type: "upstream_5xx",
      failure_http_status: 503,
      failure_retry_after: "120",
    });
    expect(retrying.rows[0].next_retry_at).not.toBeNull();

    await pool.query(
      `UPDATE address_reverification_runs
          SET paused_until = now() - interval '1 minute'
        WHERE id = $1`,
      [runId],
    );
    await pool.query(
      `UPDATE address_reverification_jobs
          SET next_retry_at = now() - interval '1 minute'
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Reverification test place 0",
      latitude: 33.9,
      longitude: 35.5,
      coordinatesUpdated: true,
      precision: "exact",
      method: "exact_match",
    });

    await processPendingAddressReverificationJobs();

    const resumed = await pool.query<{ status: string; failed: number; queued: number }>(
      `SELECT r.status, r.paused_reason, r.paused_until, r.outage_provider, r.outage_failure_type,
              COUNT(j.id) FILTER (WHERE j.status = 'FAILED')::int AS failed,
              COUNT(j.id) FILTER (WHERE j.status IN ('PENDING', 'RETRY_WAITING'))::int AS queued
         FROM address_reverification_runs r
         LEFT JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1
        GROUP BY r.id`,
      [runId],
    );
    expect(resumed.rows[0]).toEqual({
      status: "COMPLETED",
      paused_reason: null,
      paused_until: null,
      outage_provider: null,
      outage_failure_type: null,
      failed: 2,
      queued: 0,
    });
    const completedJob = await pool.query<{ status: string }>(
      `SELECT status FROM address_reverification_jobs WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(completedJob.rows[0].status).toBe("SUCCEEDED");
  });

  it("exhausts a structured provider retry and completes the run with failure metadata", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner);
    await pool.query(
      `UPDATE address_reverification_jobs
          SET attempts = 3
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        httpStatus: 503,
        stage: "geocode",
        query: "Reverification test place 0",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });

    await processPendingAddressReverificationJobs();

    const state = await pool.query<{
      run_status: string;
      job_status: string;
      assessment_status: string | null;
      failure_provider: string | null;
      failure_type: string | null;
      failure_http_status: number | null;
      failure_stage: string | null;
      failure_query: string | null;
      last_error: string | null;
    }>(
      `SELECT r.status AS run_status, j.status AS job_status, j.assessment_status,
              j.failure_provider, j.failure_type, j.failure_http_status,
              j.failure_stage, j.failure_query, j.last_error
         FROM address_reverification_runs r
         JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1 AND j.place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(state.rows[0]).toEqual({
      run_status: "COMPLETED",
      job_status: "FAILED",
      assessment_status: "provider_failure",
      failure_provider: "nominatim",
      failure_type: "upstream_5xx",
      failure_http_status: 503,
      failure_stage: "geocode",
      failure_query: "Reverification test place 0",
      last_error: "Nominatim returned HTTP 503",
    });
    await expect(getAddressReverificationRun(owner, runId)).resolves.toMatchObject({
      status: "COMPLETED",
      queued: 0,
      running: 0,
      failed: 1,
      provider_failures: 1,
      failure_reason: "Nominatim returned HTTP 503",
    });
  });

  it("exhausts an application-level failure without inflating provider-failure bookkeeping", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner);
    await pool.query(
      `UPDATE address_reverification_jobs
          SET attempts = 3
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
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

    await processPendingAddressReverificationJobs();

    const state = await pool.query<{
      run_status: string;
      job_status: string;
      assessment_status: string | null;
      failure_provider: string | null;
      failure_type: string | null;
      last_error: string | null;
    }>(
      `SELECT r.status AS run_status, j.status AS job_status, j.assessment_status,
              j.failure_provider, j.failure_type, j.last_error
         FROM address_reverification_runs r
         JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1 AND j.place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(state.rows[0]).toEqual({
      run_status: "COMPLETED",
      job_status: "FAILED",
      assessment_status: "application_failure",
      failure_provider: null,
      failure_type: "application_error",
      last_error: "Unexpected AI response shape",
    });
    // An application bug must be counted separately from provider outages so
    // it never appears as evidence of a map-provider failure to an operator.
    await expect(getAddressReverificationRun(owner, runId)).resolves.toMatchObject({
      status: "COMPLETED",
      failed: 1,
      provider_failures: 0,
      application_failures: 1,
    });
  });

  it("recovers a retrying job with a null retry timestamp", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner);
    await pool.query(
      `UPDATE address_reverification_jobs
          SET status = 'RETRY_WAITING',
              next_retry_at = NULL,
              assessment_status = 'provider_failure',
              last_error = 'legacy retry without a schedule'
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Reverification test place 0",
      latitude: 33.9,
      longitude: 35.5,
      coordinatesUpdated: true,
      precision: "exact",
      method: "exact_match",
    });

    await processPendingAddressReverificationJobs();

    const recovered = await pool.query<{ run_status: string; job_status: string; attempts: number }>(
      `SELECT r.status AS run_status, j.status AS job_status, j.attempts
         FROM address_reverification_runs r
         JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1 AND j.place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(recovered.rows[0]).toEqual({
      run_status: "COMPLETED",
      job_status: "SUCCEEDED",
      attempts: 1,
    });
  });

  it("accepts null provider metadata and lets a manual start clear a permanent pause", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner);
    await pool.query(
      `UPDATE address_reverification_runs
          SET provider_health = '{
            "google_places": {"status": "configuration_failure", "httpStatus": 403},
            "nominatim": {"status": "disabled_unconfigured"}
          }'::jsonb
        WHERE id = $1`,
      [runId],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        failureType: "configuration_authentication",
        retryable: false,
        message: "Map provider credentials were rejected",
      },
    });

    await processPendingAddressReverificationJobs();

    const paused = await pool.query<{
      status: string;
      paused_until: string | null;
      outage_provider: string | null;
      outage_failure_type: string | null;
      queued: number;
    }>(
      `SELECT r.status, r.paused_until, r.outage_provider, r.outage_failure_type,
              COUNT(j.id) FILTER (WHERE j.status IN ('PENDING', 'RETRY_WAITING'))::int AS queued
         FROM address_reverification_runs r
         LEFT JOIN address_reverification_jobs j ON j.run_id = r.id
        WHERE r.id = $1
        GROUP BY r.id`,
      [runId],
    );
    expect(paused.rows[0]).toEqual({
      status: "PAUSED_PROVIDER_OUTAGE",
      paused_until: null,
      outage_provider: null,
      outage_failure_type: "configuration_authentication",
      queued: 1,
    });
    const queuedJob = await pool.query<{ status: string; failure_provider: string | null }>(
      `SELECT status, failure_provider
         FROM address_reverification_jobs
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(queuedJob.rows[0]).toEqual({ status: "RETRY_WAITING", failure_provider: null });

    const resumed = await enqueueAddressReverificationRun(owner, "manual-resume-owner");
    expect(resumed.status).toBe("RUNNING");
    expect(resumed.provider_health).toEqual({});
    const cleared = await getAddressReverificationRun(owner, runId);
    expect(cleared).toMatchObject({
      id: runId,
      status: "RUNNING",
      paused_reason: null,
      paused_until: null,
      outage_provider: null,
      outage_failure_type: null,
      queued: 1,
    });
    const stillQueued = await pool.query<{ status: string }>(
      `SELECT status FROM address_reverification_jobs WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(stillQueued.rows[0].status).toBe("RETRY_WAITING");
  });

  it("recovers a persisted pause without a retry timestamp once at worker startup", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner);
    await pool.query(
      `UPDATE address_reverification_runs
          SET status = 'PAUSED_PROVIDER_OUTAGE',
              paused_reason = 'historical untyped parameter error',
              paused_until = NULL,
              outage_provider = NULL,
              outage_failure_type = NULL
        WHERE id = $1`,
      [runId],
    );
    await pool.query(
      `UPDATE address_reverification_jobs
          SET status = 'RETRY_WAITING',
              next_retry_at = now() - interval '1 minute',
              assessment_status = 'provider_failure',
              last_error = 'could not determine data type of parameter $4'
        WHERE run_id = $1`,
      [runId],
    );
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Reverification test place 0",
      latitude: 33.9,
      longitude: 35.5,
      coordinatesUpdated: true,
      precision: "exact",
      method: "exact_match",
    });

    await processPendingAddressReverificationJobs({ recoverIndefinitePauses: true });

    const recovered = await getAddressReverificationRun(owner, runId);
    expect(recovered).toMatchObject({
      id: runId,
      status: "COMPLETED",
      paused_reason: null,
      paused_until: null,
      outage_provider: null,
      outage_failure_type: null,
      queued: 0,
      succeeded: 1,
    });
    const job = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts
         FROM address_reverification_jobs
        WHERE run_id = $1 AND place_id = $2`,
      [runId, placeIds[0]],
    );
    expect(job.rows[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
  });

  it("keeps each job's retry timestamp independent from other queued jobs", async () => {
    const owner = newOwner();
    const { runId, placeIds } = await seedRun(owner, 2);
    const futureRetry = await pool.query<{ next_retry_at: string }>(
      `UPDATE address_reverification_jobs
          SET status = 'RETRY_WAITING',
              next_retry_at = now() + interval '1 hour',
              assessment_status = 'provider_failure',
              failure_provider = 'nominatim',
              failure_type = 'upstream_5xx'
        WHERE run_id = $1 AND place_id = $2
        RETURNING next_retry_at`,
      [runId, placeIds[1]],
    );
    const originalFutureRetry = futureRetry.rows[0].next_retry_at;
    mockAssessAndGeocode.mockResolvedValue({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "nominatim",
        failureType: "upstream_5xx",
        retryable: true,
        message: "Nominatim returned HTTP 503",
      },
    });

    await processPendingAddressReverificationJobs();

    const jobs = await pool.query<{
      place_id: string;
      status: string;
      next_retry_at: string | null;
    }>(
      `SELECT place_id, status, next_retry_at
         FROM address_reverification_jobs
        WHERE run_id = $1
        ORDER BY place_id`,
      [runId],
    );
    const processedJob = jobs.rows.find((job) => job.place_id === placeIds[0]);
    const untouchedJob = jobs.rows.find((job) => job.place_id === placeIds[1]);
    expect(processedJob?.status).toBe("RETRY_WAITING");
    expect(processedJob?.next_retry_at).not.toBeNull();
    expect(untouchedJob).toMatchObject({
      place_id: placeIds[1],
      status: "RETRY_WAITING",
      next_retry_at: originalFutureRetry,
    });
  });

  it("does not drop startup recovery when normal processing is already active", async () => {
    const activeOwner = newOwner();
    const pausedOwner = newOwner();
    await seedRun(activeOwner);
    const { runId: pausedRunId, placeIds: pausedPlaceIds } = await seedRun(pausedOwner);
    await pool.query(
      `UPDATE address_reverification_runs
          SET status = 'PAUSED_PROVIDER_OUTAGE',
              paused_reason = 'historical untyped parameter error',
              paused_until = NULL
        WHERE id = $1`,
      [pausedRunId],
    );
    await pool.query(
      `UPDATE address_reverification_jobs
          SET status = 'RETRY_WAITING',
              next_retry_at = now() - interval '1 minute'
        WHERE run_id = $1`,
      [pausedRunId],
    );

    let releaseActiveAssessment: (() => void) | undefined;
    const activeAssessmentStarted = new Promise<void>((resolve) => {
      mockAssessAndGeocode.mockImplementationOnce(
        () => new Promise((release) => {
          releaseActiveAssessment = () => {
            release({
              status: "exact",
              matchedLocation: "Reverification test active place",
              latitude: 33.9,
              longitude: 35.5,
              coordinatesUpdated: true,
              precision: "exact",
              method: "exact_match",
            });
          };
          resolve();
        }),
      );
    });
    mockAssessAndGeocode.mockResolvedValue({
      status: "exact",
      matchedLocation: "Reverification test paused place",
      latitude: 33.9,
      longitude: 35.5,
      coordinatesUpdated: true,
      precision: "exact",
      method: "exact_match",
    });

    const normalProcessing = processPendingAddressReverificationJobs();
    await activeAssessmentStarted;
    await processPendingAddressReverificationJobs({ recoverIndefinitePauses: true });
    releaseActiveAssessment?.();
    await normalProcessing;

    await vi.waitFor(async () => {
      const recovered = await getAddressReverificationRun(pausedOwner, pausedRunId);
      expect(recovered).toMatchObject({
        status: "COMPLETED",
        paused_reason: null,
        paused_until: null,
        outage_provider: null,
        outage_failure_type: null,
        queued: 0,
        succeeded: 1,
      });
    }, { timeout: 5_000, interval: 50 });
    const queuedJob = await pool.query<{ status: string }>(
      `SELECT status
         FROM address_reverification_jobs
        WHERE run_id = $1 AND place_id = $2`,
      [pausedRunId, pausedPlaceIds[0]],
    );
    expect(queuedJob.rows[0].status).toBe("SUCCEEDED");
  });
});