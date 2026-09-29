/**
 * Omnichannel seed script
 *
 * Inserts idempotent seed data for the omnichannel module:
 *   - 4 mock channel accounts (WhatsApp, Instagram, Messenger, TikTok)
 *   - 5 contacts with per-channel identities
 *   - 3 conversations with inbound + outbound messages
 *   - 5 default tags (Lead, VIP, Complaint, Order Issue, Needs Human)
 *   - 4 saved replies (greeting, order status, refund policy, business hours)
 *   - 1 "New Lead Qualification" automation flow definition
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run seed:omnichannel
 *
 * Requires DATABASE_URL to be set. Optionally set SEED_WORKSPACE_OWNER_ID.
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const WORKSPACE_OWNER_ID =
  process.env.SEED_WORKSPACE_OWNER_ID ?? "seed-workspace-owner";

const pool = new Pool({ connectionString: DATABASE_URL });

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ------------------------------------------------------------------
    // 1. Channel accounts
    // ------------------------------------------------------------------
    const channelAccounts: Record<string, number> = {};

    const channels = [
      {
        provider: "whatsapp",
        name: "WhatsApp Business (Mock)",
        externalAccountId: "mock_wa_account_001",
        webhookVerifyToken: "mock_wa_verify_token",
      },
      {
        provider: "instagram",
        name: "Instagram DMs (Mock)",
        externalAccountId: "mock_ig_account_001",
        webhookVerifyToken: "mock_ig_verify_token",
      },
      {
        provider: "messenger",
        name: "Facebook Messenger (Mock)",
        externalAccountId: "mock_fm_account_001",
        webhookVerifyToken: "mock_fm_verify_token",
      },
      {
        provider: "tiktok",
        name: "TikTok Messages (Mock)",
        externalAccountId: "mock_tt_account_001",
        webhookVerifyToken: "mock_tt_verify_token",
      },
    ];

    for (const ch of channels) {
      const r = await client.query<{ id: number }>(
        `INSERT INTO omni_channel_accounts
           (workspace_owner_id, provider, name, external_account_id,
            access_token, webhook_verify_token, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (workspace_owner_id, provider, external_account_id)
           DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id`,
        [
          WORKSPACE_OWNER_ID,
          ch.provider,
          ch.name,
          ch.externalAccountId,
          `mock_access_token_${ch.provider}`,
          ch.webhookVerifyToken,
        ],
      );
      channelAccounts[ch.provider] = r.rows[0].id;
    }
    console.log("✓ Channel accounts:", channelAccounts);

    // ------------------------------------------------------------------
    // 2. Contacts
    // ------------------------------------------------------------------
    const contacts = [
      {
        key: "alice",
        displayName: "Alice Johnson",
        email: "alice@example.com",
        phone: "+1555000001",
        identities: [
          { provider: "whatsapp", externalUserId: "15550000001", displayName: "Alice Johnson" },
          { provider: "instagram", externalUserId: "ig_alice_001", displayName: "alice.j" },
        ],
      },
      {
        key: "bob",
        displayName: "Bob Smith",
        email: "bob@example.com",
        phone: "+1555000002",
        identities: [
          { provider: "messenger", externalUserId: "fm_bob_001", displayName: "Bob Smith" },
        ],
      },
      {
        key: "carol",
        displayName: "Carol Diaz",
        email: "carol@example.com",
        phone: "+1555000003",
        identities: [
          { provider: "whatsapp", externalUserId: "15550000003", displayName: "Carol Diaz" },
        ],
      },
      {
        key: "dave",
        displayName: "Dave Kim",
        email: null,
        phone: "+1555000004",
        identities: [
          { provider: "tiktok", externalUserId: "tt_dave_001", displayName: "@davekim" },
        ],
      },
      {
        key: "eve",
        displayName: "Eve Nakamura",
        email: "eve@example.com",
        phone: "+1555000005",
        identities: [
          { provider: "instagram", externalUserId: "ig_eve_001", displayName: "eve.n" },
          { provider: "messenger", externalUserId: "fm_eve_001", displayName: "Eve Nakamura" },
        ],
      },
    ];

    const contactIds: Record<string, number> = {};
    for (const c of contacts) {
      const r = await client.query<{ id: number }>(
        `INSERT INTO omni_contacts
           (workspace_owner_id, display_name, email, phone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [WORKSPACE_OWNER_ID, c.displayName, c.email, c.phone],
      );
      if (r.rows[0]) {
        contactIds[c.key] = r.rows[0].id;
      } else {
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM omni_contacts
            WHERE workspace_owner_id = $1 AND display_name = $2
            LIMIT 1`,
          [WORKSPACE_OWNER_ID, c.displayName],
        );
        contactIds[c.key] = existing.rows[0].id;
      }
    }
    console.log("✓ Contacts:", contactIds);

    // Contact identities
    for (const c of contacts) {
      for (const ident of c.identities) {
        const channelAccountId = channelAccounts[ident.provider];
        if (!channelAccountId) continue;
        await client.query(
          `INSERT INTO omni_contact_identities
             (contact_id, channel_account_id, provider, external_user_id, display_name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (channel_account_id, external_user_id)
             DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
          [
            contactIds[c.key],
            channelAccountId,
            ident.provider,
            ident.externalUserId,
            ident.displayName,
          ],
        );
      }
    }
    console.log("✓ Contact identities inserted");

    // ------------------------------------------------------------------
    // 3. Conversations + messages
    // ------------------------------------------------------------------
    const conversations = [
      {
        key: "conv_alice_wa",
        contactKey: "alice",
        provider: "whatsapp",
        status: "open",
        subject: "Order inquiry",
        messages: [
          { direction: "inbound", content: "Hi, I wanted to ask about my order #1234" },
          { direction: "outbound", content: "Hello Alice! Let me look that up for you right away." },
          { direction: "inbound", content: "It was supposed to arrive yesterday" },
        ],
      },
      {
        key: "conv_bob_fm",
        contactKey: "bob",
        provider: "messenger",
        status: "pending",
        subject: "Refund request",
        messages: [
          { direction: "inbound", content: "I would like to request a refund for order #5678" },
          { direction: "outbound", content: "I understand, Bob. Could you share more details about the issue?" },
        ],
      },
      {
        key: "conv_carol_wa",
        contactKey: "carol",
        provider: "whatsapp",
        status: "resolved",
        subject: "Product availability",
        messages: [
          { direction: "inbound", content: "Is the red gift box available?" },
          { direction: "outbound", content: "Yes Carol, the red gift box is in stock!" },
          { direction: "inbound", content: "Perfect, placing an order now, thanks!" },
        ],
      },
    ];

    const conversationIds: Record<string, number> = {};
    for (const conv of conversations) {
      const contactId = contactIds[conv.contactKey];
      const channelAccountId = channelAccounts[conv.provider];
      if (!contactId || !channelAccountId) continue;

      const r = await client.query<{ id: number }>(
        `INSERT INTO omni_conversations
           (workspace_owner_id, channel_account_id, contact_id, status, subject,
            last_message_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, now(),
           CASE WHEN $4 = 'resolved' THEN now() ELSE NULL END)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [WORKSPACE_OWNER_ID, channelAccountId, contactId, conv.status, conv.subject],
      );

      let convId: number;
      if (r.rows[0]) {
        convId = r.rows[0].id;
      } else {
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM omni_conversations
            WHERE workspace_owner_id = $1 AND contact_id = $2 AND channel_account_id = $3
            LIMIT 1`,
          [WORKSPACE_OWNER_ID, contactId, channelAccountId],
        );
        convId = existing.rows[0].id;
      }
      conversationIds[conv.key] = convId;

      for (const msg of conv.messages) {
        await client.query(
          `INSERT INTO omni_messages
             (conversation_id, workspace_owner_id, direction, message_type,
              content, external_message_id, status, sent_at)
           VALUES ($1, $2, $3, 'text', $4,
             $5,
             CASE WHEN $3 = 'outbound' THEN 'sent' ELSE 'delivered' END,
             now())`,
          [
            convId,
            WORKSPACE_OWNER_ID,
            msg.direction,
            msg.content,
            `seed_msg_${conv.key}_${msg.direction}_${Math.random().toString(36).slice(2, 8)}`,
          ],
        );
      }
    }
    console.log("✓ Conversations:", conversationIds);

    // ------------------------------------------------------------------
    // 4. Tags
    // ------------------------------------------------------------------
    const tags = [
      { name: "Lead", color: "#3B82F6" },
      { name: "VIP", color: "#F59E0B" },
      { name: "Complaint", color: "#EF4444" },
      { name: "Order Issue", color: "#F97316" },
      { name: "Needs Human", color: "#8B5CF6" },
    ];

    const tagIds: Record<string, number> = {};
    for (const tag of tags) {
      const r = await client.query<{ id: number }>(
        `INSERT INTO omni_tags (workspace_owner_id, name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_owner_id, name)
           DO UPDATE SET color = EXCLUDED.color
         RETURNING id`,
        [WORKSPACE_OWNER_ID, tag.name, tag.color],
      );
      tagIds[tag.name] = r.rows[0].id;
    }
    console.log("✓ Tags:", Object.keys(tagIds));

    // Tag some conversations
    const convTagPairs: Array<[string, string]> = [
      ["conv_alice_wa", "Order Issue"],
      ["conv_bob_fm", "Complaint"],
      ["conv_bob_fm", "Needs Human"],
      ["conv_carol_wa", "Lead"],
    ];
    for (const [convKey, tagName] of convTagPairs) {
      const convId = conversationIds[convKey];
      const tagId = tagIds[tagName];
      if (!convId || !tagId) continue;
      await client.query(
        `INSERT INTO omni_conversation_tags (conversation_id, tag_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [convId, tagId],
      );
    }

    // ------------------------------------------------------------------
    // 5. Saved replies
    // ------------------------------------------------------------------
    const savedReplies = [
      {
        shortcut: "/greet",
        title: "Greeting",
        content:
          "Hello {{contact.name}}! 👋 Thank you for reaching out to us. How can I help you today?",
      },
      {
        shortcut: "/order-status",
        title: "Order Status",
        content:
          "I can help you check on your order! Could you please provide your order number so I can look it up for you?",
      },
      {
        shortcut: "/refund-policy",
        title: "Refund Policy",
        content:
          "Our refund policy allows returns within 14 days of delivery. Items must be unused and in original packaging. Would you like to start a refund request?",
      },
      {
        shortcut: "/hours",
        title: "Business Hours",
        content:
          "Our support team is available Monday–Friday, 9 AM – 6 PM (GMT+3). We'll get back to you as soon as possible! 🕘",
      },
    ];

    for (const reply of savedReplies) {
      await client.query(
        `INSERT INTO omni_saved_replies
           (workspace_owner_id, shortcut, title, content, is_global)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (workspace_owner_id, shortcut)
           DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, updated_at = now()`,
        [WORKSPACE_OWNER_ID, reply.shortcut, reply.title, reply.content],
      );
    }
    console.log("✓ Saved replies inserted");

    // ------------------------------------------------------------------
    // 6. Automation flow — "New Lead Qualification"
    // ------------------------------------------------------------------
    const flowGraph = {
      nodes: [
        {
          id: "trigger_new_conversation",
          type: "trigger",
          label: "New Conversation Started",
          config: { triggerType: "conversation.created" },
        },
        {
          id: "condition_first_time",
          type: "condition",
          label: "First time contact?",
          config: {
            field: "contact.conversationCount",
            operator: "equals",
            value: 1,
          },
        },
        {
          id: "send_greeting",
          type: "send_message",
          label: "Send Greeting",
          config: {
            messageType: "text",
            content:
              "Hi {{contact.name}}! 👋 Welcome! I'm here to help. Are you interested in our products or do you have an existing order to follow up on?",
          },
        },
        {
          id: "add_lead_tag",
          type: "add_tag",
          label: "Tag as Lead",
          config: { tagName: "Lead" },
        },
        {
          id: "wait_reply",
          type: "wait_for_reply",
          label: "Wait for Reply",
          config: { timeoutMinutes: 60 },
        },
        {
          id: "condition_keyword",
          type: "condition",
          label: "Keyword in reply?",
          config: {
            field: "message.content",
            operator: "contains_any",
            value: ["order", "buy", "purchase", "price", "cost"],
          },
        },
        {
          id: "assign_sales_team",
          type: "assign_team",
          label: "Assign to Sales Team",
          config: { teamName: "Sales" },
        },
        {
          id: "send_catalog_link",
          type: "send_message",
          label: "Send Catalog Link",
          config: {
            messageType: "text",
            content:
              "Great! Here's our catalog for you to browse: https://presentail.com/catalog — Feel free to ask about any item! 🛍️",
          },
        },
        {
          id: "add_needs_human_tag",
          type: "add_tag",
          label: "Tag Needs Human",
          config: { tagName: "Needs Human" },
        },
        {
          id: "end",
          type: "end",
          label: "End",
          config: {},
        },
      ],
      edges: [
        { from: "trigger_new_conversation", to: "condition_first_time" },
        { from: "condition_first_time", to: "send_greeting", condition: "yes" },
        { from: "condition_first_time", to: "end", condition: "no" },
        { from: "send_greeting", to: "add_lead_tag" },
        { from: "add_lead_tag", to: "wait_reply" },
        { from: "wait_reply", to: "condition_keyword", event: "reply_received" },
        { from: "wait_reply", to: "add_needs_human_tag", event: "timeout" },
        { from: "condition_keyword", to: "assign_sales_team", condition: "yes" },
        { from: "assign_sales_team", to: "send_catalog_link" },
        { from: "send_catalog_link", to: "end" },
        { from: "condition_keyword", to: "add_needs_human_tag", condition: "no" },
        { from: "add_needs_human_tag", to: "end" },
      ],
    };

    await client.query(
      `INSERT INTO omni_automation_flows
         (workspace_owner_id, name, description, trigger_type,
          trigger_conditions, flow_graph, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'active')
       ON CONFLICT DO NOTHING`,
      [
        WORKSPACE_OWNER_ID,
        "New Lead Qualification",
        "Automatically greets new contacts, tags them as leads, and routes them to the sales team based on their reply.",
        "conversation.created",
        JSON.stringify({ providers: ["whatsapp", "instagram", "messenger", "tiktok"] }),
        JSON.stringify(flowGraph),
      ],
    );
    console.log("✓ Automation flow 'New Lead Qualification' inserted");

    await client.query("COMMIT");
    console.log("\n✅ Omnichannel seed completed successfully for workspace:", WORKSPACE_OWNER_ID);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Seed failed, rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
