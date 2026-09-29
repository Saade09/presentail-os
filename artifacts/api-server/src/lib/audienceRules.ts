/**
 * Audience rule model — field-key/operator registry, rule-tree shape,
 * validator (per-node errors), and human-readable summary helper.
 *
 * A rule tree is:
 *   {
 *     schemaVersion: 1,
 *     include: Group,          // who is IN
 *     exclude?: Group          // separate exclusions group (matches removed)
 *   }
 * Group = { logic: "ALL" | "ANY", conditions: Condition[], groups?: Group[] }
 * Condition = { field: FieldKey, operator: Operator, value?: unknown }
 *
 * Field keys and operator names are stable API contracts — never rename.
 */

export const RULE_SCHEMA_VERSION = 1;

export type Operator =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after"
  | "within_last_days"
  | "more_than_days_ago"
  | "within_next_days"
  | "is_true"
  | "is_false"
  | "is_set"
  | "is_missing";

export type FieldType = "string" | "number" | "date" | "boolean" | "enum" | "tags";

export type FieldGroup =
  | "contact"
  | "purchasing"
  | "gifting"
  | "occasions"
  | "channels"
  | "data_quality";

export type FieldDef = {
  key: string;
  label: string;
  group: FieldGroup;
  type: FieldType;
  operators: Operator[];
  enumValues?: string[];
  /** True when the value is inferred (e.g. repeat-date heuristics) — the UI must flag it. */
  inferred?: boolean;
  description?: string;
};

const STRING_OPS: Operator[] = ["eq", "neq", "in", "not_in", "is_set", "is_missing"];
const NUMBER_OPS: Operator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "between"];
const DATE_OPS: Operator[] = [
  "before",
  "after",
  "between",
  "within_last_days",
  "more_than_days_ago",
  "is_set",
  "is_missing",
];
const BOOL_OPS: Operator[] = ["is_true", "is_false"];

/**
 * MVP field registry. The `key` maps 1:1 onto a column of the evaluation
 * base CTE in audienceEvaluate.ts. Engagement fields are intentionally
 * omitted — no engagement tracking exists yet.
 */
export const AUDIENCE_FIELDS: FieldDef[] = [
  // ── Contact ──────────────────────────────────────────────────────────
  {
    key: "contact_type",
    label: "Contact type",
    group: "contact",
    type: "enum",
    enumValues: ["customer", "recipient", "both"],
    operators: ["eq", "neq"],
    description:
      "customer = has placed at least one order; recipient = has received at least one; both = both roles.",
  },
  { key: "country", label: "Country", group: "contact", type: "string", operators: STRING_OPS },
  { key: "city", label: "City", group: "contact", type: "string", operators: STRING_OPS },
  { key: "language", label: "Preferred language", group: "contact", type: "string", operators: STRING_OPS },
  { key: "source", label: "Source", group: "contact", type: "string", operators: STRING_OPS },
  { key: "created_at", label: "Contact created", group: "contact", type: "date", operators: DATE_OPS },
  {
    key: "tags",
    label: "Tags",
    group: "contact",
    type: "tags",
    operators: ["contains", "not_contains", "in", "not_in"],
  },
  // ── Purchasing ───────────────────────────────────────────────────────
  { key: "orders_count", label: "Orders placed", group: "purchasing", type: "number", operators: NUMBER_OPS },
  { key: "gifts_sent_count", label: "Gifts sent", group: "purchasing", type: "number", operators: NUMBER_OPS },
  { key: "total_spent", label: "Total spent (USD)", group: "purchasing", type: "number", operators: NUMBER_OPS },
  { key: "aov", label: "Average order value (USD)", group: "purchasing", type: "number", operators: NUMBER_OPS },
  { key: "first_order_at", label: "First order date", group: "purchasing", type: "date", operators: DATE_OPS },
  { key: "last_order_at", label: "Last order date", group: "purchasing", type: "date", operators: DATE_OPS },
  {
    key: "days_since_last_order",
    label: "Days since last order",
    group: "purchasing",
    type: "number",
    operators: NUMBER_OPS,
  },
  { key: "is_repeat_customer", label: "Repeat customer (2+ orders)", group: "purchasing", type: "boolean", operators: BOOL_OPS },
  // ── Gifting ──────────────────────────────────────────────────────────
  { key: "gifts_received_count", label: "Gifts received", group: "gifting", type: "number", operators: NUMBER_OPS },
  {
    key: "unique_recipients_count",
    label: "Unique gift relationships",
    group: "gifting",
    type: "number",
    operators: NUMBER_OPS,
  },
  { key: "is_repeat_recipient", label: "Repeat recipient (2+ gifts received)", group: "gifting", type: "boolean", operators: BOOL_OPS },
  {
    key: "recipient_country",
    label: "Has sent a gift to country",
    group: "gifting",
    type: "string",
    operators: ["eq", "neq", "in", "not_in"],
  },
  { key: "last_gift_sent_at", label: "Last gift sent", group: "gifting", type: "date", operators: DATE_OPS },
  { key: "last_gift_received_at", label: "Last gift received", group: "gifting", type: "date", operators: DATE_OPS },
  {
    key: "has_self_order",
    label: "Has ordered for themselves",
    group: "gifting",
    type: "boolean",
    operators: BOOL_OPS,
    description: "An order where the same contact is both customer and recipient.",
  },
  { key: "has_gift_order", label: "Has sent a gift (order for someone else)", group: "gifting", type: "boolean", operators: BOOL_OPS },
  // ── Occasions ────────────────────────────────────────────────────────
  {
    key: "occasion_type",
    label: "Known occasion type",
    group: "occasions",
    type: "string",
    operators: ["eq", "in"],
    description: "Occasion slugs of products the contact has purchased (from the catalog occasions attribute).",
  },
  {
    key: "occasion_upcoming_days",
    label: "Order anniversary within next N days",
    group: "occasions",
    type: "number",
    operators: ["within_next_days"],
    inferred: true,
    description:
      "INFERRED: a prior order's month/day anniversary falls inside the next N days.",
  },
  {
    key: "occasion_prior_year_days",
    label: "Ordered around this time last year (± N days)",
    group: "occasions",
    type: "number",
    operators: ["within_next_days"],
    inferred: true,
    description: "INFERRED: placed an order within ±N days of one year ago.",
  },
  {
    key: "has_inferred_repeat_date",
    label: "Has an inferred repeat date",
    group: "occasions",
    type: "boolean",
    operators: BOOL_OPS,
    inferred: true,
    description:
      "INFERRED: gift orders to the SAME recipient in different years within ±7 days of the same calendar date. Self purchases and unrelated orders never qualify.",
  },
  // ── Channels & consent ───────────────────────────────────────────────
  { key: "email_consent", label: "Email consent", group: "channels", type: "boolean", operators: BOOL_OPS },
  { key: "whatsapp_consent", label: "WhatsApp consent", group: "channels", type: "boolean", operators: BOOL_OPS },
  { key: "is_suppressed", label: "Globally unsubscribed / suppressed", group: "channels", type: "boolean", operators: BOOL_OPS },
  {
    key: "email_reachable",
    label: "Email reachable",
    group: "channels",
    type: "boolean",
    operators: BOOL_OPS,
    description: "Has a VALID email AND email consent AND not suppressed.",
  },
  {
    key: "whatsapp_reachable",
    label: "WhatsApp reachable",
    group: "channels",
    type: "boolean",
    operators: BOOL_OPS,
    description: "Has a VALID phone (7+ digits) AND WhatsApp consent AND not suppressed.",
  },
  // ── Data quality ─────────────────────────────────────────────────────
  { key: "has_email", label: "Has email", group: "data_quality", type: "boolean", operators: BOOL_OPS },
  { key: "valid_email", label: "Has valid email", group: "data_quality", type: "boolean", operators: BOOL_OPS },
  { key: "has_phone", label: "Has phone", group: "data_quality", type: "boolean", operators: BOOL_OPS },
  { key: "valid_phone", label: "Has valid phone (7+ digits)", group: "data_quality", type: "boolean", operators: BOOL_OPS },
  { key: "respondio_synced", label: "Synced to respond.io", group: "data_quality", type: "boolean", operators: BOOL_OPS },
];

/**
 * Legacy field keys → current keys. Saved audience rules created before the
 * respond.io migration may still reference the old ManyChat field; initDb
 * rewrites stored rules, and this alias keeps any stragglers evaluable.
 */
export const LEGACY_FIELD_ALIASES: Record<string, string> = {
  manychat_synced: "respondio_synced",
};

/** Resolve a (possibly legacy) rule field key to its current field key. */
export function resolveFieldKey(key: string): string {
  return LEGACY_FIELD_ALIASES[key] ?? key;
}

export const FIELDS_BY_KEY: Map<string, FieldDef> = new Map(
  AUDIENCE_FIELDS.map((f) => [f.key, f]),
);

// ── Rule tree types ─────────────────────────────────────────────────────

export type RuleCondition = {
  field: string;
  operator: Operator;
  value?: unknown;
};

export type RuleGroup = {
  logic: "ALL" | "ANY";
  conditions: RuleCondition[];
  groups?: RuleGroup[];
};

export type RuleTree = {
  schemaVersion: number;
  include: RuleGroup;
  exclude?: RuleGroup | null;
};

export type RuleError = { path: string; message: string };

const MAX_DEPTH = 5;
const MAX_CONDITIONS = 100;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateValue(def: FieldDef, op: Operator, value: unknown, path: string, errors: RuleError[]): void {
  const noValueOps: Operator[] = ["is_true", "is_false", "is_set", "is_missing"];
  if (noValueOps.includes(op)) {
    if (value !== undefined && value !== null) {
      errors.push({ path, message: `operator "${op}" takes no value` });
    }
    return;
  }
  if (value === undefined || value === null) {
    errors.push({ path, message: `operator "${op}" requires a value` });
    return;
  }
  const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const isDateStr = (v: unknown) => typeof v === "string" && ISO_DATE_RE.test(v);
  const isStr = (v: unknown) => typeof v === "string" && v.trim() !== "";

  switch (op) {
    case "in":
    case "not_in": {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isStr)) {
        errors.push({ path, message: `operator "${op}" requires a non-empty array of strings` });
      } else if (def.type === "enum" && def.enumValues) {
        for (const v of value as string[]) {
          if (!def.enumValues.includes(v)) {
            errors.push({ path, message: `"${v}" is not a valid value for ${def.key}` });
          }
        }
      }
      return;
    }
    case "contains":
    case "not_contains": {
      if (!isStr(value)) errors.push({ path, message: `operator "${op}" requires a string value` });
      return;
    }
    case "between": {
      const ok =
        Array.isArray(value) &&
        value.length === 2 &&
        (def.type === "date" ? value.every(isDateStr) : value.every(isNumber));
      if (!ok) {
        errors.push({
          path,
          message: `operator "between" requires a [min, max] pair of ${def.type === "date" ? "ISO dates" : "numbers"}`,
        });
      }
      return;
    }
    case "before":
    case "after": {
      if (!isDateStr(value)) errors.push({ path, message: `operator "${op}" requires an ISO date string` });
      return;
    }
    case "within_last_days":
    case "more_than_days_ago":
    case "within_next_days": {
      if (!isNumber(value) || (value as number) < 0 || !Number.isInteger(value)) {
        errors.push({ path, message: `operator "${op}" requires a non-negative integer number of days` });
      }
      return;
    }
    default: {
      // eq/neq/gt/gte/lt/lte — typed by the field.
      if (def.type === "number") {
        if (!isNumber(value)) errors.push({ path, message: `field "${def.key}" requires a numeric value` });
      } else if (def.type === "date") {
        if (!isDateStr(value)) errors.push({ path, message: `field "${def.key}" requires an ISO date value` });
      } else if (def.type === "enum") {
        if (!isStr(value) || (def.enumValues && !def.enumValues.includes(value as string))) {
          errors.push({
            path,
            message: `"${String(value)}" is not a valid value for ${def.key} (expected one of ${def.enumValues?.join(", ")})`,
          });
        }
      } else {
        if (!isStr(value)) errors.push({ path, message: `field "${def.key}" requires a string value` });
      }
    }
  }
}

function validateGroup(
  group: unknown,
  path: string,
  depth: number,
  errors: RuleError[],
  counter: { n: number },
): void {
  if (!isPlainObject(group)) {
    errors.push({ path, message: "group must be an object" });
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push({ path, message: `groups nested deeper than ${MAX_DEPTH} levels` });
    return;
  }
  const logic = (group as { logic?: unknown }).logic;
  if (logic !== "ALL" && logic !== "ANY") {
    errors.push({ path: `${path}.logic`, message: `logic must be "ALL" or "ANY"` });
  }
  const conditions = (group as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) {
    errors.push({ path: `${path}.conditions`, message: "conditions must be an array" });
  } else {
    conditions.forEach((cond, i) => {
      const cpath = `${path}.conditions[${i}]`;
      counter.n += 1;
      if (counter.n > MAX_CONDITIONS) return;
      if (!isPlainObject(cond)) {
        errors.push({ path: cpath, message: "condition must be an object" });
        return;
      }
      const def = FIELDS_BY_KEY.get(resolveFieldKey(String((cond as { field?: unknown }).field ?? "")));
      if (!def) {
        errors.push({ path: `${cpath}.field`, message: `unknown field "${String((cond as { field?: unknown }).field)}"` });
        return;
      }
      const op = (cond as { operator?: unknown }).operator as Operator;
      if (!def.operators.includes(op)) {
        errors.push({
          path: `${cpath}.operator`,
          message: `operator "${String(op)}" is not valid for field "${def.key}" (allowed: ${def.operators.join(", ")})`,
        });
        return;
      }
      validateValue(def, op, (cond as { value?: unknown }).value, `${cpath}.value`, errors);
    });
  }
  const groups = (group as { groups?: unknown }).groups;
  if (groups !== undefined) {
    if (!Array.isArray(groups)) {
      errors.push({ path: `${path}.groups`, message: "groups must be an array" });
    } else {
      groups.forEach((g, i) => validateGroup(g, `${path}.groups[${i}]`, depth + 1, errors, counter));
    }
  }
}

/** Validate a rule tree; returns per-node errors (empty array = valid). */
export function validateRuleTree(tree: unknown): RuleError[] {
  const errors: RuleError[] = [];
  if (!isPlainObject(tree)) {
    return [{ path: "", message: "rules must be an object" }];
  }
  const sv = (tree as { schemaVersion?: unknown }).schemaVersion;
  if (sv !== RULE_SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      message: `unsupported schemaVersion ${String(sv)} (expected ${RULE_SCHEMA_VERSION})`,
    });
  }
  const counter = { n: 0 };
  if (!("include" in tree)) {
    errors.push({ path: "include", message: "include group is required" });
  } else {
    validateGroup((tree as { include?: unknown }).include, "include", 1, errors, counter);
  }
  const exclude = (tree as { exclude?: unknown }).exclude;
  if (exclude !== undefined && exclude !== null) {
    validateGroup(exclude, "exclude", 1, errors, counter);
  }
  if (counter.n > MAX_CONDITIONS) {
    errors.push({ path: "", message: `rule tree exceeds ${MAX_CONDITIONS} conditions` });
  }
  if (errors.length === 0 && groupIsEmpty((tree as unknown as RuleTree).include)) {
    errors.push({ path: "include", message: "include group must contain at least one condition" });
  }
  return errors;
}

export function groupIsEmpty(group: RuleGroup | null | undefined): boolean {
  if (!group) return true;
  if ((group.conditions ?? []).length > 0) return false;
  return (group.groups ?? []).every((g) => groupIsEmpty(g));
}

// ── Human-readable summary ──────────────────────────────────────────────

const OP_TEXT: Record<Operator, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  not_in: "is none of",
  contains: "contains",
  not_contains: "does not contain",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  between: "is between",
  before: "is before",
  after: "is after",
  within_last_days: "is within the last N days",
  more_than_days_ago: "is more than N days ago",
  within_next_days: "is within the next N days",
  is_true: "is true",
  is_false: "is false",
  is_set: "is set",
  is_missing: "is missing",
};

function conditionText(cond: RuleCondition): string {
  const def = FIELDS_BY_KEY.get(resolveFieldKey(cond.field));
  const label = def?.label ?? cond.field;
  const op = cond.operator;
  const inferredTag = def?.inferred ? " (inferred)" : "";
  switch (op) {
    case "is_true":
      return `${label}${inferredTag}`;
    case "is_false":
      return `not ${label}${inferredTag}`;
    case "is_set":
      return `${label} is set`;
    case "is_missing":
      return `${label} is missing`;
    case "within_last_days":
      return `${label} within the last ${String(cond.value)} days`;
    case "more_than_days_ago":
      return `${label} more than ${String(cond.value)} days ago`;
    case "within_next_days":
      return `${label.replace(/ N /, ` ${String(cond.value)} `)}${inferredTag}`;
    case "between": {
      const [a, b] = Array.isArray(cond.value) ? cond.value : ["?", "?"];
      return `${label} between ${String(a)} and ${String(b)}`;
    }
    case "in":
    case "not_in":
      return `${label} ${OP_TEXT[op]} ${(Array.isArray(cond.value) ? cond.value : []).join(", ")}`;
    default:
      return `${label} ${OP_TEXT[op]} ${String(cond.value)}${inferredTag}`;
  }
}

function groupText(group: RuleGroup): string {
  const parts: string[] = [];
  for (const c of group.conditions ?? []) parts.push(conditionText(c));
  for (const g of group.groups ?? []) {
    if (!groupIsEmpty(g)) parts.push(`(${groupText(g)})`);
  }
  const joiner = group.logic === "ANY" ? " OR " : " AND ";
  return parts.join(joiner);
}

/** Shared human-readable one-line summary of a rule tree. */
export function summarizeRuleTree(tree: RuleTree): string {
  let text = `Contacts where ${groupText(tree.include)}`;
  if (tree.exclude && !groupIsEmpty(tree.exclude)) {
    text += `, excluding those where ${groupText(tree.exclude)}`;
  }
  return text;
}

/** Flatten a group into an ordered list of conditions with their tree paths. */
export function flattenConditions(
  group: RuleGroup | null | undefined,
  basePath: string,
): { path: string; condition: RuleCondition }[] {
  if (!group) return [];
  const out: { path: string; condition: RuleCondition }[] = [];
  (group.conditions ?? []).forEach((c, i) => out.push({ path: `${basePath}.conditions[${i}]`, condition: c }));
  (group.groups ?? []).forEach((g, i) => out.push(...flattenConditions(g, `${basePath}.groups[${i}]`)));
  return out;
}
