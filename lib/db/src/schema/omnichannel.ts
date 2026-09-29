import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  unique,
  index,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// omni_channel_accounts — one row per connected messaging channel account
// ---------------------------------------------------------------------------
export const omniChannelAccounts = pgTable(
  "omni_channel_accounts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    externalAccountId: text("external_account_id"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    webhookVerifyToken: text("webhook_verify_token"),
    metadata: jsonb("metadata"),
    status: text("status").notNull().default("disconnected"),
    lastWebhookReceivedAt: timestamp("last_webhook_received_at", { withTimezone: true }),
    lastOutboundSendAt: timestamp("last_outbound_send_at", { withTimezone: true }),
    lastError: text("last_error"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_channel_accounts_workspace").on(t.workspaceOwnerId),
    index("idx_omni_channel_accounts_active").on(t.isActive),
    unique("omni_channel_accounts_workspace_provider_ext_unique").on(
      t.workspaceOwnerId,
      t.provider,
      t.externalAccountId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// omni_contacts — unified contact record
// ---------------------------------------------------------------------------
export const omniContacts = pgTable(
  "omni_contacts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    avatarUrl: text("avatar_url"),
    language: text("language"),
    timezone: text("timezone"),
    metadata: jsonb("metadata"),
    isBlocked: boolean("is_blocked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_contacts_workspace").on(t.workspaceOwnerId)],
);

// ---------------------------------------------------------------------------
// omni_contact_identities — per-channel identity for a contact
// ---------------------------------------------------------------------------
export const omniContactIdentities = pgTable(
  "omni_contact_identities",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => omniContacts.id, { onDelete: "cascade" }),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => omniChannelAccounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalUserId: text("external_user_id").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_contact_identities_channel_ext_unique").on(
      t.channelAccountId,
      t.externalUserId,
    ),
    index("idx_omni_contact_identities_contact").on(t.contactId),
  ],
);

// ---------------------------------------------------------------------------
// omni_conversations — one conversation thread per contact × channel
// ---------------------------------------------------------------------------
export const omniConversations = pgTable(
  "omni_conversations",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => omniChannelAccounts.id, { onDelete: "restrict" }),
    contactId: integer("contact_id")
      .notNull()
      .references(() => omniContacts.id, { onDelete: "restrict" }),
    providerConversationId: text("provider_conversation_id"),
    assignedTeamId: integer("assigned_team_id"),
    assignedAgentId: text("assigned_agent_id"),
    status: text("status").notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    subject: text("subject"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_conversations_workspace_status").on(t.workspaceOwnerId, t.status),
    index("idx_omni_conversations_contact").on(t.contactId),
    index("idx_omni_conversations_channel_account").on(t.channelAccountId),
    index("idx_omni_conversations_last_message").on(t.lastMessageAt),
    unique("omni_conversations_channel_provider_conv_unique").on(
      t.channelAccountId,
      t.providerConversationId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// omni_messages — individual messages in a conversation
// ---------------------------------------------------------------------------
export const omniMessages = pgTable(
  "omni_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => omniConversations.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    direction: text("direction").notNull(),
    messageType: text("message_type").notNull().default("text"),
    content: text("content"),
    mediaUrl: text("media_url"),
    mediaMimeType: text("media_mime_type"),
    mediaSize: integer("media_size"),
    templateName: text("template_name"),
    templateParams: jsonb("template_params"),
    interactivePayload: jsonb("interactive_payload"),
    externalMessageId: text("external_message_id"),
    providerMessageId: text("provider_message_id"),
    channelAccountId: integer("channel_account_id").references(() => omniChannelAccounts.id, {
      onDelete: "set null",
    }),
    senderName: text("sender_name"),
    senderAgentId: text("sender_agent_id"),
    status: text("status").notNull().default("sent"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_messages_conversation").on(t.conversationId),
    index("idx_omni_messages_external_id").on(t.externalMessageId),
    index("idx_omni_messages_workspace").on(t.workspaceOwnerId),
    unique("omni_messages_provider_msg_channel_unique").on(t.providerMessageId, t.channelAccountId),
  ],
);

// ---------------------------------------------------------------------------
// omni_message_events — delivery/read receipt events per message
// ---------------------------------------------------------------------------
export const omniMessageEvents = pgTable(
  "omni_message_events",
  {
    id: serial("id").primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => omniMessages.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_message_events_message").on(t.messageId)],
);

// ---------------------------------------------------------------------------
// omni_internal_notes — private notes on conversations (agents only)
// ---------------------------------------------------------------------------
export const omniInternalNotes = pgTable(
  "omni_internal_notes",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => omniConversations.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull(),
    authorName: text("author_name"),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_internal_notes_conversation").on(t.conversationId)],
);

// ---------------------------------------------------------------------------
// omni_teams — agent teams within a workspace
// ---------------------------------------------------------------------------
export const omniTeams = pgTable(
  "omni_teams",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_teams_workspace_name_unique").on(t.workspaceOwnerId, t.name),
    index("idx_omni_teams_workspace").on(t.workspaceOwnerId),
  ],
);

// ---------------------------------------------------------------------------
// omni_team_members — members of a team (Clerk user IDs)
// ---------------------------------------------------------------------------
export const omniTeamMembers = pgTable(
  "omni_team_members",
  {
    id: serial("id").primaryKey(),
    teamId: integer("team_id")
      .notNull()
      .references(() => omniTeams.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_team_members_team_agent_unique").on(t.teamId, t.agentId),
    index("idx_omni_team_members_team").on(t.teamId),
  ],
);

// ---------------------------------------------------------------------------
// omni_assignment_rules — auto-assignment rules for conversations
// ---------------------------------------------------------------------------
export const omniAssignmentRules = pgTable(
  "omni_assignment_rules",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    conditions: jsonb("conditions").notNull(),
    assignToTeamId: integer("assign_to_team_id").references(() => omniTeams.id, {
      onDelete: "set null",
    }),
    assignToAgentId: text("assign_to_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_assignment_rules_workspace").on(t.workspaceOwnerId, t.isActive)],
);

// ---------------------------------------------------------------------------
// omni_saved_replies — canned/template replies
// ---------------------------------------------------------------------------
export const omniSavedReplies = pgTable(
  "omni_saved_replies",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    shortcut: text("shortcut").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    createdByAgentId: text("created_by_agent_id"),
    isGlobal: boolean("is_global").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_saved_replies_workspace_shortcut_unique").on(t.workspaceOwnerId, t.shortcut),
    index("idx_omni_saved_replies_workspace").on(t.workspaceOwnerId),
  ],
);

// ---------------------------------------------------------------------------
// omni_tags — workspace-level tag definitions
// ---------------------------------------------------------------------------
export const omniTags = pgTable(
  "omni_tags",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_tags_workspace_name_unique").on(t.workspaceOwnerId, t.name),
    index("idx_omni_tags_workspace").on(t.workspaceOwnerId),
  ],
);

// ---------------------------------------------------------------------------
// omni_conversation_tags — tag assignments to conversations
// ---------------------------------------------------------------------------
export const omniConversationTags = pgTable(
  "omni_conversation_tags",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => omniConversations.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => omniTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_conversation_tags_unique").on(t.conversationId, t.tagId),
    index("idx_omni_conversation_tags_conversation").on(t.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// omni_contact_tags — tag assignments to contacts
// ---------------------------------------------------------------------------
export const omniContactTags = pgTable(
  "omni_contact_tags",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => omniContacts.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => omniTags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("omni_contact_tags_unique").on(t.contactId, t.tagId),
    index("idx_omni_contact_tags_contact").on(t.contactId),
  ],
);

// ---------------------------------------------------------------------------
// omni_automation_flows — automation flow definitions (JSON graph)
// ---------------------------------------------------------------------------
export const omniAutomationFlows = pgTable(
  "omni_automation_flows",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    triggerType: text("trigger_type").notNull(),
    triggerConditions: jsonb("trigger_conditions"),
    flowGraph: jsonb("flow_graph").notNull(),
    state: text("state").notNull().default("draft"),
    channelAccountId: integer("channel_account_id").references(() => omniChannelAccounts.id, {
      onDelete: "set null",
    }),
    executionCount: integer("execution_count").notNull().default(0),
    createdByAgentId: text("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_automation_flows_workspace_state").on(t.workspaceOwnerId, t.state)],
);

// ---------------------------------------------------------------------------
// omni_automation_executions — individual automation run records
// ---------------------------------------------------------------------------
export const omniAutomationExecutions = pgTable(
  "omni_automation_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: integer("flow_id")
      .notNull()
      .references(() => omniAutomationFlows.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id").references(() => omniConversations.id, {
      onDelete: "set null",
    }),
    contactId: integer("contact_id").references(() => omniContacts.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("running"),
    currentNodeId: text("current_node_id"),
    context: jsonb("context"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_omni_automation_executions_flow").on(t.flowId),
    index("idx_omni_automation_executions_conversation").on(t.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// omni_automation_events — individual step events within an execution
// ---------------------------------------------------------------------------
export const omniAutomationEvents = pgTable(
  "omni_automation_events",
  {
    id: serial("id").primaryKey(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => omniAutomationExecutions.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    nodeType: text("node_type").notNull(),
    status: text("status").notNull(),
    inputData: jsonb("input_data"),
    outputData: jsonb("output_data"),
    errorMessage: text("error_message"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_automation_events_execution").on(t.executionId)],
);

// ---------------------------------------------------------------------------
// omni_knowledge_base — knowledge base articles for AI/bot responses
// ---------------------------------------------------------------------------
export const omniKnowledgeBase = pgTable(
  "omni_knowledge_base",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    category: text("category"),
    tags: jsonb("tags"),
    isPublished: boolean("is_published").notNull().default(false),
    createdByAgentId: text("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_omni_knowledge_base_workspace").on(t.workspaceOwnerId, t.isPublished)],
);

// ---------------------------------------------------------------------------
// omni_webhook_raw_events — raw inbound webhook payloads for replay/debugging
// ---------------------------------------------------------------------------
export const omniWebhookRawEvents = pgTable(
  "omni_webhook_raw_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: integer("channel_account_id").references(() => omniChannelAccounts.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    headers: jsonb("headers"),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_webhook_raw_events_provider").on(t.provider, t.createdAt),
    index("idx_omni_webhook_raw_events_channel").on(t.channelAccountId),
    index("idx_omni_webhook_raw_events_unprocessed")
      .on(t.createdAt)
      .where(sql`processed_at IS NULL AND processing_error IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// omni_outbound_queue — DB-backed queue for outbound messages
// ---------------------------------------------------------------------------
export const omniOutboundQueue = pgTable(
  "omni_outbound_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => omniChannelAccounts.id, { onDelete: "cascade" }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => omniConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => omniMessages.id, { onDelete: "set null" }),
    recipientExternalId: text("recipient_external_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_outbound_queue_status_next").on(t.status, t.nextAttemptAt),
    index("idx_omni_outbound_queue_conversation").on(t.conversationId),
  ],
);

// ---------------------------------------------------------------------------
// omni_audit_logs — immutable audit trail for omnichannel operations
// ---------------------------------------------------------------------------
export const omniAuditLogs = pgTable(
  "omni_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    actorId: text("actor_id"),
    actorType: text("actor_type").notNull().default("agent"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_omni_audit_logs_workspace").on(t.workspaceOwnerId, t.occurredAt),
    index("idx_omni_audit_logs_resource").on(t.resourceType, t.resourceId),
  ],
);

// ---------------------------------------------------------------------------
// omni_ai_settings — per-workspace AI configuration
// ---------------------------------------------------------------------------
export const omniAiSettings = pgTable("omni_ai_settings", {
  workspaceOwnerId: text("workspace_owner_id").primaryKey(),
  openaiApiKey: text("openai_api_key"),
  autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
  confidenceThreshold: text("confidence_threshold").notNull().default("0.75"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------
export type OmniAiSettings = typeof omniAiSettings.$inferSelect;
export type OmniChannelAccount = typeof omniChannelAccounts.$inferSelect;
export type OmniContact = typeof omniContacts.$inferSelect;
export type OmniContactIdentity = typeof omniContactIdentities.$inferSelect;
export type OmniConversation = typeof omniConversations.$inferSelect;
export type OmniMessage = typeof omniMessages.$inferSelect;
export type OmniMessageEvent = typeof omniMessageEvents.$inferSelect;
export type OmniInternalNote = typeof omniInternalNotes.$inferSelect;
export type OmniTeam = typeof omniTeams.$inferSelect;
export type OmniTeamMember = typeof omniTeamMembers.$inferSelect;
export type OmniAssignmentRule = typeof omniAssignmentRules.$inferSelect;
export type OmniSavedReply = typeof omniSavedReplies.$inferSelect;
export type OmniTag = typeof omniTags.$inferSelect;
export type OmniConversationTag = typeof omniConversationTags.$inferSelect;
export type OmniContactTag = typeof omniContactTags.$inferSelect;
export type OmniAutomationFlow = typeof omniAutomationFlows.$inferSelect;
export type OmniAutomationExecution = typeof omniAutomationExecutions.$inferSelect;
export type OmniAutomationEvent = typeof omniAutomationEvents.$inferSelect;
export type OmniKnowledgeBase = typeof omniKnowledgeBase.$inferSelect;
export type OmniWebhookRawEvent = typeof omniWebhookRawEvents.$inferSelect;
export type OmniAuditLog = typeof omniAuditLogs.$inferSelect;
export type OmniOutboundQueue = typeof omniOutboundQueue.$inferSelect;
