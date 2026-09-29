# Google Business Profile Review Ingestion — Setup Runbook

Connects the Review Rewards module to real Google reviews. One-time operator
setup in Google Cloud + workspace-level connect flow in the dashboard.

## 1. Google Cloud project

1. Create (or reuse) a Google Cloud project.
2. Enable these APIs (APIs & Services → Library):
   - **My Business Account Management API**
   - **My Business Business Information API**
   - **My Business Notifications API**
   - **Google My Business API** (legacy v4 — required for the Reviews endpoints)
   - **Cloud Pub/Sub API**
3. **Request Business Profile API quota** (operator step): the Business
   Profile APIs default to 0 QPS until Google approves access. Submit the
   [GBP API access request form](https://developers.google.com/my-business/content/prereqs#request-access)
   from the project owner's account and wait for approval.

## 2. OAuth consent + client

1. APIs & Services → OAuth consent screen: External, add the scope
   `https://www.googleapis.com/auth/business.manage`, add the Google accounts
   that manage the Business Profile as test users (or publish the app).
2. Create an OAuth 2.0 Client ID (Web application). Authorized redirect URI:
   `https://<api-host>/api/reviews/google/callback`
   (override with `GBP_OAUTH_REDIRECT_URI` if the public host differs).
3. Store the dedicated client credentials as **Replit Secrets** (never in
   `.replit`):
   - `GBP_OAUTH_CLIENT_ID`
   - `GBP_OAUTH_CLIENT_SECRET`

   Google Reviews does not fall back to `GOOGLE_CLIENT_ID` /
   `GOOGLE_CLIENT_SECRET`. Those generic credentials are reserved for other
   Google integrations, including Google Business Posts.

## 3. Pub/Sub topic + push subscription

1. Create a topic, e.g. `projects/<project-id>/topics/gbp-reviews`.
2. Grant the Business Profile notifications service account
   **Pub/Sub Publisher** on the topic:
   `mybusiness-api-pubsub@system.gserviceaccount.com`
3. Generate a long random token (e.g. `openssl rand -hex 32`) and save it as
   the Replit Secret `GBP_PUBSUB_PUSH_TOKEN`.
4. Create a **push subscription** on the topic with endpoint:
   `https://<api-host>/api/webhooks/gbp-pubsub?token=<GBP_PUBSUB_PUSH_TOKEN>`
   - Ack deadline: 60s. Retry policy: exponential backoff.
   - The endpoint acks (2xx) processed/duplicate/ignorable messages and
     returns 500 only on transient failures, so Pub/Sub retries only real
     failures. Processing is idempotent by Google `reviewId`.
5. Save the topic as the Replit Secret `GBP_PUBSUB_TOPIC`
   (full name: `projects/<project-id>/topics/gbp-reviews`).

## 4. Required secrets (summary)

| Secret | Purpose |
| --- | --- |
| `GBP_OAUTH_CLIENT_ID` / `GBP_OAUTH_CLIENT_SECRET` | Dedicated Google Business Profile OAuth client |
| `GBP_PUBSUB_TOPIC` | Full Pub/Sub topic name for notifications |
| `GBP_PUBSUB_PUSH_TOKEN` | Shared token verifying Pub/Sub push requests |
| `GBP_OAUTH_REDIRECT_URI` | Optional redirect override |
| `CREDENTIAL_ENCRYPTION_KEY` | Encrypts stored refresh tokens (already used by other connectors) |

## 5. Connect flow (per workspace, owner-only)

1. `GET /api/reviews/google/auth-url` → open the returned URL, grant the
   `business.manage` scope with the Google account that manages the profile.
2. Callback stores the connection (first GBP account, refresh token encrypted).
3. `GET /api/reviews/google/locations` → pick a **verified** location.
4. `POST /api/reviews/google/location {"locationName":"locations/<id>"}` —
   persists account/location IDs and subscribes the account's notification
   setting to `NEW_REVIEW` + `UPDATED_REVIEW` on `GBP_PUBSUB_TOPIC`.
5. `GET /api/reviews/google/status` shows connection, notification, and
   config state plus `lastError` (OAuth refresh, Pub/Sub processing, and
   review-fetch failures are recorded there and in structured logs under
   the `gbp:` prefix).

## 6. How ingestion works

- Each push notification is decoded, the review is fetched from the v4
  Reviews API, and upserted keyed by Google `reviewId`; new reviews trigger
  attribution/reward creation (backend foundation task). Duplicates and
  replays create no extra records or rewards.
- `UPDATED_REVIEW` refreshes reviewer name/rating/comment; a fetch that 404s
  marks the stored review deleted and voids any pending/approved reward.
- An hourly reconciliation job re-lists recent reviews per connected location
  (catching missed notifications) and re-checks stored reviews inside the
  7-day pending window, voiding rewards for reviews that no longer exist.

## 7. Troubleshooting

- **Status shows `lastError`** — the message includes the failing stage
  (token refresh, notification processing, reconciliation). Check server logs
  for `gbp:`-prefixed entries with full error context.
- **Webhook 401s** — the `token` query param on the push subscription does
  not match `GBP_PUBSUB_PUSH_TOKEN`.
- **Webhook 503s** — `GBP_PUBSUB_PUSH_TOKEN` is not set on the server.
- **No notifications arriving** — verify quota approval (step 1.3), the
  service account's Publisher role (step 3.2), and that the location was
  re-selected after `GBP_PUBSUB_TOPIC` was configured (the subscription is
  applied during location selection; status shows `notificationsConfigured`).
