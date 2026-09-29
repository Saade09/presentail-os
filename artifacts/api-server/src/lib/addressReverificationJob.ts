import { db, withTransaction } from "./db";
import { logger } from "./logger";
import { assessAndGeocode } from "./addressBookAutoLink";
import { assessPlaceValidity, type PlaceAssessment } from "./placeAiAssessor";
import { ADDRESS_REVERIFICATION_WORKER_REVISION } from "./buildInfo";
import { resolveTrustedPlaceGeography } from "./placeGeography";
import {
  type ProviderHealthUpdate,
  type ProviderName,
  type ProviderRunHealth,
} from "./mapProvider.js";

const POLL_INTERVAL_MS = 10_000;
const STALE_RUNNING_MINUTES = 10;
const MAX_ATTEMPTS = 4;
const PROVIDER_DELAY_MS = 1_100;
const CIRCUIT_BREAKER_FAILURES = 3;
let processing = false;
let recoverIndefinitePausesPending = false;

type JobRow = {
  id: string;
  run_id: string;
  workspace_owner_id: string;
  place_id: string;
  assessment_cache?: PlaceAssessment | null;
};

type PlaceRow = {
  canonical_name: string;
  canonical_address: string | null;
  area: string | null;
  verification_state: string;
  city_name: string | null;
  country_code: string | null;
  aliases: string[] | null;
  latitude: string | null;
  longitude: string | null;
  coordinate_source: string | null;
  canonical_name_source: string;
  google_place_id: string | null;
  source_order_id: string | null;
};

export interface AddressReverificationRun {
  id: string;
  status: "PENDING" | "RUNNING" | "PAUSED_PROVIDER_OUTAGE" | "COMPLETED";
  paused_reason: string | null;
  paused_until: string | null;
  outage_provider: string | null;
  outage_failure_type: string | null;
  provider_health: ProviderRunHealth;
  queued: number;
  running: number;
  succeeded: number;
  verified: number;
  repaired: number;
  cleared: number;
  invalid: number;
  unresolved: number;
  failed: number;
  provider_failures: number;
  application_failures: number;
  failure_reason: string | null;
  protected: number;
  skipped: number;
  exact: number;
  landmark: number;
  street: number;
  locality: number;
  coordinates_corrected: number;
  substantial_moves: number;
  total: number;
  selected: number;
  outstanding: number;
  terminal: number;
  snapshot_place_count: number;
  snapshot_eligible_count: number;
  excluded: number;
  reused?: boolean;
  created_at: string;
  completed_at: string | null;
}

const PROVIDER_NAMES: ProviderName[] = ["google_places", "nominatim"];

function readProviderRunHealth(value: ProviderRunHealth | string | null | undefined): ProviderRunHealth {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as ProviderRunHealth;
    } catch {
      return {};
    }
  }
  return value;
}

function allProvidersUnavailable(health: ProviderRunHealth): boolean {
  return PROVIDER_NAMES.every((provider) => {
    const status = health[provider]?.status;
    return status != null && status !== "healthy";
  });
}

function hasHealthyProvider(health: ProviderRunHealth): boolean {
  return PROVIDER_NAMES.some((provider) => health[provider]?.status === "healthy");
}

async function recordRunProviderHealth(
  runId: string,
  update: ProviderHealthUpdate,
): Promise<void> {
  await db.query(
    `UPDATE address_reverification_runs
        SET provider_health = jsonb_set(
              COALESCE(provider_health, '{}'::jsonb),
              ARRAY[$2::text],
              $3::jsonb,
              true
            ),
            updated_at = now()
      WHERE id = $1
        AND (
          provider_health -> $2::text IS NULL
          OR provider_health -> $2::text ->> 'status' IS DISTINCT FROM $3::jsonb ->> 'status'
          OR provider_health -> $2::text ->> 'httpStatus' IS DISTINCT FROM $3::jsonb ->> 'httpStatus'
          OR provider_health -> $2::text ->> 'errorCategory' IS DISTINCT FROM $3::jsonb ->> 'errorCategory'
          OR provider_health -> $2::text ->> 'providerMessage' IS DISTINCT FROM $3::jsonb ->> 'providerMessage'
        )`,
    [runId, update.provider, JSON.stringify(update)],
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMilliseconds(retryAfter: string | null | undefined): number {
  if (!retryAfter) return 0;
  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    const delayMs = seconds * 1_000;
    return Number.isFinite(delayMs) ? delayMs : 0;
  }
  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

export async function getAddressReverificationRun(
  workspaceId: string,
  runId?: string,
): Promise<AddressReverificationRun | null> {
  const result = await db.query<AddressReverificationRun>(
     `SELECT r.id, r.status, r.created_at, r.completed_at, r.provider_health,
             r.snapshot_place_count, r.snapshot_eligible_count,
            CASE WHEN r.status = 'PAUSED_PROVIDER_OUTAGE' THEN r.paused_reason ELSE NULL END AS paused_reason,
            CASE WHEN r.status = 'PAUSED_PROVIDER_OUTAGE' THEN r.paused_until ELSE NULL END AS paused_until,
            CASE WHEN r.status = 'PAUSED_PROVIDER_OUTAGE' THEN r.outage_provider ELSE NULL END AS outage_provider,
            CASE WHEN r.status = 'PAUSED_PROVIDER_OUTAGE' THEN r.outage_failure_type ELSE NULL END AS outage_failure_type,
            COUNT(j.id)::int AS total,
             COUNT(j.id)::int AS selected,
             COUNT(j.id) FILTER (WHERE j.status IN ('PENDING', 'RETRY_WAITING', 'RUNNING'))::int AS outstanding,
             COUNT(j.id) FILTER (WHERE j.status IN ('SUCCEEDED', 'INVALID', 'UNRESOLVED', 'FAILED', 'SKIPPED'))::int AS terminal,
             GREATEST(r.snapshot_place_count - COUNT(j.id), 0)::int AS excluded,
            COUNT(j.id) FILTER (WHERE j.status IN ('PENDING', 'RETRY_WAITING'))::int AS queued,
            COUNT(j.id) FILTER (WHERE j.status = 'RUNNING')::int AS running,
            COUNT(j.id) FILTER (WHERE j.status = 'SUCCEEDED')::int AS succeeded,
            COUNT(j.id) FILTER (WHERE j.status = 'SUCCEEDED' AND j.assessment_status = 'verified')::int AS verified,
            COUNT(j.id) FILTER (WHERE j.status = 'SUCCEEDED' AND j.assessment_status = 'repaired')::int AS repaired,
            COUNT(j.id) FILTER (WHERE j.assessment_status = 'cleared')::int AS cleared,
            COUNT(j.id) FILTER (WHERE j.status = 'INVALID' AND j.assessment_status IS DISTINCT FROM 'cleared')::int AS invalid,
            COUNT(j.id) FILTER (WHERE j.status = 'UNRESOLVED' AND j.assessment_status IS DISTINCT FROM 'cleared')::int AS unresolved,
            COUNT(j.id) FILTER (WHERE j.status = 'FAILED')::int AS failed,
            COUNT(j.id) FILTER (WHERE j.status = 'FAILED' AND j.assessment_status = 'provider_failure')::int AS provider_failures,
            COUNT(j.id) FILTER (WHERE j.status = 'FAILED' AND j.assessment_status = 'application_failure')::int AS application_failures,
             (
               SELECT failed_job.last_error
                 FROM address_reverification_jobs failed_job
                WHERE failed_job.run_id = r.id
                  AND failed_job.status = 'FAILED'
                ORDER BY failed_job.completed_at DESC NULLS LAST, failed_job.updated_at DESC
                LIMIT 1
             ) AS failure_reason,
            COUNT(j.id) FILTER (WHERE j.status = 'SKIPPED' AND j.assessment_status = 'protected')::int AS protected,
            COUNT(j.id) FILTER (WHERE j.status = 'SKIPPED')::int AS skipped
            ,COUNT(j.id) FILTER (WHERE j.result_precision = 'exact')::int AS exact
            ,COUNT(j.id) FILTER (WHERE j.result_precision = 'landmark')::int AS landmark
            ,COUNT(j.id) FILTER (WHERE j.result_precision = 'street')::int AS street
            ,COUNT(j.id) FILTER (WHERE j.result_precision = 'locality')::int AS locality
            ,COUNT(j.id) FILTER (WHERE j.coordinates_changed)::int AS coordinates_corrected
            ,COUNT(j.id) FILTER (WHERE j.movement_km >= 5)::int AS substantial_moves
       FROM address_reverification_runs r
       LEFT JOIN address_reverification_jobs j ON j.run_id = r.id
      WHERE r.workspace_owner_id = $1
        AND ($2::uuid IS NULL OR r.id = $2::uuid)
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [workspaceId, runId ?? null],
  );
  return result.rows[0] ?? null;
}

export async function enqueueAddressReverificationRun(
  workspaceId: string,
  requestedBy?: string | null,
): Promise<AddressReverificationRun> {
  const client = await db.connect();
  let runId: string | undefined;
  let reused = false;
  try {
    await withTransaction(client, async () => {
      // Serialize owner-triggered enqueues for this workspace. This closes the
      // narrow completion/new-run race around the partial active-run index
      // without blocking workers for other workspaces.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`address-reverification:${workspaceId}`],
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO address_reverification_runs (workspace_owner_id, requested_by)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id)
           WHERE status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE')
         DO NOTHING
         RETURNING id`,
        [workspaceId, requestedBy ?? null],
      );
      runId = inserted.rows[0]?.id;

      if (!runId) {
        const active = await client.query<{ id: string }>(
          `SELECT id
             FROM address_reverification_runs
            WHERE workspace_owner_id = $1
              AND status IN ('PENDING', 'RUNNING', 'PAUSED_PROVIDER_OUTAGE')
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [workspaceId],
        );
        runId = active.rows[0]?.id;
        reused = Boolean(runId);
      }

      // The conflicting run may have completed between ON CONFLICT and the
      // follow-up SELECT. In that case, create a fresh run while still holding
      // this transaction rather than losing the owner's request.
      if (!runId) {
        const retryInsert = await client.query<{ id: string }>(
          `INSERT INTO address_reverification_runs (workspace_owner_id, requested_by)
           VALUES ($1, $2)
           RETURNING id`,
          [workspaceId, requestedBy ?? null],
        );
        runId = retryInsert.rows[0]?.id;
      }
      if (!runId) throw new Error("Unable to create or resume reverification run");
      await client.query(
        `UPDATE address_reverification_runs
            SET status = 'PENDING',
                paused_reason = NULL,
                paused_until = NULL,
                outage_provider = NULL,
                outage_failure_type = NULL,
               provider_health = '{}'::jsonb,
                updated_at = now()
          WHERE id = $1 AND status = 'PAUSED_PROVIDER_OUTAGE'`,
        [runId],
      );

      if (!reused) {
        await client.query(
        `INSERT INTO address_reverification_jobs (run_id, workspace_owner_id, place_id)
         SELECT $1, $2, p.id
           FROM places p
          WHERE p.workspace_owner_id = $2
            AND p.archived_at IS NULL
             AND p.verification_state IN ('unverified', 'estimated', 'ai_verified')
             AND (
               (
                 p.verification_state = 'unverified'
                 AND (
                   p.latitude IS NULL
                   OR p.longitude IS NULL
                   OR p.coordinate_source IN ('ai', 'legacy')
                   OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
                 )
               )
               OR (
                 p.verification_state = 'ai_verified'
                 AND (
                   p.coordinate_source IS NULL
                   OR p.coordinate_source IN ('ai', 'legacy')
                   OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
                 )
               )
               OR (
                 p.verification_state = 'estimated'
                 AND (
                   p.coordinate_source IN ('ai', 'legacy')
                   OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
                 )
               )
               OR (
                 p.latitude IS NOT NULL
                 AND p.longitude IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM places duplicate_pin
                    WHERE duplicate_pin.workspace_owner_id = p.workspace_owner_id
                      AND duplicate_pin.id <> p.id
                      AND duplicate_pin.archived_at IS NULL
                      AND round(duplicate_pin.latitude, 5) = round(p.latitude, 5)
                      AND round(duplicate_pin.longitude, 5) = round(p.longitude, 5)
                      AND lower(trim(duplicate_pin.canonical_name)) <> lower(trim(p.canonical_name))
                 )
                 AND (
                   p.coordinate_source IN ('ai', 'legacy')
                   OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
                 )
               )
             )
            AND NOT EXISTS (
              SELECT 1
                FROM address_reverification_jobs active
               WHERE active.place_id = p.id
                 AND active.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
            )
         ON CONFLICT (run_id, place_id) DO NOTHING`,
          [runId, workspaceId],
        );
      }
      await client.query(
        `UPDATE address_reverification_runs r
            SET snapshot_eligible_count = CASE
                  WHEN r.snapshot_place_count = 0 THEN counts.selected_count
                  ELSE r.snapshot_eligible_count
                END,
                snapshot_place_count = CASE
                  WHEN r.snapshot_place_count = 0
                    THEN GREATEST(counts.place_count, counts.selected_count)
                  ELSE r.snapshot_place_count
                END
           FROM (
             SELECT
               (SELECT COUNT(*)::int FROM places p
                 WHERE p.workspace_owner_id = $2 AND p.archived_at IS NULL) AS place_count,
               (SELECT COUNT(*)::int FROM address_reverification_jobs j
                 WHERE j.run_id = $1) AS selected_count
           ) counts
          WHERE r.id = $1`,
        [runId, workspaceId],
      );
    });
  } finally {
    client.release();
  }

  if (!runId) throw new Error("Unable to create or resume reverification run");
  await finishRunIfIdle(runId);
  const run = await getAddressReverificationRun(workspaceId, runId);
  if (!run) throw new Error("Reverification run disappeared after creation");
  return { ...run, reused };
}

async function finishRunIfIdle(runId: string): Promise<void> {
  await db.query(
    `UPDATE address_reverification_runs r
        SET status = CASE
              WHEN EXISTS (
                SELECT 1 FROM address_reverification_jobs j
                 WHERE j.run_id = r.id
                   AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
              ) THEN CASE WHEN r.status = 'PENDING' THEN 'RUNNING' ELSE r.status END
              ELSE 'COMPLETED'
            END,
            started_at = COALESCE(started_at, now()),
            completed_at = CASE
              WHEN EXISTS (
                SELECT 1 FROM address_reverification_jobs j
                 WHERE j.run_id = r.id
                   AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
              ) THEN NULL
              ELSE COALESCE(completed_at, now())
            END,
            updated_at = now()
      WHERE r.id = $1`,
    [runId],
  );
}

async function finishAllIdleRuns(): Promise<void> {
  await db.query(
    `UPDATE address_reverification_runs r
        SET status = 'COMPLETED', completed_at = COALESCE(completed_at, now()), updated_at = now()
      WHERE r.status IN ('PENDING', 'RUNNING')
        AND NOT EXISTS (
          SELECT 1 FROM address_reverification_jobs j
           WHERE j.run_id = r.id
             AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
        )`,
  );
}

async function markJob(
  job: JobRow,
  status: "SUCCEEDED" | "INVALID" | "UNRESOLVED" | "FAILED" | "SKIPPED" | "RETRY_WAITING",
  options: {
    assessmentStatus?: string;
    matchedLocation?: string;
    error?: string;
    retryMinutes?: number;
    precision?: string;
    method?: string;
    coordinatesChanged?: boolean;
    movementKm?: number | null;
    provider?: string;
    failureType?: string;
    httpStatus?: number;
    retryAfter?: string | null;
    failureStage?: string;
    failureQuery?: string;
  } = {},
): Promise<void> {
  await db.query(
    `UPDATE address_reverification_jobs
        SET status = $2::text,
            assessment_status = $3::text,
            matched_location = $4::text,
            last_error = $5::text,
            result_precision = $7::text,
            verification_method = $8::text,
            coordinates_changed = COALESCE($9::boolean, coordinates_changed),
            movement_km = $10::numeric,
            failure_provider = $11::text,
            failure_type = $12::text,
            failure_http_status = $13::integer,
            failure_retry_after = $14::text,
            failure_stage = $15::text,
            failure_query = $16::text,
            next_retry_at = CASE
               WHEN $2::text = 'RETRY_WAITING' THEN now() + ($6::integer * interval '1 minute')
              ELSE NULL
            END,
            completed_at = CASE WHEN $2::text = 'RETRY_WAITING' THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $1`,
    [
      job.id,
      status,
      options.assessmentStatus ?? null,
      options.matchedLocation ?? null,
      options.error ?? null,
      options.retryMinutes ?? 1,
      options.precision ?? null,
      options.method ?? null,
      options.coordinatesChanged ?? null,
      options.movementKm ?? null,
      options.provider ?? null,
      options.failureType ?? null,
      options.httpStatus ?? null,
      options.retryAfter ?? null,
      options.failureStage ?? null,
      options.failureQuery ?? null,
    ],
  );
  await finishRunIfIdle(job.run_id);
}

function movementKm(
  previousLat: string | null,
  previousLng: string | null,
  nextLat: number | null | undefined,
  nextLng: number | null | undefined,
): number | null {
  if (previousLat == null || previousLng == null || nextLat == null || nextLng == null) return null;
  const lat1 = Number(previousLat) * Math.PI / 180;
  const lat2 = nextLat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (nextLng - Number(previousLng)) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function processJob(job: JobRow): Promise<void> {
  const runHealthResult = await db.query<{ provider_health: ProviderRunHealth | string | null }>(
    `SELECT provider_health FROM address_reverification_runs WHERE id = $1`,
    [job.run_id],
  );
  const providerHealth = readProviderRunHealth(runHealthResult.rows[0]?.provider_health);
  const skipProviders: ProviderName[] = PROVIDER_NAMES.filter((provider) => {
    const status = providerHealth[provider]?.status;
    return status === "configuration_failure" || status === "disabled_unconfigured";
  });
  const placeResult = await db.query<PlaceRow>(
    `SELECT p.canonical_name, p.canonical_address, p.area, p.verification_state,
            p.latitude, p.longitude, p.coordinate_source, p.canonical_name_source,
            p.google_place_id, p.source_order_id,
            dc.name AS city_name, dc.country_code,
            ARRAY(
              SELECT pa.alias_text
                FROM place_aliases pa
               WHERE pa.place_id = p.id
                 AND pa.deleted_at IS NULL
                 AND COALESCE(pa.approval_state, 'approved') = 'approved'
               ORDER BY pa.created_at
            ) AS aliases
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.id = $1
        AND p.workspace_owner_id = $2
        AND p.archived_at IS NULL`,
    [job.place_id, job.workspace_owner_id],
  );
  const place = placeResult.rows[0];
  const resolvedGeography = place
    ? await resolveTrustedPlaceGeography(job.place_id, job.workspace_owner_id)
    : null;
  const geography = resolvedGeography ?? {
    city: place?.city_name ?? null,
    country: place?.country_code ?? null,
    conflict: false,
  };
  const protectedCoordinates = Boolean(place?.latitude != null && place?.longitude != null) && (
    place?.coordinate_source === "manual" ||
    place?.coordinate_source === "gps" ||
    place?.coordinate_source === "import" ||
    Boolean(place?.source_order_id) ||
    (place?.coordinate_source === "geocoder" && Boolean(place?.google_place_id))
  );
  if (
    !place ||
    !["unverified", "estimated", "ai_verified"].includes(place.verification_state) ||
    protectedCoordinates
  ) {
    await markJob(job, "SKIPPED", {
      assessmentStatus: "protected",
      error: place ? `Place changed to ${place.verification_state} while queued` : "Place was archived or removed",
    });
    return;
  }

  await db.query(
    `UPDATE places SET ai_invalid = NULL, updated_at = now()
      WHERE id = $1
        AND workspace_owner_id = $2
        AND verification_state IN ('unverified', 'estimated', 'ai_verified')`,
    [job.place_id, job.workspace_owner_id],
  );

  let assessment = job.assessment_cache ?? null;
  if (!assessment && !geography?.conflict) {
    assessment = await assessPlaceValidity(
      place.canonical_name,
      place.aliases ?? [],
      {
        workspaceOwnerId: job.workspace_owner_id,
        canonicalAddress: place.canonical_address,
        area: place.area,
        city: geography?.city ?? null,
        country: geography?.country ?? null,
        geographyConflict: geography?.conflict ?? false,
      },
    );
    await db.query(
      `UPDATE address_reverification_jobs
          SET assessment_cache = $2::jsonb,
              assessment_cached_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [job.id, JSON.stringify(assessment)],
    );
  }

  const result = await assessAndGeocode(
    job.place_id,
    place.canonical_name,
    place.aliases ?? [],
    job.workspace_owner_id,
    assessment ?? undefined,
    {
      canonicalAddress: place.canonical_address,
      area: place.area,
      city: geography?.city ?? null,
      country: geography?.country ?? null,
      geographyConflict: geography?.conflict ?? false,
    },
    {
      skipProviders,
      onProviderHealth: async (update) => {
        await recordRunProviderHealth(job.run_id, update);
        if (update.status === "configuration_failure" || update.status === "disabled_unconfigured") {
          logger.warn(
            {
              runId: job.run_id,
              provider: update.provider,
              status: update.status,
              httpStatus: update.httpStatus,
              errorCategory: update.errorCategory,
              providerMessage: update.providerMessage,
            },
            "address reverification provider degraded for this run",
          );
        }
      },
    },
  );

  if (result.reason === "assessment_failed") {
    const attempts = await db.query<{ attempts: number }>(
      `SELECT attempts FROM address_reverification_jobs WHERE id = $1`,
      [job.id],
    );
    const count = attempts.rows[0]?.attempts ?? MAX_ATTEMPTS;
    const failure = result.failure;
    const retryable = failure?.retryable !== false;
    const configurationFailure = failure?.failureType === "configuration_authentication";
    const retryAfterMs = retryAfterMilliseconds(failure?.retryAfter);
    const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, count - 1));
    const jitterMs = Math.floor(Math.random() * Math.max(1, backoffMs * 0.2));
    const retryMinutes = Math.max(1, Math.ceil(Math.max(retryAfterMs, backoffMs + jitterMs) / 60_000));
    const failureOptions = {
      assessmentStatus: "provider_failure",
      error: failure?.message ?? "Map provider failure",
      provider: failure?.provider,
      failureType: failure?.failureType,
      httpStatus: failure?.httpStatus,
      providerMessage: failure?.providerMessage,
      errorCategory: failure?.errorCategory,
      retryAfter: failure?.retryAfter,
      failureStage: failure?.stage,
      failureQuery: failure?.query,
    };
    if (failure?.failureType === "ambiguity" || failure?.failureType === "zero_results") {
      await markJob(job, "UNRESOLVED", failureOptions);
      return;
    }
    const currentHealthResult = await db.query<{
      provider_health: ProviderRunHealth | string | null;
    }>(
      `SELECT provider_health FROM address_reverification_runs WHERE id = $1`,
      [job.run_id],
    );
    const currentHealth = readProviderRunHealth(currentHealthResult.rows[0]?.provider_health);
    if (hasHealthyProvider(currentHealth)) {
      // A provider error is not a run outage while another provider answered.
      // Keep this address reviewable and continue the rest of the queue.
      await markJob(job, "UNRESOLVED", failureOptions);
      return;
    }
    const totalProviderOutage = allProvidersUnavailable(currentHealth);
    if (retryable || configurationFailure) {
      // Provider failures obey the finite retry budget. A global pause is only
      // considered below after durable health state confirms every provider is
      // unavailable; one broken provider does not block the other.
      if (!configurationFailure && count >= MAX_ATTEMPTS) {
        await markJob(job, "FAILED", failureOptions);
        return;
      }
      await markJob(job, "RETRY_WAITING", {
        ...failureOptions,
        retryMinutes,
      });
      const recent = await db.query<{ failures: number }>(
        `SELECT COUNT(*)::int AS failures
           FROM (
             SELECT assessment_status, failure_provider, failure_type
               FROM address_reverification_jobs
              WHERE run_id = $1 AND status IN ('RETRY_WAITING', 'FAILED', 'SUCCEEDED', 'INVALID', 'UNRESOLVED', 'SKIPPED')
              ORDER BY updated_at DESC
              LIMIT $2
           ) recent
          WHERE assessment_status = 'provider_failure'
            AND failure_provider IS NOT DISTINCT FROM $3::text
            AND failure_type IS NOT DISTINCT FROM $4::text`,
        [job.run_id, CIRCUIT_BREAKER_FAILURES, failure?.provider ?? null, failure?.failureType ?? null],
      );
      if (
        totalProviderOutage &&
        (configurationFailure || (recent.rows[0]?.failures ?? 0) >= CIRCUIT_BREAKER_FAILURES)
      ) {
        await db.query(
          `UPDATE address_reverification_runs
              SET status = 'PAUSED_PROVIDER_OUTAGE',
                  paused_reason = $2::text,
                  paused_until = CASE
                    WHEN $3::boolean THEN NULL
                    ELSE now() + ($4::integer * interval '1 minute')
                  END,
                  outage_provider = $5::text,
                  outage_failure_type = $6::text,
                  updated_at = now()
            WHERE id = $1`,
          [
            job.run_id,
            failure?.message ?? "Map provider outage",
            configurationFailure,
            String(retryMinutes),
            failure?.provider ?? null,
            failure?.failureType ?? null,
          ],
        );
      }
      return;
    }
    await markJob(job, "FAILED", {
      ...failureOptions,
    });
    return;
  }

  if (result.reason === "persistence_failed") {
    await markJob(job, "FAILED", {
      assessmentStatus: "persistence_failure",
      error: result.failure?.message ?? "AI verification result could not be saved",
      failureType: result.failure?.failureType ?? "database_write",
      failureStage: result.failure?.stage ?? "persistence",
      failureQuery: result.failure?.query,
    });
    return;
  }

  if (result.reason === "application_error") {
    // An application-level bug or an unexpected exception (not a map-provider
    // outage). It must never inflate provider_failures or trip the
    // provider-outage circuit breaker, but it still obeys the normal bounded
    // retry budget in case the underlying cause is transient.
    const attempts = await db.query<{ attempts: number }>(
      `SELECT attempts FROM address_reverification_jobs WHERE id = $1`,
      [job.id],
    );
    const count = attempts.rows[0]?.attempts ?? MAX_ATTEMPTS;
    const failure = result.failure;
    const failureOptions = {
      assessmentStatus: "application_failure",
      error: failure?.message ?? "Application error during AI verification",
      failureType: failure?.failureType ?? "application_error",
      failureStage: failure?.stage ?? "assessment",
    };
    if (count >= MAX_ATTEMPTS) {
      await markJob(job, "FAILED", failureOptions);
      return;
    }
    const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, count - 1));
    const jitterMs = Math.floor(Math.random() * Math.max(1, backoffMs * 0.2));
    const retryMinutes = Math.max(1, Math.ceil((backoffMs + jitterMs) / 60_000));
    await markJob(job, "RETRY_WAITING", { ...failureOptions, retryMinutes });
    return;
  }

  if (result.preservedVerifiedCoordinates) {
    await markJob(job, "SKIPPED", {
      assessmentStatus: "protected",
      matchedLocation: result.matchedLocation,
      error: "Place became staff- or delivery-verified while queued",
    });
    return;
  }

  if (result.status === "exact" || result.status === "landmark") {
    const distance = movementKm(
      place.latitude,
      place.longitude,
      result.latitude,
      result.longitude,
    );
    await markJob(job, result.coordinatesUpdated ? "SUCCEEDED" : "SKIPPED", {
      assessmentStatus: result.coordinatesUpdated
        ? (place.latitude != null && place.longitude != null ? "repaired" : "verified")
        : "protected",
      matchedLocation: result.matchedLocation,
      error: result.coordinatesUpdated ? undefined : "Place verification changed while queued",
      precision: result.precision,
      method: result.method,
      coordinatesChanged: Boolean(
        result.coordinatesUpdated &&
        place.latitude != null &&
        place.longitude != null &&
        distance != null &&
        distance > 0.001
      ),
      movementKm: distance,
    });
  } else if (result.status === "invalid") {
    await markJob(job, "INVALID", {
      assessmentStatus: result.coordinatesCleared ? "cleared" : "invalid",
      error: result.reason || "AI classified the text as not being a usable address",
    });
  } else {
    const failureType = result.failure?.failureType ??
      (result.reason === "geography_conflict"
        ? "locality_contradiction"
        : result.reason === "review_required_precision"
          ? "insufficient_precision"
          : "zero_results");
    await markJob(job, "UNRESOLVED", {
      assessmentStatus: result.coordinatesCleared ? "cleared" : "unresolved",
      error: result.reason || "No validated map result passed locality safeguards",
      provider: result.failure?.provider,
      failureType,
      httpStatus: result.failure?.httpStatus,
      retryAfter: result.failure?.retryAfter,
      failureStage: result.failure?.stage ?? "geocode",
      failureQuery: result.failure?.query ?? place.canonical_name,
    });
  }
}

export async function processPendingAddressReverificationJobs(options: {
  recoverIndefinitePauses?: boolean;
} = {}): Promise<void> {
  if (options.recoverIndefinitePauses) {
    recoverIndefinitePausesPending = true;
  }
  if (processing) return;
  processing = true;
  const recoverIndefinitePauses = recoverIndefinitePausesPending;
  recoverIndefinitePausesPending = false;
  try {
    await db.query(
      `UPDATE address_reverification_runs
          SET status = 'PENDING',
              paused_reason = NULL,
              paused_until = NULL,
               outage_provider = NULL,
               outage_failure_type = NULL,
              updated_at = now()
        WHERE status = 'PAUSED_PROVIDER_OUTAGE'
           AND (
             (paused_until IS NOT NULL AND paused_until <= now())
             OR ($1::boolean AND paused_until IS NULL)
           )`,
      [recoverIndefinitePauses],
    );
    await db.query(
      `UPDATE address_reverification_jobs
          SET status = CASE WHEN attempts >= $1 THEN 'FAILED' ELSE 'PENDING' END,
              last_error = CASE WHEN attempts >= $1 THEN 'Worker retries exhausted after stale recovery' ELSE last_error END,
              completed_at = CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
              updated_at = now()
        WHERE status = 'RUNNING'
          AND updated_at < now() - INTERVAL '${STALE_RUNNING_MINUTES} minutes'`,
      [MAX_ATTEMPTS],
    );
    // Older retry rows can have no schedule because they were written before
    // retry timestamps were persisted. Make active runs eligible immediately,
    // while retaining the claim-side NULL check for rows resumed later from a
    // paused run.
    await db.query(
      `UPDATE address_reverification_jobs j
          SET next_retry_at = now(),
              updated_at = now()
        WHERE j.status = 'RETRY_WAITING'
          AND j.next_retry_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM address_reverification_runs r
             WHERE r.id = j.run_id
               AND r.status IN ('PENDING', 'RUNNING')
          )`,
    );
    await finishAllIdleRuns();

    while (true) {
      const claimed = await db.query<JobRow>(
        `WITH next_job AS (
           SELECT id
             FROM address_reverification_jobs j
            WHERE (
                  j.status = 'PENDING'
                   OR (
                     j.status = 'RETRY_WAITING'
                     AND (j.next_retry_at IS NULL OR j.next_retry_at <= now())
                   )
                )
              AND EXISTS (
                SELECT 1 FROM address_reverification_runs r
                 WHERE r.id = j.run_id
                   AND r.status IN ('PENDING', 'RUNNING')
              )
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE address_reverification_jobs j
            SET status = 'RUNNING',
                attempts = attempts + 1,
                started_at = COALESCE(started_at, now()),
                updated_at = now()
           FROM next_job
          WHERE j.id = next_job.id
         RETURNING j.id::text, j.run_id, j.workspace_owner_id, j.place_id, j.assessment_cache`,
      );
      const job = claimed.rows[0];
      if (!job) return;
      const runState = await db.query<{ status: string }>(
        `SELECT status FROM address_reverification_runs WHERE id = $1`,
        [job.run_id],
      );
      if (runState.rows[0]?.status === "PAUSED_PROVIDER_OUTAGE") {
        await db.query(
          `UPDATE address_reverification_jobs SET status = 'PENDING', attempts = GREATEST(0, attempts - 1), updated_at = now() WHERE id = $1`,
          [job.id],
        );
        return;
      }
      await db.query(
        `UPDATE address_reverification_runs
            SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now()
          WHERE id = $1`,
        [job.run_id],
      );
      try {
        await processJob(job);
      } catch (err) {
        logger.warn({ err, jobId: job.id, placeId: job.place_id }, "address reverification job failed");
        const attempts = await db.query<{ attempts: number }>(
          `SELECT attempts FROM address_reverification_jobs WHERE id = $1`,
          [job.id],
        );
        const exhausted = (attempts.rows[0]?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
        // Anything that throws out of processJob is, by construction, not a
        // map-provider failure: provider calls happen only inside
        // assessAndGeocode, which already catches MapProviderError and
        // returns a structured result instead of throwing. Whatever reaches
        // here is a worker/database-level bug (e.g. a place lookup query, a
        // direct assessPlaceValidity call, or a markJob write) and must be
        // classified separately so it never inflates provider_failures or
        // trips the provider-outage circuit breaker.
        await markJob(job, exhausted ? "FAILED" : "RETRY_WAITING", {
          assessmentStatus: "application_failure",
          error: exhausted
            ? `Worker retries exhausted: ${err instanceof Error ? err.message : String(err)}`
            : err instanceof Error ? err.message : String(err),
          failureType: "application_error",
          retryMinutes: 1,
        });
      }
      const state = await db.query<{ status: string }>(
        `SELECT status FROM address_reverification_runs WHERE id = $1`,
        [job.run_id],
      );
      if (state.rows[0]?.status === "PAUSED_PROVIDER_OUTAGE") return;
      await delay(PROVIDER_DELAY_MS);
    }
  } finally {
    processing = false;
    if (recoverIndefinitePausesPending) {
      void processPendingAddressReverificationJobs({
        recoverIndefinitePauses: true,
      });
    }
  }
}

export function startAddressReverificationJob(): void {
  void processPendingAddressReverificationJobs({ recoverIndefinitePauses: true });
  const timer = setInterval(() => {
    void processPendingAddressReverificationJobs();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  logger.info(
    { revision: ADDRESS_REVERIFICATION_WORKER_REVISION },
    "address reverification worker started",
  );
}