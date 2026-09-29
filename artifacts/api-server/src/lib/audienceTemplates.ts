/**
 * System opportunity templates — prefilled rule trees served with live counts.
 * Nothing is persisted until the client saves the audience itself.
 */
import { RULE_SCHEMA_VERSION, type RuleTree } from "./audienceRules";

export type AudienceTemplate = {
  key: string;
  name: string;
  description: string;
  /** Which parameters the client may edit (documented knobs). */
  editableParams: { path: string; label: string; defaultValue: number }[];
  rules: RuleTree;
};

/** Build the three system templates. `lapsedDays` customizes template #2. */
export function buildTemplates(lapsedDays = 180): AudienceTemplate[] {
  return [
    {
      key: "recipients_never_purchased",
      name: "Recipients who never purchased",
      description:
        "People who have received a gift but have never placed an order themselves.",
      editableParams: [],
      rules: {
        schemaVersion: RULE_SCHEMA_VERSION,
        include: {
          logic: "ALL",
          conditions: [
            { field: "gifts_received_count", operator: "gte", value: 1 },
            { field: "orders_count", operator: "eq", value: 0 },
          ],
        groups: [
            {
              logic: "ANY",
              conditions: [
                { field: "email_reachable", operator: "is_true" },
                { field: "whatsapp_reachable", operator: "is_true" },
              ],
            },
          ],
        },
        exclude: {
          logic: "ALL",
          conditions: [{ field: "is_suppressed", operator: "is_true" }],
        },
      },
    },
    {
      key: "lapsed_gift_senders",
      name: "Lapsed gift senders",
      description: `Contacts whose last gift was sent more than ${lapsedDays} days ago (window editable).`,
      editableParams: [
        {
          path: "include.conditions[1].value",
          label: "Days since last gift sent",
          defaultValue: 180,
        },
      ],
      rules: {
        schemaVersion: RULE_SCHEMA_VERSION,
        include: {
          logic: "ALL",
          conditions: [
            { field: "gifts_sent_count", operator: "gte", value: 1 },
            { field: "last_gift_sent_at", operator: "more_than_days_ago", value: lapsedDays },
          ],
        groups: [
            {
              logic: "ANY",
              conditions: [
                { field: "email_reachable", operator: "is_true" },
                { field: "whatsapp_reachable", operator: "is_true" },
              ],
            },
          ],
        },
        exclude: {
          logic: "ALL",
          conditions: [{ field: "is_suppressed", operator: "is_true" }],
        },
      },
    },
    {
      key: "repeat_occasion_opportunity",
      name: "Repeat occasion opportunity",
      description:
        "Contacts with an inferred repeat date (orders in different years around the same calendar date) whose anniversary falls in the next 30 days. Dates are inferred, not confirmed.",
      editableParams: [
        {
          path: "include.conditions[1].value",
          label: "Upcoming window (days)",
          defaultValue: 30,
        },
      ],
      rules: {
        schemaVersion: RULE_SCHEMA_VERSION,
        include: {
          logic: "ALL",
          conditions: [
            { field: "has_inferred_repeat_date", operator: "is_true" },
            { field: "occasion_upcoming_days", operator: "within_next_days", value: 30 },
            // Repeat-occasion outreach only makes sense for people who
            // actually gift (comparable recipient/occasion relationship).
            { field: "has_gift_order", operator: "is_true" },
          ],
        groups: [
            {
              logic: "ANY",
              conditions: [
                { field: "email_reachable", operator: "is_true" },
                { field: "whatsapp_reachable", operator: "is_true" },
              ],
            },
          ],
        },
        exclude: {
          logic: "ALL",
          conditions: [{ field: "is_suppressed", operator: "is_true" }],
        },
      },
    },
  ];
}

/** Fixed rule trees behind the Audiences index summary metric cards. */
export const SUMMARY_RULES: Record<string, RuleTree> = {
  marketable_contacts: {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: {
      logic: "ANY",
      conditions: [
        { field: "email_reachable", operator: "is_true" },
        { field: "whatsapp_reachable", operator: "is_true" },
      ],
    },
    exclude: {
      logic: "ALL",
      conditions: [{ field: "is_suppressed", operator: "is_true" }],
    },
  },
  email_reachable: {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: {
      logic: "ALL",
      conditions: [{ field: "email_reachable", operator: "is_true" }],
    },
  },
  whatsapp_reachable: {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: {
      logic: "ALL",
      conditions: [{ field: "whatsapp_reachable", operator: "is_true" }],
    },
  },
  recipients_not_converted: {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: {
      logic: "ALL",
      conditions: [
        { field: "gifts_received_count", operator: "gte", value: 1 },
        { field: "orders_count", operator: "eq", value: 0 },
      ],
    },
  },
};
