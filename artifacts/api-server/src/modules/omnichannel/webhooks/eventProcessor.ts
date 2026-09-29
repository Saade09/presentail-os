import type { Logger } from "pino";
import { db, withTransaction } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { getAdapter } from "../adapters/adapterRegistry";
import { MockChannelAdapter } from "../adapters/MockChannelAdapter";
import type { NormalizedMessage, NormalizedContact, OmniProvider } from "../types";
import { sseBus } from "../sseBus";
import { matchTriggers, resumeWaitingExecution } from "../automation/triggerMatcher";
import { startFlow } from "../automation/flowExecutor";

interface RawEventJob {
  rawEventId: string;
  channelAccountId: number;
  provider: OmniProvider;
  payload: unknown;
}

/**
 * Process a raw inbound webhook event asynchronously after the 200 OK has
 * been returned.  Normalizes the payload, deduplicates messages, upserts the
 * contact + conversation, then inserts the message row.
 */
export async function processWebhookEvent(job: RawEventJob): Promise<void> {
  const { rawEventId, channelAccountId, provider, payload } = job;

  const log = logger.child({ rawEventId, channelAccountId, provider });

  const adapter = getAdapter(channelAccountId) ?? new MockChannelAdapter(provider);

  let event;
  try {
    event = await adapter.parseWebhookEvent(payload, String(channelAccountId));
  } catch (err) {
    log.error({ err }, "omnichannel: failed to parse webhook event");
    await markRawEventError(rawEventId, String(err instanceof Error ? err.message : err));
    return;
  }

  log.info(
    { eventType: event.eventType, messageCount: event.messages.length },
    "omnichannel: processing webhook event",
  );

  for (const rawMsg of event.messages) {
    const msg = adapter.normalizeInboundMessage(rawMsg);
    try {
      const persisted = await persistInboundMessage(channelAccountId, msg, log);
      if (persisted) {
        sseBus.push({
          type: "conversation_updated",
          conversation_id: persisted.conversationId,
          workspace_owner_id: persisted.workspaceOwnerId,
        });
        setImmediate(() => {
          runAutomationForInbound(persisted, log).catch((err: unknown) => {
            log.error({ err }, "omnichannel: automation trigger error");
          });
        });
      }
    } catch (err) {
      log.error({ err, externalMessageId: msg.externalMessageId }, "omnichannel: failed to persist inbound message");
    }
  }

  await markRawEventProcessed(rawEventId);
}

/**
 * Persist a single pre-normalized inbound message directly, bypassing the
 * adapter parse step.  Used by the test-provider endpoint to ensure a real
 * DB row is created without relying on adapter-specific payload parsing.
 */
export async function persistNormalizedMessage(
  channelAccountId: number,
  msg: NormalizedMessage,
): Promise<void> {
  const log = logger.child({ channelAccountId, externalMessageId: msg.externalMessageId });
  const persisted = await persistInboundMessage(channelAccountId, msg, log);
  if (persisted) {
    sseBus.push({
      type: "conversation_updated",
      conversation_id: persisted.conversationId,
      workspace_owner_id: persisted.workspaceOwnerId,
    });
    setImmediate(() => {
      runAutomationForInbound(persisted, log).catch((err: unknown) => {
        log.error({ err }, "omnichannel: automation trigger error");
      });
    });
  }
}

async function runAutomationForInbound(persisted: PersistedInfo, log: Logger): Promise<void> {
  const {
    conversationId,
    workspaceOwnerId,
    contactId,
    channelAccountId,
    content,
    isFirstMessage,
    messageType,
    senderExternalUserId,
  } = persisted;

  await resumeWaitingExecution(conversationId, content);

  const matchedFlowIds = await matchTriggers({
    content,
    conversationId,
    contactId,
    workspaceOwnerId,
    channelAccountId,
    isFirstMessage,
  });

  for (const flowId of matchedFlowIds) {
    try {
      await startFlow(flowId, conversationId, { inboundContent: content });
    } catch (err) {
      log.error({ err, flowId, conversationId }, "omnichannel: failed to start automation flow");
    }
  }

}

interface PersistedInfo {
  conversationId: number;
  workspaceOwnerId: string;
  contactId: number;
  channelAccountId: number;
  content: string | null;
  isFirstMessage: boolean;
  messageType: string;
  senderExternalUserId: string;
}

async function persistInboundMessage(
  channelAccountId: number,
  msg: NormalizedMessage,
  log: Logger,
): Promise<PersistedInfo | null> {
  const client = await db.connect();
  let result: PersistedInfo | null = null;
  try {
    await withTransaction(client, async () => {
      const accountResult = await client.query<{
        workspace_owner_id: string;
        provider: string;
      }>(
        `SELECT workspace_owner_id, provider FROM omni_channel_accounts WHERE id = $1`,
        [channelAccountId],
      );
      const account = accountResult.rows[0];
      if (!account) {
        throw new Error(`Channel account ${channelAccountId} not found`);
      }
      const workspaceOwnerId = account.workspace_owner_id;

      const dupCheck = await client.query<{ id: string }>(
        `SELECT id FROM omni_messages
         WHERE provider_message_id = $1 AND channel_account_id = $2
         LIMIT 1`,
        [msg.externalMessageId, channelAccountId],
      );
      if (dupCheck.rows.length > 0) {
        log.info(
          { providerMessageId: msg.externalMessageId },
          "omnichannel: duplicate message — skipping",
        );
        return;
      }

      const contactId = await upsertContact(
        client,
        workspaceOwnerId,
        channelAccountId,
        msg.provider as OmniProvider,
        {
          externalUserId: msg.senderExternalUserId,
          displayName: msg.senderName ?? null,
          avatarUrl: null,
          phone: null,
          email: null,
          provider: msg.provider as OmniProvider,
        },
        log,
      );

      const providerConvId = `${msg.provider}:${msg.senderExternalUserId}`;

      const conversationId = await upsertConversation(
        client,
        workspaceOwnerId,
        channelAccountId,
        contactId,
        providerConvId,
        log,
      );

      const msgCountResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM omni_messages
         WHERE conversation_id = $1 AND direction = 'inbound'`,
        [conversationId],
      );
      const isFirstMessage = parseInt(msgCountResult.rows[0]?.count ?? "0", 10) === 0;

      await client.query(
        `INSERT INTO omni_messages (
           conversation_id, workspace_owner_id, direction, message_type,
           content, media_url, media_mime_type, media_size,
           template_name, template_params, interactive_payload,
           external_message_id, provider_message_id, channel_account_id,
           sender_name, status, sent_at, metadata
         ) VALUES (
           $1, $2, 'inbound', $3,
           $4, $5, $6, $7,
           $8, $9, $10,
           $11, $12, $13,
           $14, $15, $16, $17
         )`,
        [
          conversationId,
          workspaceOwnerId,
          msg.messageType,
          msg.content ?? null,
          msg.mediaUrl ?? null,
          msg.mediaMimeType ?? null,
          msg.mediaSize ?? null,
          msg.templateName ?? null,
          msg.templateParams ? JSON.stringify(msg.templateParams) : null,
          msg.interactivePayload ? JSON.stringify(msg.interactivePayload) : null,
          msg.externalMessageId,
          msg.externalMessageId,
          channelAccountId,
          msg.senderName ?? null,
          msg.status,
          msg.timestamp,
          msg.metadata ? JSON.stringify(msg.metadata) : null,
        ],
      );

      await client.query(
        `UPDATE omni_conversations
         SET last_message_at = $1, last_inbound_at = $1, updated_at = NOW()
         WHERE id = $2`,
        [msg.timestamp, conversationId],
      );

      await client.query(
        `UPDATE omni_channel_accounts
         SET last_webhook_received_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [channelAccountId],
      );

      log.info(
        { conversationId, providerMessageId: msg.externalMessageId },
        "omnichannel: inbound message persisted",
      );

      result = {
        conversationId,
        workspaceOwnerId,
        contactId,
        channelAccountId,
        content: msg.content ?? null,
        isFirstMessage,
        messageType: msg.messageType,
        senderExternalUserId: msg.senderExternalUserId,
      };
    });
  } finally {
    client.release();
  }
  return result;
}

async function upsertContact(
  client: import("pg").PoolClient,
  workspaceOwnerId: string,
  channelAccountId: number,
  provider: OmniProvider,
  contact: NormalizedContact,
  log: Logger,
): Promise<number> {
  const identityResult = await client.query<{ contact_id: number }>(
    `SELECT contact_id FROM omni_contact_identities
     WHERE channel_account_id = $1 AND external_user_id = $2
     LIMIT 1`,
    [channelAccountId, contact.externalUserId],
  );

  if (identityResult.rows.length > 0) {
    const existingContactId = identityResult.rows[0].contact_id;
    if (contact.displayName) {
      await client.query(
        `UPDATE omni_contacts SET display_name = $1, updated_at = NOW() WHERE id = $2`,
        [contact.displayName, existingContactId],
      );
    }
    return existingContactId;
  }

  const contactResult = await client.query<{ id: number }>(
    `INSERT INTO omni_contacts (workspace_owner_id, display_name, phone, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      workspaceOwnerId,
      contact.displayName ?? contact.externalUserId,
      contact.phone ?? null,
      contact.email ?? null,
      contact.avatarUrl ?? null,
    ],
  );
  const contactId = contactResult.rows[0].id;

  await client.query(
    `INSERT INTO omni_contact_identities (
       contact_id, channel_account_id, provider, external_user_id, display_name, avatar_url
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_account_id, external_user_id) DO NOTHING`,
    [
      contactId,
      channelAccountId,
      provider,
      contact.externalUserId,
      contact.displayName ?? null,
      contact.avatarUrl ?? null,
    ],
  );

  log.info({ contactId, externalUserId: contact.externalUserId }, "omnichannel: contact upserted");
  return contactId;
}

async function upsertConversation(
  client: import("pg").PoolClient,
  workspaceOwnerId: string,
  channelAccountId: number,
  contactId: number,
  providerConversationId: string | null,
  log: Logger,
): Promise<number> {
  if (providerConversationId) {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM omni_conversations
       WHERE channel_account_id = $1 AND provider_conversation_id = $2
       LIMIT 1`,
      [channelAccountId, providerConversationId],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].id;
    }
  } else {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM omni_conversations
       WHERE channel_account_id = $1 AND contact_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [channelAccountId, contactId],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].id;
    }
  }

  const result = await client.query<{ id: number }>(
    `INSERT INTO omni_conversations (
       workspace_owner_id, channel_account_id, contact_id, provider_conversation_id, status
     ) VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (channel_account_id, provider_conversation_id)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [workspaceOwnerId, channelAccountId, contactId, providerConversationId],
  );

  log.info({ conversationId: result.rows[0].id }, "omnichannel: conversation upserted");
  return result.rows[0].id;
}

async function markRawEventProcessed(rawEventId: string): Promise<void> {
  try {
    await db.query(
      `UPDATE omni_webhook_raw_events SET processed_at = NOW() WHERE id = $1`,
      [rawEventId],
    );
  } catch (err) {
    logger.error({ err, rawEventId }, "omnichannel: failed to mark raw event as processed");
  }
}

async function markRawEventError(rawEventId: string, error: string): Promise<void> {
  try {
    await db.query(
      `UPDATE omni_webhook_raw_events SET processing_error = $1 WHERE id = $2`,
      [error, rawEventId],
    );
  } catch (err) {
    logger.error({ err, rawEventId }, "omnichannel: failed to mark raw event error");
  }
}
