import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { isEncrypted, decrypt } from "../../../lib/credentialEncryption";
import type { IChannelAdapter } from "./IChannelAdapter";
import { MockChannelAdapter } from "./MockChannelAdapter";
import { WhatsAppCloudAdapter } from "./WhatsAppCloudAdapter";
import { MetaMessengerAdapter } from "./MetaMessengerAdapter";
import { InstagramMessagingAdapter } from "./InstagramMessagingAdapter";
import { TikTokBusinessMessagingAdapter } from "./TikTokBusinessMessagingAdapter";
import type { OmniProvider } from "../types";

interface ChannelAccountRow {
  id: number;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  webhook_verify_token: string | null;
  external_account_id: string | null;
  is_active: boolean;
}

/**
 * Holds the registry state — a map from channel_account_id to adapter
 * and a map from channel_account_id to the DB row for credential access.
 *
 * NOTE: access_token values stored here are already decrypted so that
 * callers (outbound queue, etc.) receive the plaintext token directly.
 */
const adapterMap = new Map<number, IChannelAdapter>();
const accountMap = new Map<number, ChannelAccountRow>();

const SUPPORTED_PROVIDERS: OmniProvider[] = ["whatsapp", "instagram", "messenger", "tiktok"];

function isOmniProvider(v: string): v is OmniProvider {
  return SUPPORTED_PROVIDERS.includes(v as OmniProvider);
}

/**
 * Decrypt a token value if it is stored with the "enc:" prefix.
 * Returns null on decryption failure so the registry can fall back to mock.
 */
function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch (err) {
    logger.warn({ err }, "omnichannel: failed to decrypt channel account credential — falling back to mock");
    return null;
  }
}

/**
 * Load all active channel accounts from the DB and build the registry.
 * Falls back to MockChannelAdapter when MOCK_CHANNELS_ENABLED=true or when
 * no real credentials are available for a given account.
 *
 * Access tokens are decrypted once at load time and stored as plaintext
 * in accountMap so callers never need to decrypt again.
 */
export async function loadAdapterRegistry(): Promise<void> {
  try {
    const result = await db.query<ChannelAccountRow>(
      `SELECT id, provider, access_token, refresh_token, token_expires_at,
              webhook_verify_token, external_account_id, is_active
       FROM omni_channel_accounts
       WHERE is_active = true`,
    );
    adapterMap.clear();
    accountMap.clear();

    for (const row of result.rows) {
      if (!isOmniProvider(row.provider)) {
        logger.warn({ provider: row.provider, channelAccountId: row.id }, "omnichannel: unknown provider in channel accounts — skipping");
        continue;
      }

      const decryptedRow: ChannelAccountRow = {
        ...row,
        access_token: safeDecrypt(row.access_token),
        refresh_token: safeDecrypt(row.refresh_token),
      };

      accountMap.set(row.id, decryptedRow);
      adapterMap.set(row.id, resolveAdapter(decryptedRow));
    }

    logger.info({ count: adapterMap.size }, "omnichannel: adapter registry loaded");
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to load adapter registry");
  }
}

/**
 * Resolve the appropriate adapter for a channel account row.
 *
 * Decision logic:
 *   1. If MOCK_CHANNELS_ENABLED=true → always use MockChannelAdapter.
 *   2. If the row has no decryptable access_token → use MockChannelAdapter.
 *   3. Otherwise → instantiate the real provider adapter.
 *
 * Real adapters receive only the decrypted plaintext credentials they need.
 * Credentials are never logged.
 */
function resolveAdapter(row: ChannelAccountRow): IChannelAdapter {
  if (process.env.MOCK_CHANNELS_ENABLED === "true") {
    return new MockChannelAdapter(row.provider as OmniProvider);
  }

  if (!row.access_token) {
    logger.info(
      { channelAccountId: row.id, provider: row.provider },
      "omnichannel: no credentials for channel account — using mock adapter",
    );
    return new MockChannelAdapter(row.provider as OmniProvider);
  }

  switch (row.provider as OmniProvider) {
    case "whatsapp": {
      const appSecret = process.env.WHATSAPP_APP_SECRET ?? "";
      if (!appSecret) {
        logger.warn({ channelAccountId: row.id }, "omnichannel: WHATSAPP_APP_SECRET not set — falling back to mock");
        return new MockChannelAdapter("whatsapp");
      }
      return new WhatsAppCloudAdapter(appSecret);
    }

    case "messenger": {
      const appSecret = process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET ?? "";
      if (!appSecret) {
        logger.warn({ channelAccountId: row.id }, "omnichannel: META_APP_SECRET not set — falling back to mock");
        return new MockChannelAdapter("messenger");
      }
      return new MetaMessengerAdapter(appSecret);
    }

    case "instagram": {
      const appSecret = process.env.META_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET ?? "";
      const appId = process.env.META_APP_ID ?? "";
      if (!appSecret || !appId) {
        logger.warn({ channelAccountId: row.id }, "omnichannel: META_APP_SECRET or META_APP_ID not set — falling back to mock");
        return new MockChannelAdapter("instagram");
      }
      return new InstagramMessagingAdapter(appSecret, appId, row.id);
    }

    case "tiktok": {
      return new TikTokBusinessMessagingAdapter(row.id);
    }
  }
}

/**
 * Get the adapter for a given channel account ID.
 */
export function getAdapter(channelAccountId: number): IChannelAdapter | undefined {
  return adapterMap.get(channelAccountId);
}

/**
 * Get an adapter by provider name, ignoring channel account ID.
 * Used for the test-provider endpoint which doesn't have a real account.
 */
export function getMockAdapter(provider: OmniProvider = "whatsapp"): IChannelAdapter {
  return new MockChannelAdapter(provider);
}

/**
 * Get the verify token for a channel account (used in Meta hub challenge).
 */
export function getVerifyToken(channelAccountId: number): string | null {
  return accountMap.get(channelAccountId)?.webhook_verify_token ?? null;
}

/**
 * Get the access token for a channel account (already decrypted at load time).
 */
export function getAccessToken(channelAccountId: number): string | null {
  return accountMap.get(channelAccountId)?.access_token ?? null;
}

/**
 * Find channel account IDs by provider.
 */
export function getChannelAccountIdsByProvider(provider: OmniProvider): number[] {
  const ids: number[] = [];
  for (const [id, row] of accountMap.entries()) {
    if (row.provider === provider) ids.push(id);
  }
  return ids;
}

/**
 * Get the channel account row for a given ID.
 */
export function getChannelAccount(channelAccountId: number): ChannelAccountRow | undefined {
  return accountMap.get(channelAccountId);
}

/**
 * Find a channel account ID by provider + external account ID.
 * Returns undefined if not found.
 */
export async function findChannelAccountByExternalId(
  provider: OmniProvider,
  externalAccountId: string,
): Promise<number | undefined> {
  const result = await db.query<{ id: number }>(
    `SELECT id FROM omni_channel_accounts
     WHERE provider = $1 AND external_account_id = $2 AND is_active = true
     LIMIT 1`,
    [provider, externalAccountId],
  );
  return result.rows[0]?.id;
}
