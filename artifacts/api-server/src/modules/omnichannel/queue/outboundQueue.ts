import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { getAdapter, getAccessToken } from "../adapters/adapterRegistry";
import { MockChannelAdapter } from "../adapters/MockChannelAdapter";
import { ProviderMessageWindowError } from "../errors";
import type { NormalizedMessageInput, OmniProvider } from "../types";

export type OutboundQueueStatus = "queued" | "sending" | "sent" | "failed";

const BACKOFF_SECONDS = [30, 60, 120, 300, 600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
const POLL_INTERVAL_MS = 5_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

export interface EnqueueParams {
  channelAccountId: number;
  conversationId: number;
  messageId?: string;
  recipientExternalId: string;
  payload: NormalizedMessageInput;
  provider: OmniProvider;
}

/**
 * Check provider-specific message window rules before sending.
 * Meta platforms (WhatsApp, Instagram, Messenger) enforce a 24-hour
 * customer service window.
 */
async function checkMessageWindow(
  channelAccountId: number,
  conversationId: number,
  provider: OmniProvider,
): Promise<void> {
  const has24hWindow =
    provider === "whatsapp" || provider === "instagram" || provider === "messenger";

  if (!has24hWindow) return;

  const result = await db.query<{ last_inbound_at: Date | null }>(
    `SELECT last_inbound_at FROM omni_conversations WHERE id = $1`,
    [conversationId],
  );

  const lastInbound = result.rows[0]?.last_inbound_at;

  if (!lastInbound) {
    throw new ProviderMessageWindowError(
      `No inbound message on this conversation — cannot send outside the 24-hour customer service window (provider: ${provider})`,
    );
  }

  const windowMs = 24 * 60 * 60 * 1000;
  const elapsed = Date.now() - new Date(lastInbound).getTime();

  if (elapsed > windowMs) {
    throw new ProviderMessageWindowError(
      `24-hour messaging window has expired for provider ${provider}. Last inbound was ${Math.floor(elapsed / 3600000)}h ago. Use a template message instead.`,
    );
  }
}

/**
 * Enqueue an outbound message.  Validates the message window before inserting.
 * If a messageId is supplied, transitions the omni_messages row to 'queued'.
 */
export async function enqueue(params: EnqueueParams): Promise<string> {
  const { channelAccountId, conversationId, messageId, recipientExternalId, payload, provider } =
    params;

  await checkMessageWindow(channelAccountId, conversationId, provider);

  const result = await db.query<{ id: string }>(
    `INSERT INTO omni_outbound_queue (
       channel_account_id, conversation_id, message_id, recipient_external_id,
       payload, status, attempts, next_attempt_at
     ) VALUES ($1, $2, $3, $4, $5, 'queued', 0, NOW())
     RETURNING id`,
    [
      channelAccountId,
      conversationId,
      messageId ?? null,
      recipientExternalId,
      JSON.stringify(payload),
    ],
  );

  const queueId = result.rows[0].id;

  if (messageId) {
    await db.query(
      `UPDATE omni_messages SET status = 'queued' WHERE id = $1`,
      [messageId],
    );
  }

  logger.info(
    { queueId, channelAccountId, conversationId, provider },
    "omnichannel: outbound message enqueued",
  );

  return queueId;
}

interface QueueRow {
  id: string;
  channel_account_id: number;
  conversation_id: number;
  message_id: string | null;
  recipient_external_id: string;
  payload: NormalizedMessageInput;
  status: OutboundQueueStatus;
  attempts: number;
}

/**
 * Pick the next queued item and attempt delivery.  Called by the poller.
 * Transitions omni_messages through queued → sending → sent/failed.
 */
export async function processNext(): Promise<void> {
  const pickResult = await db.query<QueueRow>(
    `UPDATE omni_outbound_queue
     SET status = 'sending', updated_at = NOW()
     WHERE id = (
       SELECT id FROM omni_outbound_queue
       WHERE status = 'queued' AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, channel_account_id, conversation_id, message_id,
               recipient_external_id, payload, status, attempts`,
  );

  if (pickResult.rows.length === 0) return;

  const row = pickResult.rows[0];
  const { id, channel_account_id, conversation_id, message_id, recipient_external_id, payload, attempts } = row;

  logger.info(
    { queueId: id, channelAccountId: channel_account_id, attempt: attempts + 1 },
    "omnichannel: processing outbound queue item",
  );

  if (message_id) {
    await db.query(
      `UPDATE omni_messages SET status = 'sending' WHERE id = $1`,
      [message_id],
    );
  }

  const accountResult = await db.query<{ provider: string; workspace_owner_id: string }>(
    `SELECT provider, workspace_owner_id FROM omni_channel_accounts WHERE id = $1`,
    [channel_account_id],
  );
  const account = accountResult.rows[0];

  if (!account) {
    logger.error({ queueId: id, channelAccountId: channel_account_id }, "omnichannel: channel account not found for queue item");
    await markFailed(id, "Channel account not found", message_id);
    return;
  }

  const provider = account.provider as OmniProvider;
  const adapter = getAdapter(channel_account_id) ?? new MockChannelAdapter(provider);
  const accessToken = getAccessToken(channel_account_id) ?? "";

  try {
    const result = await adapter.sendMessage(recipient_external_id, payload, accessToken);

    if (result.success) {
      await db.query(
        `UPDATE omni_outbound_queue
         SET status = 'sent', attempts = $1, updated_at = NOW()
         WHERE id = $2`,
        [attempts + 1, id],
      );

      if (message_id) {
        await db.query(
          `UPDATE omni_messages
           SET status = 'sent', external_message_id = $1, sent_at = NOW()
           WHERE id = $2`,
          [result.externalMessageId ?? null, message_id],
        );
      }

      await db.query(
        `UPDATE omni_channel_accounts
         SET last_outbound_send_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [channel_account_id],
      );

      logger.info(
        { queueId: id, externalMessageId: result.externalMessageId },
        "omnichannel: outbound message sent",
      );
    } else {
      const retryable = result.error?.retryable ?? false;
      await handleFailure(id, attempts, result.error?.message ?? "Send failed", retryable, message_id);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const retryable = !(err instanceof ProviderMessageWindowError);
    logger.error({ err, queueId: id }, "omnichannel: outbound send threw error");
    await handleFailure(id, attempts, errMsg, retryable, message_id);
  }
}

async function handleFailure(
  queueId: string,
  attempts: number,
  errorMessage: string,
  retryable: boolean,
  messageId: string | null,
): Promise<void> {
  const newAttempts = attempts + 1;

  if (!retryable || newAttempts >= MAX_ATTEMPTS) {
    await markFailed(queueId, errorMessage, messageId);
    logger.warn({ queueId, attempts: newAttempts }, "omnichannel: outbound message permanently failed");
    return;
  }

  const backoffIndex = Math.min(newAttempts - 1, BACKOFF_SECONDS.length - 1);
  const backoffSec = BACKOFF_SECONDS[backoffIndex];

  await db.query(
    `UPDATE omni_outbound_queue
     SET status = 'queued', attempts = $1, last_error = $2,
         next_attempt_at = NOW() + ($3 || ' seconds')::interval,
         updated_at = NOW()
     WHERE id = $4`,
    [newAttempts, errorMessage, backoffSec, queueId],
  );

  if (messageId) {
    await db.query(
      `UPDATE omni_messages SET status = 'queued', error_message = $1 WHERE id = $2`,
      [errorMessage, messageId],
    );
  }

  logger.info(
    { queueId, attempt: newAttempts, backoffSec },
    "omnichannel: outbound message scheduled for retry",
  );
}

async function markFailed(
  queueId: string,
  errorMessage: string,
  messageId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE omni_outbound_queue
     SET status = 'failed', last_error = $1, updated_at = NOW()
     WHERE id = $2`,
    [errorMessage, queueId],
  );
  if (messageId) {
    await db.query(
      `UPDATE omni_messages SET status = 'failed', error_message = $1 WHERE id = $2`,
      [errorMessage, messageId],
    );
  }
}

/**
 * Start the background polling interval.  Safe to call multiple times —
 * subsequent calls are no-ops if the poller is already running.
 */
export function startOutboundQueueWorker(): void {
  if (pollerHandle !== null) return;

  pollerHandle = setInterval(() => {
    processNext().catch((err: unknown) => {
      logger.error({ err }, "omnichannel: outbound queue processNext threw unexpected error");
    });
  }, POLL_INTERVAL_MS);

  logger.info({ intervalMs: POLL_INTERVAL_MS }, "omnichannel: outbound queue worker started");
}

/**
 * Stop the polling interval (primarily for tests).
 */
export function stopOutboundQueueWorker(): void {
  if (pollerHandle !== null) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}
