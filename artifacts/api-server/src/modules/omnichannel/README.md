# Omnichannel Module

Unified inbox for multi-channel customer communications. Supports WhatsApp, Instagram, Messenger, and TikTok (pending production approval).

---

## Table of Contents

1. [Running Locally](#running-locally)
2. [Environment Variables](#environment-variables)
3. [Configuring Each Channel](#configuring-each-channel)
4. [Mock Mode](#mock-mode)
5. [How Webhooks Work](#how-webhooks-work)
6. [Deploying on Replit](#deploying-on-replit)
7. [Known Limitations](#known-limitations)
8. [Next Steps](#next-steps)
9. [Production Checklist](#production-checklist)

---

## Running Locally

```bash
# From workspace root — start the API server
pnpm --filter @workspace/api-server run dev

# In a separate terminal — start the web frontend
pnpm --filter @workspace/print-agent-web run dev
```

The omnichannel inbox is available at `/omnichannel/inbox`.

**Integration tests** (no external DB setup needed):

```bash
pnpm --filter @workspace/api-server run test:integration:local
```

This spins up a throwaway PostgreSQL on port 5433, pushes the Drizzle schema, runs tests, and tears down automatically.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `OPENAI_API_KEY` | Optional | Enables real AI drafts/summaries. Without it, mock AI is used. |
| `META_APP_SECRET` | Yes (Meta channels) | Shared App Secret for validating Meta webhook signatures |
| `WHATSAPP_PHONE_NUMBER_ID` | Yes (WhatsApp) | Phone Number ID from Meta Business Manager |
| `WHATSAPP_ACCESS_TOKEN` | Yes (WhatsApp) | System user access token (long-lived) |
| `INSTAGRAM_PAGE_ID` | Yes (Instagram) | Facebook Page ID linked to the Instagram account |
| `MESSENGER_PAGE_ID` | Yes (Messenger) | Facebook Page ID |
| `TIKTOK_APP_ID` | Yes (TikTok) | TikTok for Business App ID |
| `TIKTOK_APP_SECRET` | Yes (TikTok) | TikTok for Business App Secret |
| `OMNI_MOCK_MODE` | Optional | Set to `true` to use mock channel adapter (no real sends) |

---

## Configuring Each Channel

### WhatsApp (Meta Cloud API)

1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com).
2. Enable the **WhatsApp Business Platform** product.
3. Under **Webhooks**, subscribe to `messages`, `message_deliveries`, `message_reads`.
4. Set the webhook verify token to match the value stored in `omni_channel_accounts.webhook_verify_token`.
5. Webhook URL: `POST /api/omnichannel/webhooks/whatsapp`

### Instagram Messaging

1. Use the same Meta App as WhatsApp (or a separate one).
2. Enable **Instagram Basic Display** and **Instagram Messaging** products.
3. Add webhook subscriptions: `messages`, `messaging_postbacks`.
4. Webhook URL: `POST /api/omnichannel/webhooks/instagram`

### Facebook Messenger

1. Enable **Messenger** product on your Meta App.
2. Subscribe your Facebook Page to receive messages.
3. Add webhook subscriptions: `messages`, `messaging_postbacks`, `message_deliveries`, `message_reads`.
4. Webhook URL: `POST /api/omnichannel/webhooks/messenger`

### TikTok Business Messaging *(pending production approval)*

1. Apply for the TikTok for Business Messaging API.
2. Configure your App ID and Secret in the channel settings.
3. Webhook URL: `POST /api/omnichannel/webhooks/tiktok`
4. **Note**: TikTok requires manual API approval. Not usable in production until approved.

---

## Mock Mode

Set `OMNI_MOCK_MODE=true` to route all outbound messages through the `MockChannelAdapter` instead of real provider APIs. The mock adapter logs sends to stdout and always returns success. Useful for local development and integration tests.

Mock mode is automatically enabled for any channel account where:
- `provider = 'mock'`; or
- The workspace has no real credentials configured for that provider.

When `OPENAI_API_KEY` is absent, AI features (draft reply, conversation summary, intent classification) use the `MockAIProvider` which returns plausible static responses.

---

## How Webhooks Work

1. **Inbound payload** arrives at `POST /api/omnichannel/webhooks/:provider`.
2. The webhook router verifies the provider's HMAC/token signature (`META_APP_SECRET` for Meta platforms).
3. The raw payload is stored in `omni_webhook_raw_events` for replay and debugging.
4. The `EventProcessor` normalises the payload into a `NormalizedInboundMessage`.
5. Contact + conversation rows are upserted as needed.
6. A message row is inserted into `omni_messages`.
7. Any active automation flows are evaluated via `TriggerMatcher` and executed.
8. SSE events are pushed to connected dashboard clients via `sseBus`.

**Deduplication**: The `omni_messages` table has a unique constraint on `(provider_message_id, channel_account_id)`. Duplicate webhook deliveries silently no-op (ON CONFLICT DO NOTHING).

**Outbound queue**: Outbound messages are enqueued in `omni_outbound_queue`. A 5-second poll loop retries failed items with exponential backoff (30s → 60s → 120s → 300s → 600s, max 6 attempts before permanent failure).

---

## Deploying on Replit

1. Set all required secrets via **Secrets** (env vars panel) in the Replit UI.
2. Use **Deploy → Autoscale** to publish the project.
3. The deployed domain is listed in `$REPLIT_DOMAINS` — e.g. `yourapp.repl.co`.
4. Configure Meta webhook URLs to point at `https://<your-domain>/api/omnichannel/webhooks/<provider>`.
5. **TLS** is handled automatically by Replit's proxy — no extra setup needed.
6. **Database**: The Replit-managed PostgreSQL is already wired via `DATABASE_URL` in the deployment environment.

---

## Known Limitations

| Limitation | Notes |
|---|---|
| **TikTok pending** | Requires manual approval from TikTok. Cannot send messages in production without it. |
| **No real-time push** | The inbox uses Server-Sent Events (SSE) for updates. No WebSocket support; reconnection is handled client-side. |
| **Template approval manual** | WhatsApp template messages must be approved in Meta Business Manager before use. No auto-sync. |
| **Single workspace** | Each deployment serves one workspace. Multi-workspace rollup analytics are not supported. |
| **24-hour messaging window** | WhatsApp, Instagram, and Messenger enforce a 24-hour customer service window. Outbound messages outside this window fail with `ProviderMessageWindowError`. Use template messages for re-engagement. |
| **No file uploads** | Media messages are supported inbound (URL stored). Outbound media requires a publicly accessible URL. |
| **AI rate limits** | OpenAI API calls are not rate-limited at the application level. High traffic may hit provider limits. |

---

## Next Steps

- **Real-time WebSocket push** — replace SSE with Socket.IO for bi-directional updates.
- **WhatsApp template auto-sync** — periodically pull approved templates from Meta and update the templates DB table.
- **Multi-workspace analytics rollup** — aggregate metrics across workspaces for enterprise reporting.
- **ML-based intent classification** — train a domain-specific model instead of using the generic OpenAI classifier.
- **TikTok production rollout** — complete API approval and enable the TikTok adapter in production.
- **Conversation assignment rules UI** — build the dashboard for managing `omni_assignment_rules`.
- **Saved replies / canned responses UI** — expose `omni_saved_replies` in the inbox.

---

## Production Checklist

- [ ] `DATABASE_URL` secret set in Replit Secrets
- [ ] `META_APP_SECRET` secret set (required for WhatsApp/Instagram/Messenger)
- [ ] WhatsApp channel account created in `/settings/channels/whatsapp`
- [ ] WhatsApp webhook URL configured in Meta Business Manager
- [ ] WhatsApp webhook subscriptions enabled: `messages`, `message_deliveries`, `message_reads`
- [ ] Instagram channel account created (if needed)
- [ ] Instagram webhook URL configured and subscriptions enabled
- [ ] Messenger channel account created (if needed)
- [ ] Messenger webhook URL configured and subscriptions enabled
- [ ] TikTok API approval obtained (if TikTok is needed)
- [ ] `OPENAI_API_KEY` set (or `OMNI_MOCK_MODE=true` if AI features not needed)
- [ ] `omni_channel_accounts.status` for all active channels shows `connected`
- [ ] Send a test inbound message and confirm it appears in the inbox
- [ ] Send a test outbound reply and confirm delivery
- [ ] Verify SSE reconnects gracefully on network interruption
- [ ] Run integration test suite: `pnpm --filter @workspace/api-server run test:integration:local`
- [ ] Confirm `pnpm run typecheck` passes with zero errors
- [ ] Review `omni_audit_logs` for unexpected entries after smoke test
- [ ] Configure Replit Autoscale (min 1 instance) to keep the outbound queue poller alive
- [ ] Set up alerting on `omni_outbound_queue` rows with `status = 'failed'`
