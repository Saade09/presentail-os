/**
 * simulate-webhook — developer utility for posting sample webhook payloads
 * to the local omnichannel webhook endpoints without real provider credentials.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run simulate:webhook --provider whatsapp
 *   pnpm --filter @workspace/scripts run simulate:webhook --provider messenger
 *   pnpm --filter @workspace/scripts run simulate:webhook --provider instagram
 *   pnpm --filter @workspace/scripts run simulate:webhook --provider tiktok
 *
 * Options:
 *   --provider   whatsapp | messenger | instagram | tiktok  (required)
 *   --host       Base URL of the local server (default: http://localhost:80)
 *   --token      Webhook verify token (default: "dev-verify-token")
 *   --type       Message type to simulate: text | image | status (default: text)
 *
 * The script sends a realistic sample payload to the corresponding webhook
 * endpoint.  The server must be running locally.
 */

import { createHmac } from "crypto";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const provider = (args["provider"] ?? "whatsapp") as "whatsapp" | "messenger" | "instagram" | "tiktok";
const host = args["host"] ?? "http://localhost:80";
const verifyToken = args["token"] ?? "dev-verify-token";
const msgType = args["type"] ?? "text";

// ---------------------------------------------------------------------------
// Sample payloads
// ---------------------------------------------------------------------------

const SAMPLE_WHATSAPP_TEXT = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001234",
              phone_number_id: "123456789",
            },
            contacts: [
              {
                profile: { name: "John Doe" },
                wa_id: "15559876543",
              },
            ],
            messages: [
              {
                from: "15559876543",
                id: "wamid.HBgLMTU1NTk4NzY1NDMVAQIAOBUQAA==",
                timestamp: Math.floor(Date.now() / 1000).toString(),
                text: { body: "Hello! This is a simulated WhatsApp message." },
                type: "text",
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};

const SAMPLE_WHATSAPP_IMAGE = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001234",
              phone_number_id: "123456789",
            },
            contacts: [{ profile: { name: "Jane Doe" }, wa_id: "15559876543" }],
            messages: [
              {
                from: "15559876543",
                id: "wamid.image.HBgLMTU1NTk4NzY1NDMVAQIAOBUQAA==",
                timestamp: Math.floor(Date.now() / 1000).toString(),
                type: "image",
                image: {
                  caption: "Check this out",
                  mime_type: "image/jpeg",
                  sha256: "abc123def456",
                  id: "media_id_12345",
                },
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};

const SAMPLE_WHATSAPP_STATUS = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WHATSAPP_BUSINESS_ACCOUNT_ID",
      changes: [
        {
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001234",
              phone_number_id: "123456789",
            },
            statuses: [
              {
                id: "wamid.HBgLMTU1NTk4NzY1NDMVAQIAOBUQAA==",
                status: "delivered",
                timestamp: Math.floor(Date.now() / 1000).toString(),
                recipient_id: "15559876543",
              },
            ],
          },
          field: "messages",
        },
      ],
    },
  ],
};

const SAMPLE_MESSENGER_TEXT = {
  object: "page",
  entry: [
    {
      id: "PAGE_ID",
      time: Date.now(),
      messaging: [
        {
          sender: { id: "USER_PSID_123456" },
          recipient: { id: "PAGE_ID" },
          timestamp: Date.now(),
          message: {
            mid: `m_${Date.now()}_sim`,
            text: "Hello from Messenger! This is a simulated message.",
          },
        },
      ],
    },
  ],
};

const SAMPLE_MESSENGER_IMAGE = {
  object: "page",
  entry: [
    {
      id: "PAGE_ID",
      time: Date.now(),
      messaging: [
        {
          sender: { id: "USER_PSID_123456" },
          recipient: { id: "PAGE_ID" },
          timestamp: Date.now(),
          message: {
            mid: `m_img_${Date.now()}_sim`,
            attachments: [
              {
                type: "image",
                payload: {
                  url: "https://example.com/simulated-image.jpg",
                  sticker_id: undefined,
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

const SAMPLE_INSTAGRAM_TEXT = {
  object: "instagram",
  entry: [
    {
      id: "IG_USER_ID",
      time: Date.now(),
      messaging: [
        {
          sender: { id: "IG_SENDER_IGSID_123" },
          recipient: { id: "IG_USER_ID" },
          timestamp: Date.now(),
          message: {
            mid: `ig_${Date.now()}_sim`,
            text: "Hey there! Simulated Instagram DM.",
          },
        },
      ],
    },
  ],
};

const SAMPLE_INSTAGRAM_IMAGE = {
  object: "instagram",
  entry: [
    {
      id: "IG_USER_ID",
      time: Date.now(),
      messaging: [
        {
          sender: { id: "IG_SENDER_IGSID_123" },
          recipient: { id: "IG_USER_ID" },
          timestamp: Date.now(),
          message: {
            mid: `ig_img_${Date.now()}_sim`,
            attachments: [
              {
                type: "image",
                payload: { url: "https://example.com/simulated-ig-image.jpg" },
              },
            ],
          },
        },
      ],
    },
  ],
};

const SAMPLE_TIKTOK_TEXT = {
  // TikTok Business Messaging API event structure (mock format pending official access)
  // TODO: update with real TikTok webhook format when API access is approved
  // @see https://business-api.tiktok.com/portal/docs?id=1771101027431426
  event_type: "message",
  event_id: `tt_evt_${Date.now()}`,
  timestamp: Date.now(),
  data: {
    conversation_id: "tt_conv_abc123",
    message_id: `tt_msg_${Date.now()}`,
    sender_open_id: "tt_user_open_id_123",
    content: {
      type: "TEXT",
      text: "Hello from TikTok! Simulated DM (mock mode).",
    },
    create_time: Date.now(),
  },
};

// ---------------------------------------------------------------------------
// Payload selection
// ---------------------------------------------------------------------------

type SamplePayload = Record<string, unknown>;

function selectPayload(prov: string, type: string): { payload: SamplePayload; path: string } {
  switch (prov) {
    case "whatsapp":
      return {
        path: "/api/webhooks/whatsapp",
        payload:
          type === "image" ? SAMPLE_WHATSAPP_IMAGE :
          type === "status" ? SAMPLE_WHATSAPP_STATUS :
          SAMPLE_WHATSAPP_TEXT,
      };
    case "messenger":
      return {
        path: "/api/webhooks/messenger",
        payload: type === "image" ? SAMPLE_MESSENGER_IMAGE : SAMPLE_MESSENGER_TEXT,
      };
    case "instagram":
      return {
        path: "/api/webhooks/instagram",
        payload: type === "image" ? SAMPLE_INSTAGRAM_IMAGE : SAMPLE_INSTAGRAM_TEXT,
      };
    case "tiktok":
      return { path: "/api/webhooks/tiktok", payload: SAMPLE_TIKTOK_TEXT };
    default:
      throw new Error(`Unknown provider: ${prov}. Supported: whatsapp, messenger, instagram, tiktok`);
  }
}

// ---------------------------------------------------------------------------
// HMAC signing (for testing signature verification)
// ---------------------------------------------------------------------------

function signPayload(payloadStr: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payloadStr).digest("hex");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { payload, path } = selectPayload(provider, msgType);
  const url = `${host}${path}`;
  const payloadStr = JSON.stringify(payload, null, 2);

  // Use a dev app secret from env or a placeholder for the signature header
  const appSecret = process.env.WHATSAPP_APP_SECRET
    ?? process.env.META_APP_SECRET
    ?? "dev-app-secret-placeholder";
  const signature = signPayload(payloadStr, appSecret);

  console.log(`\nSimulating ${provider} webhook (${msgType})`);
  console.log(`POST ${url}`);
  console.log(`Payload:\n${payloadStr}\n`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-Simulate-Verify-Token": verifyToken,
      },
      body: payloadStr,
    });

    const responseText = await response.text();
    console.log(`Response: HTTP ${response.status}`);
    console.log(responseText);

    if (response.ok) {
      console.log("\nWebhook simulation succeeded.");
    } else {
      console.error("\nWebhook simulation returned an error response.");
      process.exit(1);
    }
  } catch (err) {
    console.error(`\nFailed to reach server at ${url}:`, err);
    console.error("Is the API server running? Try: restart the 'API Server' workflow.");
    process.exit(1);
  }
}

main();
