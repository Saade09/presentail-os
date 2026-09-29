import { db, withTransaction } from "./db";
import { logger } from "./logger";
import {
  calculateNextRun,
  normalizeJourneySteps,
  periodForCycle,
  type JourneyStep,
  type StatementCadence,
} from "./supplierStatementCollection";
import {
  renderSupplierStatementMessage,
  sendSupplierStatementEmail,
  sendSupplierStatementWhatsApp,
  supplierStatementProviderReadiness,
  supplierStatementReplyAddress,
} from "./supplierStatementDelivery";

const POLL_INTERVAL_MS = 30_000;
const CLAIM_BATCH = 10;
const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MINUTES = [1, 5, 15];
const STALE_CLAIM_MINUTES = 10;

type ScheduleRow = {
  id: number;
  workspace_owner_id: string;
  supplier_id: number;
  finance_entity_id: number;
  cadence: StatementCadence;
  local_day: number;
  local_time: string;
  timezone: string;
  first_run_date: string;
  journey_id: number | null;
  next_run_at: string | null;
};

type StepRow = {
  id: number;
  request_id: string;
  workspace_owner_id: string;
  step_order: number;
  channel: "email" | "whatsapp";
  scheduled_at: string;
  attempt_count: number;
};

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recipientIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(jsonRecord(item).id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function errorFields(error: unknown): { errorCode: string; errorMessage: string; retryable: boolean } {
  if (error && typeof error === "object") {
    const row = error as { errorCode?: unknown; errorMessage?: unknown; retryable?: unknown };
    return {
      errorCode: typeof row.errorCode === "string" ? row.errorCode : "send_failed",
      errorMessage: typeof row.errorMessage === "string" ? row.errorMessage : "Supplier statement send failed",
      retryable: row.retryable === true,
    };
  }
  return {
    errorCode: "send_failed",
    errorMessage: error instanceof Error ? error.message : "Supplier statement send failed",
    retryable: false,
  };
}

async function loadJourneySnapshot(
  schedule: ScheduleRow,
  client: { query: typeof db.query },
): Promise<{ steps: JourneyStep[]; recipients: Array<Record<string, unknown>>; snapshot: Record<string, unknown> }> {
  const contacts = await client.query(
    `SELECT id, name, role, department, email, phone, whatsapp_phone
       FROM supplier_statement_contacts
      WHERE workspace_owner_id=$1 AND supplier_id=$2
        AND is_active=true AND is_approved=true AND is_selected=true
      ORDER BY name ASC, id ASC`,
    [schedule.workspace_owner_id, schedule.supplier_id],
  );
  if (!schedule.journey_id) {
    return { steps: [], recipients: contacts.rows, snapshot: {} };
  }
  const journey = await client.query(
    `SELECT j.id, j.name, v.version, v.id AS version_id, v.steps, v.recipients, v.escalation_settings
       FROM supplier_statement_journeys j
       JOIN LATERAL (
         SELECT * FROM supplier_statement_journey_versions
          WHERE journey_id=j.id AND workspace_owner_id=j.workspace_owner_id
          ORDER BY version DESC LIMIT 1
       ) v ON true
      WHERE j.id=$1 AND j.workspace_owner_id=$2 AND j.is_active=true
        AND (j.supplier_id IS NULL OR j.supplier_id=$3)`,
    [schedule.journey_id, schedule.workspace_owner_id, schedule.supplier_id],
  );
  const row = journey.rows[0];
  if (!row) return { steps: [], recipients: contacts.rows, snapshot: {} };
  const steps = normalizeJourneySteps(row.steps);
  let recipients = contacts.rows;
  const requestedIds = recipientIds(row.recipients);
  if (requestedIds.length > 0) {
    recipients = contacts.rows.filter((contact) => requestedIds.includes(Number(contact.id)));
  }
  return {
    steps,
    recipients,
    snapshot: {
      journey_id: Number(row.id),
      journey_version_id: Number(row.version_id),
      version: Number(row.version),
      steps,
      escalation_settings: row.escalation_settings ?? {},
    },
  };
}

async function createDueScheduledRequests(): Promise<void> {
  const schedules = await db.query<ScheduleRow>(
    `SELECT id, workspace_owner_id, supplier_id, finance_entity_id, cadence,
            local_day, local_time, timezone, first_run_date, journey_id, next_run_at
       FROM supplier_statement_schedules
      WHERE is_active=true AND next_run_at IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at ASC
      LIMIT 20`,
  );
  for (const schedule of schedules.rows) {
    const client = await db.connect();
    try {
      await withTransaction(client, async () => {
        const locked = await client.query<ScheduleRow>(
          `SELECT id, workspace_owner_id, supplier_id, finance_entity_id, cadence,
                  local_day, local_time, timezone, first_run_date, journey_id, next_run_at
             FROM supplier_statement_schedules
            WHERE id=$1 AND is_active=true AND next_run_at IS NOT NULL AND next_run_at <= now()
            FOR UPDATE SKIP LOCKED`,
          [schedule.id],
        );
        const current = locked.rows[0];
        if (!current) return;
        const scheduledRunAt = current.next_run_at ? new Date(current.next_run_at) : new Date();
        const firstDueAt = new Date(Math.max(Date.now(), scheduledRunAt.getTime()));
        const dueAt = scheduledRunAt;
        const period = periodForCycle(current.cadence, dueAt);
        const snapshot = await loadJourneySnapshot(current, client);
        const needsSetup =
          snapshot.steps.length === 0
          || snapshot.recipients.length === 0
          || snapshot.steps.some((step) =>
            step.channel === "email" && !snapshot.recipients.some((contact) => Boolean(contact.email)))
          || snapshot.steps.some((step) =>
            step.channel === "whatsapp" && !snapshot.recipients.some((contact) => Boolean(contact.whatsapp_phone || contact.phone)));
        const idempotencyKey = `schedule:${current.id}:${period.periodStart}:${period.periodEnd}`;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO supplier_statement_requests
            (workspace_owner_id, supplier_id, finance_entity_id, schedule_id,
             period_start, period_end, period_label, cadence, status, source,
             next_action, next_action_at, next_recurring_cycle_at, journey_snapshot,
              recipients_snapshot, idempotency_key, timezone)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scheduled',$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            current.workspace_owner_id,
            current.supplier_id,
            current.finance_entity_id,
            current.id,
            period.periodStart,
            period.periodEnd,
            period.periodLabel,
            current.cadence,
            needsSetup ? "needs_setup" : "open",
            needsSetup ? "needs_setup" : "prepare",
             needsSetup ? null : firstDueAt,
            new Date(new Date(`${period.periodEnd}T00:00:00Z`).getTime() + 86_400_000),
            JSON.stringify(snapshot.snapshot),
            JSON.stringify(snapshot.recipients),
            idempotencyKey,
             current.timezone,
          ],
        );
        if (inserted.rows[0] && !needsSetup) {
          const steps = snapshot.steps;
          let offset = 0;
          for (const step of steps) {
            offset += step.delay_minutes;
            const plannedAt = new Date(firstDueAt.getTime() + offset * 60_000);
            await client.query(
              `INSERT INTO supplier_statement_step_executions
                (request_id, workspace_owner_id, step_order, channel, delay_minutes,
                 scheduled_at, supplier_id, finance_entity_id, period_start, period_end,
                 idempotency_key, planned_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6)
               ON CONFLICT (request_id, step_order) DO NOTHING`,
              [
                inserted.rows[0].id,
                current.workspace_owner_id,
                step.order,
                step.channel,
                step.delay_minutes,
                plannedAt,
                current.supplier_id,
                current.finance_entity_id,
                period.periodStart,
                period.periodEnd,
                `${inserted.rows[0].id}:step:${step.order}`,
              ],
            );
          }
        }
        const nextRun = calculateNextRun(current, new Date());
        await client.query(
          `UPDATE supplier_statement_schedules
              SET last_run_at=now(), next_run_at=$2, updated_at=now()
            WHERE id=$1`,
          [current.id, nextRun],
        );
        if (inserted.rows[0]) {
          await client.query(
            `INSERT INTO supplier_statement_audit_events
              (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
             VALUES ($1,'request',$2,'scheduled_created','system',$3::jsonb)`,
            [
              current.workspace_owner_id,
              inserted.rows[0].id,
              JSON.stringify({ schedule_id: current.id, period_start: period.periodStart, period_end: period.periodEnd }),
            ],
          );
        }
      });
    } catch (error) {
      logger.warn({ error, scheduleId: schedule.id }, "supplier statement schedule cycle failed");
    } finally {
      client.release();
    }
  }
}

async function recoverStaleClaims(): Promise<void> {
  await db.query(
    `UPDATE supplier_statement_step_executions
        SET status='failed', provider_status='unknown',
            last_error=COALESCE(last_error,'Worker stopped while provider outcome was unknown'),
            failure_code=COALESCE(failure_code,'stale_claim_unknown'), updated_at=now()
      WHERE status='processing' AND updated_at < now() - interval '${STALE_CLAIM_MINUTES} minutes'`,
  );
}

async function claimDueSteps(): Promise<StepRow[]> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const result = await client.query<StepRow>(
        `WITH due AS (
           SELECT e.id
             FROM supplier_statement_step_executions e
             JOIN supplier_statement_requests r ON r.id=e.request_id
            WHERE e.status='pending' AND e.scheduled_at <= now()
              AND r.status IN ('open','in_progress')
              AND NOT EXISTS (
                SELECT 1 FROM supplier_statement_step_executions prior
                 WHERE prior.request_id=e.request_id AND prior.step_order < e.step_order
                   AND prior.status IN ('pending','processing')
              )
            ORDER BY e.scheduled_at, e.id
            LIMIT ${CLAIM_BATCH}
             FOR UPDATE OF e, r SKIP LOCKED
         )
         UPDATE supplier_statement_step_executions e
            SET status='processing', attempt_count=attempt_count+1, updated_at=now()
           FROM due
          WHERE e.id=due.id
        RETURNING e.id, e.request_id, e.workspace_owner_id, e.step_order, e.channel,
                  e.scheduled_at, e.attempt_count`,
      );
      return result.rows;
    });
  } finally {
    client.release();
  }
}

async function loadStep(id: number): Promise<Record<string, unknown> | null> {
  const result = await db.query(
    `SELECT e.*, r.status AS request_status, r.supplier_id AS request_supplier_id,
            r.finance_entity_id AS request_entity_id, r.period_start, r.period_end,
            r.period_label, r.recipients_snapshot, r.journey_snapshot,
            s.name AS supplier_name, fe.display_name AS entity_name, fe.legal_name,
            CASE WHEN r.schedule_id IS NULL THEN true ELSE COALESCE(ss.is_active, false) END AS schedule_active
       FROM supplier_statement_step_executions e
       JOIN supplier_statement_requests r ON r.id=e.request_id
       JOIN suppliers s ON s.id=r.supplier_id
       JOIN finance_entities fe ON fe.id=r.finance_entity_id
       LEFT JOIN supplier_statement_schedules ss ON ss.id=r.schedule_id
      WHERE e.id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function recordStepResult(
  step: Record<string, unknown>,
  result: { ok: true; providerMessageId?: string | null; providerContactId?: string | null; providerChannelId?: string | null; destination?: string; renderedVariables?: string[]; providerStatus?: string } | { ok: false; retryable: boolean; errorCode: string; errorMessage: string },
): Promise<void> {
  const id = Number(step.id);
  const attempt = Number(step.attempt_count);
  if (result.ok) {
    await db.query(
      `UPDATE supplier_statement_step_executions
          SET status='sent', provider_message_id=COALESCE($2,provider_message_id),
              provider_contact_id=COALESCE($3,provider_contact_id),
              provider_channel_id=COALESCE($4,provider_channel_id),
              destination=COALESCE($5,destination),
              rendered_variables=COALESCE($6::jsonb,rendered_variables),
              provider_status=COALESCE($7,provider_status), sent_at=COALESCE(sent_at,now()),
              completed_at=now(), updated_at=now(), failure_code=NULL, last_error=NULL
        WHERE id=$1 AND status='processing'`,
      [
        id,
        result.providerMessageId ?? null,
        result.providerContactId ?? null,
        result.providerChannelId ?? null,
        result.destination ?? null,
        result.renderedVariables ? JSON.stringify(result.renderedVariables) : null,
        result.providerStatus ?? "accepted",
      ],
    );
    await db.query(
      `UPDATE supplier_statement_requests
          SET status='in_progress', next_action='follow_up', next_action_at=(
            SELECT MIN(scheduled_at) FROM supplier_statement_step_executions
             WHERE request_id=$1 AND status='pending'
          ), updated_at=now()
        WHERE id=$1 AND status='open'`,
      [String(step.request_id)],
    );
    await maybeEscalate(String(step.request_id));
    return;
  }
  const nextAttemptAt = attempt < MAX_ATTEMPTS && result.retryable
    ? new Date(Date.now() + RETRY_BACKOFF_MINUTES[Math.min(attempt - 1, RETRY_BACKOFF_MINUTES.length - 1)] * 60_000)
    : null;
  await db.query(
    `UPDATE supplier_statement_step_executions
        SET status=$2, scheduled_at=COALESCE($3,scheduled_at), last_error=$4,
            failure_code=$5, failure_details=$6::jsonb, provider_status='failed',
            updated_at=now(), completed_at=CASE WHEN $2='failed' THEN now() ELSE completed_at END
      WHERE id=$1 AND status='processing'`,
    [
      id,
      nextAttemptAt ? "pending" : "failed",
      nextAttemptAt,
      result.errorMessage.slice(0, 2000),
      result.errorCode,
      JSON.stringify({ retryable: result.retryable, attempt }),
    ],
  );
  if (!nextAttemptAt) await maybeEscalate(String(step.request_id));
}

async function maybeEscalate(requestId: string): Promise<void> {
  const result = await db.query(
    `UPDATE supplier_statement_requests
        SET next_action='escalate', next_action_at=now(), updated_at=now()
      WHERE id=$1 AND status NOT IN ('received','reconciled','cancelled','paused')
        AND next_action <> 'escalate'
        AND NOT EXISTS (
          SELECT 1 FROM supplier_statement_step_executions
           WHERE request_id=$1 AND status IN ('pending','processing')
        )
      RETURNING workspace_owner_id`,
    [requestId],
  );
  if (result.rows[0]) {
    await db.query(
      `INSERT INTO supplier_statement_communication_events
        (request_id, workspace_owner_id, event_type, channel, payload)
       VALUES ($1,$2,'escalation_due',NULL,$3::jsonb)`,
      [requestId, result.rows[0].workspace_owner_id, JSON.stringify({ reason: "final_journey_step_complete" })],
    );
    await db.query(
      `INSERT INTO supplier_statement_audit_events
        (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
       VALUES ($1,'request',$2,'escalation_due','system',$3::jsonb)`,
      [result.rows[0].workspace_owner_id, requestId, JSON.stringify({ reason: "final_journey_step_complete" })],
    );
  }
}

export async function requestStillAllowsProviderSend(stepId: number): Promise<boolean> {
  const current = await db.query<{ request_status: string }>(
    `SELECT r.status AS request_status
       FROM supplier_statement_step_executions e
       JOIN supplier_statement_requests r ON r.id=e.request_id
      WHERE e.id=$1 AND e.status='processing'
      LIMIT 1`,
    [stepId],
  );
  if (current.rows[0] && ["open", "in_progress"].includes(current.rows[0].request_status)) {
    return true;
  }
  await db.query(
    `UPDATE supplier_statement_step_executions
        SET status='cancelled', updated_at=now()
      WHERE id=$1 AND status='processing'`,
    [stepId],
  );
  return false;
}

async function dispatchStep(claimed: StepRow): Promise<void> {
  const step = await loadStep(claimed.id);
  if (!step) return;
  if (!["open", "in_progress"].includes(String(step.request_status))) {
    await db.query(`UPDATE supplier_statement_step_executions SET status='cancelled', updated_at=now() WHERE id=$1 AND status='processing'`, [claimed.id]);
    return;
  }
  if (step.schedule_active === false) {
    await db.query(
      `UPDATE supplier_statement_step_executions
          SET status='pending', scheduled_at=now() + interval '5 minutes', updated_at=now()
        WHERE id=$1 AND status='processing'`,
      [claimed.id],
    );
    return;
  }
  const snapshot = Array.isArray(step.recipients_snapshot) ? step.recipients_snapshot : [];
  const ids = recipientIds(snapshot);
  if (ids.length === 0) {
    await recordStepResult(step, { ok: false, retryable: false, errorCode: "recipient_missing", errorMessage: "No approved supplier statement recipient is configured" });
    return;
  }
  const contacts = await db.query(
    `SELECT id, name, email, phone, whatsapp_phone
       FROM supplier_statement_contacts
      WHERE workspace_owner_id=$1 AND supplier_id=$2 AND id=ANY($3::int[])
        AND is_active=true AND is_approved=true
      ORDER BY id ASC`,
    [step.workspace_owner_id, step.request_supplier_id, ids],
  );
  const channel = String(step.channel);
  const recipient = contacts.rows.find((contact) => channel === "email" ? Boolean(contact.email) : Boolean(contact.whatsapp_phone || contact.phone));
  if (!recipient) {
    await recordStepResult(step, { ok: false, retryable: false, errorCode: "recipient_invalid", errorMessage: `No active approved recipient has a ${channel} destination` });
    return;
  }
  const snapshotObject = jsonRecord(step.journey_snapshot);
  const steps = normalizeJourneySteps(snapshotObject.steps);
  const journeyStep = steps.find((candidate) => candidate.order === Number(step.step_order));
  if (!journeyStep) {
    await recordStepResult(step, { ok: false, retryable: false, errorCode: "journey_step_missing", errorMessage: "Journey step is not present in the request snapshot" });
    return;
  }
  const message = renderSupplierStatementMessage(journeyStep.message, {
    supplierName: String(step.supplier_name),
    contactName: String(recipient.name),
    entityName: String(step.entity_name ?? step.legal_name),
    periodStart: String(step.period_start),
    periodEnd: String(step.period_end),
    periodLabel: String(step.period_label),
  });
  await db.query(
    `UPDATE supplier_statement_step_executions
        SET supplier_contact_id=$2, template_name=$3, reply_to=$4,
            correlation_id=$5, destination=$6,
            rendered_variables=COALESCE($7::jsonb, rendered_variables),
            updated_at=now()
      WHERE id=$1`,
    [
      claimed.id,
      recipient.id,
      channel === "whatsapp" ? "supplier_statement_request" : null,
      supplierStatementReplyAddress(String(step.request_id)),
      String(step.request_id),
      channel === "email" ? String(recipient.email) : String(recipient.whatsapp_phone ?? recipient.phone),
      channel === "whatsapp"
        ? JSON.stringify([String(recipient.name), String(step.entity_name ?? step.legal_name), String(step.period_start), String(step.period_end)])
        : null,
    ],
  );
  if (channel === "email") {
    if (!(await requestStillAllowsProviderSend(claimed.id))) return;
    const result = await sendSupplierStatementEmail({
      to: [String(recipient.email)],
      subject: journeyStep.subject?.trim() || `Supplier statement request — ${step.period_label}`,
      message,
      requestId: String(step.request_id),
      stepId: String(claimed.id),
      entityId: Number(step.request_entity_id),
      periodStart: String(step.period_start),
      periodEnd: String(step.period_end),
      replyTo: supplierStatementReplyAddress(String(step.request_id)),
      idempotencyKey: String(step.idempotency_key),
    });
    if (result.ok) {
      await recordStepResult(step, { ok: true, providerMessageId: result.providerMessageId, providerStatus: "accepted", destination: String(recipient.email) });
    } else {
      await recordStepResult(step, result);
    }
    return;
  }
  const readiness = supplierStatementProviderReadiness();
  if (!readiness.whatsapp.configured) {
    await recordStepResult(step, { ok: false, retryable: false, errorCode: "not_configured", errorMessage: "RESPONDIO_API_TOKEN missing" });
    return;
  }
  if (!(await requestStillAllowsProviderSend(claimed.id))) return;
  const result = await sendSupplierStatementWhatsApp({
    requestId: String(step.request_id),
    stepId: String(claimed.id),
    supplierContactId: Number(recipient.id),
    contactName: String(recipient.name),
    phone: String(recipient.whatsapp_phone ?? recipient.phone),
    entityName: String(step.entity_name ?? step.legal_name),
    periodStart: String(step.period_start),
    periodEnd: String(step.period_end),
  });
  await recordStepResult(step, result);
}

export async function runSupplierStatementSweep(): Promise<void> {
  await createDueScheduledRequests();
  await recoverStaleClaims();
  const claimed = await claimDueSteps();
  for (const step of claimed) {
    try {
      await dispatchStep(step);
    } catch (error) {
      const fields = errorFields(error);
      await recordStepResult(
        await loadStep(step.id) ?? step as unknown as Record<string, unknown>,
        { ok: false, ...fields },
      );
      logger.warn({ error, stepId: step.id }, "supplier statement step dispatch failed");
    }
  }
}

let timer: NodeJS.Timeout | null = null;
export function startSupplierStatementWorker(): void {
  if (timer) return;
  const tick = () => {
    void runSupplierStatementSweep().catch((error) => {
      logger.warn({ error }, "supplier statement worker sweep failed");
    });
  };
  timer = setInterval(tick, POLL_INTERVAL_MS);
  setTimeout(tick, 10_000);
  logger.info("Supplier statement collection worker started");
}

export const __test = {
  createDueScheduledRequests,
  recoverStaleClaims,
  claimDueSteps,
  loadStep,
  recordStepResult,
  maybeEscalate,
  dispatchStep,
};
