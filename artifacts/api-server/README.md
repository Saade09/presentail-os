# Presentail API Server

## Address Collector

Automated delivery-address collection from gift recipients: WhatsApp via
respond.io with Twilio SMS fallback, a secure bilingual (EN/AR) recipient page,
and an ops dashboard ("Address Collector" in the OS sidebar).

### How it works

1. An order created without an address — OS wizard "Collect address later"
   toggle (`collect_address: true` in the manual-order payload) or an external
   checkout order with `delivery.collectAddress: true` — creates exactly one
   active `address_collection_requests` row per order (partial unique index).
2. Outreach is scheduled relative to the delivery-window start `W`:
   - first WhatsApp message at `W−4h` (immediately for late orders)
   - reminder at `W−2h`, final reminder at `W−1h` (dropped when they would
     land within 5 minutes of the first send)
   - human escalation at `W−45m` (never deferred by quiet hours)
   - SMS fallback 10 minutes after an **authoritative** WhatsApp
     failure/undelivered signal — never on mere API acceptance
   - quiet hours (default 21:00–09:00 in the delivery location's timezone)
     defer message sends to 09:00 local
3. Messages carry a secure `/address/:token` link. Tokens are stored only as
   SHA-256 hashes; the previous token stays valid until expiry so a reminder
   never strands a recipient holding the first link. Tokens expire 24h after
   the window end (72h without a window) and are invalidated on order
   cancellation.
4. The recipient submits map coordinates + written directions; the submission
   is idempotent, updates the order's `delivery_address`, and cancels all
   pending outreach.

The worker (`src/lib/addressCollector/worker.ts`) polls
`address_collection_actions` every 30s using `FOR UPDATE SKIP LOCKED`; every
action carries a unique idempotency key, so a crash/restart can never
double-send.

### respond.io configuration (manual, one-time)

- **API token**: create a workspace API token in respond.io → Settings →
  Integrations → Developer API and store it as the `RESPONDIO_API_TOKEN`
  Replit Secret. The same token powers contact auto-sync and Address Collector
  outreach.
- **WhatsApp message template**: create and get approval for the fixed
  `address_collection` template in **both** English and Arabic. The approved
  body has one positional variable:

  | Variable | Content                                              |
  |----------|------------------------------------------------------|
   | `{{1}}`  | Recipient name                                       |

- The template copy must stay **surprise-safe**: never mention the sender,
  the gift, prices, or the card message.
- The respond.io API payload uses `template.languageCode` (not `language`) and
  the body component above. The recipient replies directly with text or a
  WhatsApp location; no order number, sender details, or secure link is sent.
- **Channel**: if the workspace has multiple channels, set
  `RESPONDIO_CHANNEL_ID` to the WhatsApp channel's numeric ID; unset, the
  message goes to the contact's last-interacted channel.
- **"Open in respond.io" links**: set `RESPONDIO_SPACE_ID` (the numeric space
  ID from the respond.io inbox URL) to enable direct contact links from the
  dashboard; without it the sync state still shows, just without a link.
- **Delivery-status webhook** (optional): configure a respond.io Workflow
  (triggered on message status events for the address template) to POST to
  `POST /api/webhooks/respondio/address-status` with the shared secret in the
  `x-webhook-secret` header (`RESPONDIO_STATUS_WEBHOOK_SECRET`). Processing is
  idempotent and verified.

  The worker writes the request UUID as the `address_collection_ref` custom
  attribute on the respond.io contact before sending the template. The Workflow
  HTTP-request step body must read that attribute and include the message ID:

  ```json
  {
    "request_ref": "{{ contact.address_collection_ref }}",
    "status": "{{ message.status }}",
    "provider_ref": "{{ message.id }}"
  }
  ```

  Accepted values for `status`: `accepted`, `queued`, `sent`, `delivered`,
  `failed`, `undelivered`.

  `provider_ref` doubles as a fallback key: if `request_ref` resolves to no
  active row (e.g. the contact attribute held a stale ref from a prior
  request), the server looks up the matching `address_collection_actions` row
  by `provider_ref` and still applies the status update.

### Respond.io Support-agent Address Collector fallback

The existing generic Respond.io order Find/Update actions remain unchanged.
When the normal signed incoming-message webhook cannot complete an active
Address Collector reply, the Support agent may use this dedicated,
address-only action:

```text
POST /api/respondio/ai/address-collection/fallback
Authorization: Bearer <RESPONDIO_AI_AGENT_SECRET>
X-Respondio-Channel-Id: <current Respond.io channel ID>
Content-Type: application/json
```

The recipient never supplies a phone or order number. Configure the Respond.io
HTTP action to send the recipient's reply in `address`. `contact_phone` is
optional, but when supplied it becomes a strict correlation input:

```json
{
  "address": "{{ input.address }}"
}
```

That one-field object is the minimum accepted request. When Respond.io exposes
the current inbound provider message ID, it may also send `message_id`; otherwise
the server derives a stable idempotency key from the authenticated
workspace/channel, optional normalized contact phone, selected request/order, and
canonical submitted address. Concurrent and recent retries of the same
no-message-ID payload return the existing resolved result instead of writing
the address or audit events twice.

Both entry paths trust Respond.io only after authentication: the webhook must
have a valid signature, and the HTTP action must have the bearer secret. The
server then scopes requests to the uniquely mapped workspace and channel.
Respond.io contact IDs and phone values are optional; when supplied, they must
match the correlated inbound/request identity or the operation fails closed. The server considers only
non-terminal, unexpired Address Collector requests with a missing address in
that workspace. Conflicting references, tied candidates, or other ambiguous
matches still fail closed.

For stronger correlation, pass either or both optional references when
Respond.io exposes them:

```json
{
  "contact_phone": "{{ contact.phone }}",
  "address": "12 Cedar Street, Achrafieh, Beirut",
  "message_id": "{{ message.id }}",
  "reply_to_provider_ref": "{{ message.replyToMessageId }}",
  "address_collection_ref": "{{ contact.address_collection_ref }}",
  "contact_id": "{{ contact.id }}"
}
```

- `reply_to_provider_ref` identifies the outbound Address Collector template
  message and takes precedence over recency.
- `address_collection_ref` is the current Address Collector request UUID. When
  both exact references are present, they must identify the same request.
- `message_id` is optional. When present it remains the provider replay key;
  when absent the server uses the deterministic fallback key described above.
- `contact_id` is optional. If the active request already stores a different
  Respond.io contact ID, the match is rejected.
- Empty or unresolved optional `message_id`, `reply_to_provider_ref`,
  `address_collection_ref`, and `contact_id` values are ignored. The action
  should omit unavailable optional fields rather than sending placeholders.
- `address` accepts either plain text or the same structured address object
  accepted by the generic order update API.

No order number is accepted or required. Unknown fields are rejected, and this
action can mutate only `delivery_address`. It cannot update the card message,
delivery date or slot, recipient identity, order status, pricing, or any other
order field.

Successful response:

```json
{
  "success": true,
  "changed": true,
  "idempotent": false,
  "order_id": "2479",
  "order_number": "LB-2479",
  "address_collection_ref": "8feee57f-c542-4c88-b84b-ab26ba35efb3",
  "delivery_address": {
    "address": "12 Cedar Street, Achrafieh, Beirut",
    "latitude": 33.89,
    "longitude": 35.50
  }
}
```

If the address itself is unclear or cannot be validated/geocoded, the action
returns HTTP `422` with `code: "ADDRESS_REQUIRES_CLARIFICATION"`. That is the
only case in which the Support agent should ask the recipient for more detail.
Missing/ambiguous active requests, tenant/channel mismatches, fulfillment
gates, conflicting exact references, and concurrent processing return explicit
non-success responses and must be escalated rather than guessed.

When the signed incoming-message worker already owns the same strictly
correlated reply, the fallback returns `processing: true`, `saved: false`, and
no delivery address while that claim is genuinely active. Support must not tell
the recipient that the address was updated from this acknowledgement. A later
retry returns the stored result if native processing succeeded; if native
processing ended in review, or its ten-minute claim expired, the authenticated
fallback safely takes over and runs the same validated, transactional save.
Clarification/review responses remain definitive and should be escalated when a
retry cannot safely resolve them.

On success OS atomically replaces stale placeholder/`noAddress` metadata,
resolves the Address Collector request, records Address Collector and order
audit events, cancels pending reminders, and queues the existing Tookan
destination update when the order has a Tookan task.

### WhatsApp order notifications (respond.io)

Customer-facing order updates are sent as approved WhatsApp utility templates
to the order's **customer** contact (never the gift recipient), and **only**
when the contact has explicitly opted in (`whatsapp_consent`, toggled on the
Contact Profile page or via `PATCH /contacts/{id}/consent`):

| Trigger | Exact approved template | Language | Required components, in order | Body variables |
|---|---|---|---|---|
| Order placed (manual wizard or external ingest) | `new_order_received` | `en` | IMAGE header, then body | `{{1}}` first name, `{{2}}` display order number, `{{3}}` delivery date, `{{4}}` delivery time |
| Status → `ready_for_delivery` | `order_ready` | `en` | IMAGE header, then body | `{{1}}` first name, `{{2}}` display order number |
| Status → `completed` (delivered) | `order_delivered` | `en` | IMAGE header, then **empty-parameter body** | none; the provider-managed static body remains visible |
| Unpaid Whish payment instructions | `whishpayment` | `en` | body | `{{1}}` available full customer name, `{{2}}` stored currency, `{{3}}` stored two-decimal amount |

The approved delivered body is static and reads:

> Your order has been delivered! 💐
>
> Thank you for choosing Presentail ❤️ We hope they love it!
>
> If you have a moment, we’d really appreciate it if you could leave us a
> review. Your feedback means a lot to us.

The outbound payload retains the approved **Leave a Review** URL button and
includes a `body` component with the exact static text and `parameters: []`.
This preserves enough structure for Respond.io Inbox rendering as well as the
provider-approved WhatsApp message.

The current selected WhatsApp channel is configured with
`RESPONDIO_CHANNEL_ID`. It is required for these four sends: the server fails
the attempt visibly if it is missing, the image/header shape is wrong, or the
number of body values differs from the approved template. Template names are
not runtime-overridable, so an unreviewed environment value cannot silently
change the provider contract. Header artwork can still be replaced only with
an approved public HTTPS image using `RESPONDIO_IMG_NEW_ORDER`,
`RESPONDIO_IMG_ORDER_READY`, or `RESPONDIO_IMG_ORDER_DELIVERED`.

Opt-in sources:
- Contact Profile toggle / `PATCH /contacts/{id}/consent`.
- Storefront checkout: the external create-order payload (`POST /api/orders`)
  accepts `"whatsapp_opt_in": true|false` at the top level. `true` enables
  `whatsapp_consent` on the billing contact (notifications go to the billing
  E.164 phone already on the order); `false` or absent leaves existing
  consent **unchanged** — ingest never revokes a consent granted elsewhere,
  since older clients default the flag to false.

Notes:
- All four templates are English-only and must be **approved** on the selected
  WhatsApp channel before sends succeed. The common sender serializes
  `template.languageCode` (not `language`) and uses positional body values in
  the table's order.
- Sends are best-effort and fire-and-forget from every status-change path
  (dashboard status PATCH, florist ready-for-delivery, Tookan webhook/poller);
  a failure never blocks the order mutation.
- The respond.io contact is found-or-created on demand and its ID persisted,
  same as the contact auto-sync path.
- A successful send means only that respond.io **accepted** the request. It is
  neither a WhatsApp delivered/read receipt nor proof that a customer saw it.

#### Controlled template smoke verification

The developer-only smoke utility audits all four template records on the
configured channel before it will send anything. It reports only template names
and pass/fail outcomes; it never prints credentials, contact IDs, request
payloads, or provider response bodies.

```sh
# Safe metadata audit — no message is sent.
pnpm --filter @workspace/api-server exec tsx scripts/respondio-smoke.ts

# Intentional sandbox-only send. The contact must carry the exact dedicated
# Respond.io tag named by RESPONDIO_SMOKE_SANDBOX_TAG.
RESPONDIO_SMOKE_SANDBOX_CONTACT_ID=<sandbox-contact-id> \
RESPONDIO_SMOKE_SANDBOX_TAG=<dedicated-sandbox-tag> \
RESPONDIO_SMOKE_SEND=1 \
pnpm --filter @workspace/api-server exec tsx scripts/respondio-smoke.ts
```

After all four requests are accepted, open the dedicated sandbox conversation
in respond.io to confirm the approved text, placeholder rendering, image
headers, and delivered review button. Delivery/read state must be confirmed
separately from Respond.io status events.

### Known provider limitations

- The respond.io message API returns success when the message is **accepted**
  for sending — it is not a WhatsApp delivery receipt. We record it as
  `provider_status='accepted'` only.
- If your respond.io setup cannot post delivery statuses back, set
  `ADDRESS_COLLECTOR_WA_TIMEOUT_MINUTES` — when the first message gets no
  delivered/opened signal within that many minutes, it is treated as
  undelivered and the SMS fallback is scheduled. Without either signal source,
  SMS fallback only fires on permanent respond.io send failures.
- Outreach outside the 24-hour WhatsApp customer-service window requires an
  **approved** WhatsApp template; an unapproved or missing template makes
  every send fail permanently.
- Twilio error 21610 (recipient replied STOP) marks the request
  `sms_opt_out` and routes it to Needs attention; the recipient is never
  texted again.

### Supplier statement collection delivery

Supplier statement schedules are executed by the API worker every 30 seconds.
The worker creates one request per schedule/entity/supplier/exact period using a
database idempotency key, claims due steps with row locks, and never retries a
stale provider claim whose outcome is unknown. A request is closed only by an
exact-period correlated statement document or an authorized manual receipt;
replies and provider delivery events remain separate timeline events.

Email uses a separate Resend sender and the existing signed
`POST /api/webhooks/resend` for both delivery and `email.received` events.
Set `SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS` to the actual Resend receiving
address and enable receiving for its domain in Resend. Supplier emails use
that address as Reply-To (customer/admin Reply-To values are unchanged).
Received emails are fetched with the Resend Receiving API; attachments are
downloaded and saved to private object storage. Only mail to that address
from a request's approved recipient is eligible for matching. An exact
provider reply reference or a single open request for the approved sender
establishes the request; ambiguous matches are not attached. A document must
be available and show both requested period boundary dates to close a request.
The old Postmark-shaped supplier statement adapter is removed. Resend must
subscribe the existing webhook to `email.received` in addition to its
existing delivery events; a configured address alone does not establish
that receiving or the webhook subscription is live.

WhatsApp uses the already authenticated Respond.io Developer Webhook at
`POST /api/respondio/incoming-message` for inbound text/documents/images and the
existing `POST /api/webhooks/respondio/address-status` boundary for statuses.
Supplier traffic must carry `supplier_statement_collection` in the incoming
message namespace (or an exact reply-to outbound message reference). A
contact-level attribute alone is insufficient: contacts can also send
customer/support messages. Explicitly marked but uncorrelated supplier messages
are ignored rather than sent to customer handlers. The exact
approved template name is `supplier_statement_request`, with variables in this
order: supplier/contact name, Presentail entity, exact period start date, exact
period end date. A successful Respond.io API response is recorded as
`provider_status='accepted'` / `Sent`; `delivered`, `read`, `failed`, and
`replied` require provider events, and none of them means Statement Received.
Provider retries are deduplicated by event/message IDs. Ambiguous or
wrong-period attachments are stored as `Needs attention` and do not stop the
journey.

Operators should configure the Respond.io Developer Webhook signing key as
`RESPONDIO_INCOMING_WEBHOOK_SECRET`, keep the status secret in
`RESPONDIO_STATUS_WEBHOOK_SECRET`, and configure the status workflow to send
`provider_ref` plus the status to `/api/webhooks/respondio/address-status`.
The `SUPPLIER_STATEMENT_READINESS` response is available at
`GET /api/supplier-statement-readiness` for an authenticated finance/suppliers
operator. It reports missing secrets and external configuration without
claiming that an unconfigured inbound domain, mailbox, or template is ready.

### Environment variables

| Variable | Purpose |
|---|---|
| `RESPONDIO_API_TOKEN` | respond.io Developer API token (enables contact sync + WhatsApp outreach) |
| `RESPONDIO_SPACE_ID` | Optional numeric space ID for "Open in respond.io" links |
| `RESPONDIO_CHANNEL_ID` | Optional WhatsApp channel ID (unset = last-interacted channel) |
| `RESPONDIO_STATUS_WEBHOOK_SECRET` | Enables + verifies the delivery-status webhook |
| `SUPPLIER_STATEMENT_WHATSAPP_LANGUAGE` | Approved language code for the fixed `supplier_statement_request` template (default `en`) |
| `SUPPLIER_STATEMENT_FROM` | Separate Resend sender for supplier collection email |
| `SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS` | Actual Resend receiving mailbox used as supplier-only Reply-To; receiving and `email.received` webhook subscription must also be enabled in Resend |
| `RESEND_API_KEY` / `RESEND_WEBHOOK_SECRET` | Existing Resend API and signed shared webhook credentials; required for receiving and supplier email delivery |
| `RESPONDIO_OUTBOUND_WEBHOOK_SECRET` | HMAC secret for manual outbound-template webhooks; falls back to the status secret |
| `RESPONDIO_INCOMING_WEBHOOK_SECRET` | Dedicated signing key configured on the Respond.io New Incoming Message Developer Webhook; no fallback |
| `RESPONDIO_AI_AGENT_SECRET` | Dedicated bearer secret for Respond.io AI Agent order lookup/edit actions; never reuse provider API or webhook secrets |
| `RESPONDIO_IMG_NEW_ORDER` / `RESPONDIO_IMG_ORDER_READY` / `RESPONDIO_IMG_ORDER_DELIVERED` | Optional approved public HTTPS artwork for required order-template IMAGE headers |
| `RESPONDIO_SMOKE_SANDBOX_CONTACT_ID` | Developer-only sandbox contact ID for an intentional template smoke send; never use a customer |
| `RESPONDIO_SMOKE_SANDBOX_TAG` | Exact dedicated Respond.io tag required on the sandbox contact before a smoke send can run |
| `RESPONDIO_SMOKE_SEND` | Must equal `1` before the smoke utility sends any message |
| `ADDRESS_COLLECTOR_WA_TIMEOUT_MINUTES` | Optional undelivered timeout (0/unset = disabled) |
| `ADDRESS_COLLECTOR_QUIET_HOURS` | Quiet hours as `21-9` (start-end, 24h clock) |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | SMS fallback (existing pattern); missing config marks SMS actions `blocked` and surfaces them in Needs attention |
| `APP_PUBLIC_URL` | Base URL used to build the secure `/address/:token` links |
| `GOOGLE_PLACES_SERVER_KEY` | Google Places API key (server-side only); enables the `/api/address-book/places/google-autocomplete` and `/api/address-book/places/google-details` proxy endpoints. Without it those routes return 503. |

### Address Collector webhook subscriptions

Configure the Respond.io channel/account in OS first. Its provider account row
must use `provider='respondio'`, the Respond.io channel ID as
`external_account_id`, and the owning OS workspace. Events with no unique active
channel mapping are rejected instead of being guessed into a workspace.

#### Developer Webhook provider contract (verified 2026-09-01)

Respond.io's current official Webhooks documentation states that every
Developer Webhook endpoint call includes `X-Webhook-Signature`. The value is
base64-encoded HMAC-SHA256 over `JSON.stringify(requestBody)`, using the
`signingKey` shown when the webhook endpoint is configured. The prior local
fixtures signed arbitrary raw wire bytes and reused the delivery-status secret;
those were local assumptions, not evidence of the provider contract.

The current **New Incoming Message** sample is an `application/json` POST with
these top-level keys: `event_type`, `event_id`, `contact`, `message`, `sender`,
and `channel`. The outer `message` object carries `messageId`,
`channelMessageId`, `contactId`, `channelId`, `traffic`, `timestamp`, optional
`replyTo`, and a nested `message` content object. Text content uses
`message.message.type='text'` plus `text`; native Location content uses
`message.message.type='location'` plus numeric `latitude` and `longitude`.
Sanitized tests mirror that provider sample without retaining customer data.

In Respond.io, open **Workspace Settings → Integrations → Webhooks**, add a
**New Incoming Message** endpoint pointing to
`POST /api/respondio/incoming-message`, and save its generated signing key as
the dedicated Replit Secret `RESPONDIO_INCOMING_WEBHOOK_SECRET`. Do not put the
key in the endpoint URL, commit it, or reuse
`RESPONDIO_STATUS_WEBHOOK_SECRET`. Invalid, missing, or malformed signatures
are rejected with HTTP 401. Authenticated valid JSON deliveries, including
provider samples and unsupported message shapes, receive HTTP 200 before any
database, matching, AI, geocoding, order, or Tookan work begins.

Subscribe a Respond.io Workflow HTTP step to these Address Collector endpoints:

- `POST /api/respondio/outbound-template` for a one-to-one outgoing template
  send. Sign the raw JSON body with HMAC-SHA256 in
  `X-Webhook-Signature`. The payload must include `data.channel.id`,
  `data.contact.id`, contact phone and name, `data.message.id`,
  `data.message.direction='outgoing'`,
  `data.message.type='whatsapp_template'`, send timestamp, and
  `data.message.template.name='address_collection'`. Other templates are
  acknowledged as ignored. Replayed message IDs update no second receiver and
  never enqueue a second OS send.
- `POST /api/respondio/incoming-message` for incoming text and location
  messages. Respond.io must receive HTTP 200 within five seconds, so this route
  verifies the signature and parses JSON synchronously, acknowledges immediately,
  then registers and processes the message asynchronously. Respond.io signs
  `JSON.stringify(requestBody)` with the endpoint's generated signing key and
  sends the base64 digest (without a `sha256=` prefix) in
  `X-Webhook-Signature`. Include channel ID, contact ID,
  contact phone, provider message ID, direction, and either text or location
  coordinates. Plain text, direct Google Maps coordinates, allowlisted
  shortened Google Maps links, Apple Maps coordinates, and shared locations
  are supported. Exact outbound-message reply context wins; otherwise contact
  or country-aware phone fallback proceeds only when exactly one active request
  exists in the mapped workspace. Ambiguous and unsupported replies are stored
  for review and never mutate an order. A usable text address is accepted when
  assessment, geocoding, and country/city compatibility establish a plausible
  location; exact provider matching is not required. The submitted text remains
  the canonical address while normalized provider labels and match evidence are
  supporting metadata.
- `POST /api/webhooks/respondio/status` is an obsolete, non-processing alias
  that returns HTTP 410. It does not share authentication or behavior with the
  canonical Developer Webhook route. Update old subscriptions to
  `/api/respondio/incoming-message`; delivery statuses belong only at
  `/api/webhooks/respondio/address-status`.
- `POST /api/webhooks/respondio/address-status` for accepted, queued, sent,
  delivered, failed, or undelivered transitions. Authenticate with
  `X-Webhook-Secret`. Include the exact `provider_ref` message ID and `status`;
  `request_ref` may also be supplied as a guard. Mismatched message/request
  pairs are ignored.

Successful replies update the order's canonical `delivery_address` JSON
(`address`/`formattedAddress`, city and area when available, country,
`countryCode`, `latitude`/`longitude`, `lat`/`lng`, and geocoding/place
metadata), resolve the collector request, cancel pending reminders, and append
both collector history and an order activity event in one transaction. If the
order already has a Tookan job, a durable idempotent
`tookan_destination_update` action edits that existing task; this path never
creates a Tookan task and transient edit failures remain pending for retry.

#### Non-destructive inbound production verification

After publishing, run the verifier with the published API base URL. It signs a
sanitized provider-shaped incoming text event using the dedicated incoming
webhook signing key and a random channel ID that cannot map to a workspace, so
the route and signature parser are exercised without selecting or changing a
customer order:

```sh
pnpm --filter @workspace/api-server exec tsx \
  scripts/verify-respondio-inbound.ts https://your-published-api.example
```

A healthy route returns HTTP 200 with `accepted: true` in under five seconds.
The verifier reports the endpoint, status, response time, and signature result.
It never reports the signing key, signature value, body, contact identifier, or
secret-bearing URL.
The synthetic inbound
record is expected to finish with `unmapped_channel`; no request, order,
collector audit, reminder, or Tookan action can be associated with it.

Each incoming delivery now writes two bounded operational records:
`respondio incoming webhook diagnostic receipt` summarizes only transport,
known structural keys, provider/channel/contact identifiers, message-shape
presence flags, and allowlisted native coordinate paths/values; `respondio
incoming webhook outcome` records the HTTP status, accepted/ignored state,
parser classification, and any fixed rejection/error code. Neither record
includes phone values, names, message text, signatures, secrets, raw bodies,
conversation history, or arbitrary parser errors. The canonical endpoint also
applies this bounded contract to body-parser failures before the route handler.
The obsolete `/webhooks/respondio/status` path bypasses incoming parsing and
diagnostics entirely and always returns HTTP 410.

After publication, send one plain text reply and one native WhatsApp location.
Correlate the two records by provider message ID and confirm the outcomes are
classified as `text` and `location` respectively. A Google Maps URL sent as
message text remains classified as `text`; its coordinates are resolved only
by the existing asynchronous address-processing path.

### Respond.io AI Agent order actions

Store a strong random value in the Replit secret
`RESPONDIO_AI_AGENT_SECRET`. Configure both Respond.io HTTP Request actions
with `Authorization: Bearer <RESPONDIO_AI_AGENT_SECRET>` and
`Content-Type: application/json`. Never put the secret in a URL, query
parameter, prompt, or workflow log.

Production endpoints:

- `POST https://os.presentail.com/api/respondio/ai/orders/find`
- `PATCH https://os.presentail.com/api/respondio/ai/orders/{orderId}`
- `POST https://os.presentail.com/api/respondio/workflows/order-address-change`

If several active Respond.io workspaces are connected, send the Respond.io
channel ID in `X-Respondio-Channel-Id`. The server resolves the existing active
channel mapping and fails closed if it is missing or ambiguous; the caller
cannot submit an OS workspace ID.

Canonical Respond.io "Find customer order" HTTP Request action:

```json
{
  "orderNumber": "$agent.order_number"
}
```

Define `order_number` as a required Text input under **Information the AI Agent
may need**. A conversation phone is not required when a public order number is
available.

Use `POST`, `Content-Type: application/json`, and the bearer header documented
above. The response always has `success` and `found`. A match returns HTTP 200
with `found: true` and a safe canonical `order`. A unique public order-number
match inside the authenticated Respond.io workspace is trusted without phone
verification. The compatibility field `verification_required` is always false
because this trusted action has no separate phone-verification step. A match
returns `verified: true`, and `order` contains the handoff fields `orderId` and
`orderNumber`:

```json
{
  "found": true,
  "verified": true,
  "order": {
    "orderId": "2567",
    "orderNumber": "LB-2567",
    "status": "processing"
  }
}
```

The agent must retain `order.orderId` as the canonical identifier for the edit
action. It must not stop or request manual assistance because a customer phone
is absent or differs from the order. No match or an ambiguous match returns HTTP
200 with `found: false`, `verified: false`, and
`verification_required: false`.

Either canonical identifier may be supplied independently. Contact metadata is
not required when `orderNumber` or `phone` is explicit:

```json
{
  "orderNumber": "Order 2465"
}
```

Order values may be strings or numbers. `2465`, `"2465"`, `"#2465"`, and
`"Order 2465"` resolve to the same customer-facing order. A complete prefixed
number such as `LB-2465` is also accepted. Internal order UUIDs are rejected and
never returned.

Phone lookup normalizes E.164, bare international, and supported local forms;
for example, `+971562015111`, `971562015111`, and `0562015111` are equivalent.
Matches are constrained to the authorized OS workspace and the order's customer
or recipient roles. When both identifiers are sent, they must resolve to the
same order. Missing, ambiguous, or non-owned identifiers return `found: false`.
An explicit valid public order number is not hidden merely because the order is
older than 90 days or has a terminal status.

For compatibility, `order_number`, `order_id`, and `order_identifier` are
accepted as aliases for `orderNumber`; `customer_phone` and `phone_number` are
accepted as aliases for `phone`, and `contactPhone`, `contact_phone`, and
`phoneNumber` match Respond.io field naming variants. If duplicate aliases contain conflicting
values, the endpoint returns HTTP 400 `CONFLICTING_IDENTIFIERS`. Unusable
identifiers return HTTP 400, invalid bearer authentication returns HTTP 401,
workspace mapping failures return HTTP 503, and only unexpected backend errors
return HTTP 500. The legacy `count`, `orders`, `verified`, and
`verification_required` response fields remain available during migration.

Edit request:

```json
{
  "changes": {
    "card_message": "Happy birthday!",
    "recipient_name": "Rami Khalil",
    "recipient_phone": "+96171111222",
    "delivery_address": {
      "address": "12 Cedar Street",
      "district": "Achrafieh",
      "city": "Beirut",
      "countryCode": "LB"
    },
    "delivery_date": "2026-09-10",
    "delivery_slot": { "start_time": "14:00", "end_time": "18:00" }
  }
}
```

Only `card_message`, `recipient_name`, `recipient_phone`, `delivery_address`,
`delivery_date`, and `delivery_slot` are accepted. Date and slot must be sent
together. Address changes must pass the existing address safeguard and
geocoder, preserve structured fulfillment metadata, and update Tookan when
applicable. Recipient changes affect only the recipient role.

Respond.io primarily uses the single-change form below. `change_type` must be
one of `card_message`, `delivery_date`, `delivery_time`, `delivery_slot`,
`delivery_address`, `recipient_phone`, or `recipient_name`; every other value
is rejected:

```json
{
  "change_type": "card_message",
  "new_value": "$agent.new_value"
}
```

For the edit action, define required Text inputs `order_id`, `change_type`, and
`new_value`. Its URL is
`https://os.presentail.com/api/respondio/ai/orders/$agent.order_id`. In the
action instructions, require the agent to run the find action first, proceed
only when it returns `found: true`, copy the returned `order.orderId` into
`order_id`, and preserve the requested supported field/value. Do not add or ask
for a verification phone.

`delivery_date` uses the order's existing slot. `delivery_time` and
`delivery_slot` use the order's existing date; their `new_value` can be a
`HH:MM–HH:MM` string or `{ "start_time": "14:00", "end_time": "18:00" }`.
The existing `changes` object remains supported for multi-field updates.
Both update forms return the prefix-free `order_id`, complete `order_number`,
and safe `order` object. Single-change responses additionally include
`change_type`, `previous_value`, and `new_value`. Use
the lookup's `order.orderId` in the PATCH URL. The complete
customer-facing order number is also accepted.
PATCH trusts the authenticated Respond.io action and workspace-scoped public
order identifier. Optional legacy phone fields remain accepted but do not
authorize or block the change.

#### Explicit delivery-address corrections

Prefer the canonical Find-then-PATCH flow below for every support-initiated
correction to an existing order. The bearer-authenticated
`/respondio/ai/address-collection/fallback` remains the compatibility action for
recipient Address Collector replies. If the live agent already called that
compatibility action and native processing ended in `needs_review`, a later
agent call with one unambiguous collector request and a concrete address now
runs the same validation/geocoding and persists the correction instead of
returning another unsaved review result.

For an AI Agent HTTP action, run Find first, retain `order.orderId`, then call
the normal PATCH endpoint:

```json
{
  "change_type": "delivery_address",
  "new_value": "$agent.new_value"
}
```

On HTTP 200, proceed only when `saved: true` and use the returned
`delivery_address` as the canonical stored value. `changed: false` with
`saved: true` is a successful idempotent retry.

A Respond.io Workflow may submit the same explicit correction to:

```text
POST /api/respondio/workflows/order-address-change
X-Webhook-Signature: <base64 HMAC-SHA256 of the exact raw JSON body>
X-Respondio-Channel-Id: <current Respond.io channel ID>
Content-Type: application/json
```

Sign with the dedicated `RESPONDIO_INCOMING_WEBHOOK_SECRET`; do not send that
secret itself. The strict request body is:

```json
{
  "order_id": "{{ workflow.order_id }}",
  "delivery_address": "{{ workflow.proposed_address }}",
  "channel_id": "{{ channel.id }}",
  "request_id": "{{ workflow.id }}"
}
```

`order_id` must be the canonical public identifier from Find, never an internal
UUID or unresolved action placeholder. `delivery_address` may be text or the
structured object shown above. `channel_id` is signed as part of the JSON body
and must exactly match `X-Respondio-Channel-Id`; this prevents moving a signed
correction between channels or workspaces. `request_id` is required and must be
the stable, unique Respond.io workflow delivery identifier. A replay returns
the original saved outcome without writing twice; reusing the ID with a
different address is rejected.

The signed workflow and bearer PATCH paths share the same workspace-scoped,
locked validation/geocoding, audit, collector reconciliation, and
fulfillment/Tookan propagation. A successful response reports `status:
"saved"`, `saved: true`, and the stored `delivery_address`. `status:
"clarification"` with `ADDRESS_REQUIRES_CLARIFICATION` means ask for a more
specific address. `status: "rejected"` means do not claim the change was saved;
surface the returned code for staff action. Native incoming-message
acknowledgements remain separate and never become implicit order edits.

Successful non-no-op edits append one OS Activity event with source
`respondio_ai_agent`, normalized customer phone, changed field names, and
before/after values. Identical retries return `changed: false` and create no
duplicate event. Reschedules use the OS timezone, configured dates/slots,
capacity, planning, Tookan, and customer notification workflow.

Stable errors:

| HTTP | Code | Meaning |
|---:|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_CUSTOMER_PHONE`, `INVALID_RECIPIENT_PHONE`, `INVALID_DELIVERY_SCHEDULE` | Invalid or unsupported input |
| 401 | `UNAUTHORIZED` | Missing or invalid bearer secret |
| 403 | `ORDER_ACCESS_DENIED` | Order/customer ownership check failed |
| 409 | `ORDER_NOT_EDITABLE` | Terminal or out-for-delivery order |
| 409 | `MANUAL_APPROVAL_REQUIRED` | Fulfillment has started; OS staff must handle the change |
| 409 | `DELIVERY_SLOT_UNAVAILABLE` | Requested slot is unavailable; safe alternatives may be returned |
| 422 | `ADDRESS_REQUIRES_CLARIFICATION` | Address is incomplete, unsafe, or cannot be geocoded |
| 503 | `SERVICE_NOT_CONFIGURED`, `WORKSPACE_MAPPING_UNAVAILABLE`, `TEMPORARILY_UNAVAILABLE` | Secure configuration or dependency unavailable |

### Data model

- `address_collection_requests` — one active row per linked order or Respond.io
  contact; optional order association, source, provider contact/channel
  identity, status, risk level, hashed tokens, window, reply outcome, and
  submitted address + lat/lng.
- `address_collection_actions` — scheduled outreach with unique idempotency
  keys, attempt counts, provider ref/status, and error fields.
- `address_collection_events` — timestamped activity timeline for every state
  transition and provider signal.

DDL lives in `src/lib/initDb.ts` (canonical), with matching Drizzle schemas in
`lib/db/src/schema/addressCollector.ts` (parity-checked by
`initDb.drift.test.ts`).
