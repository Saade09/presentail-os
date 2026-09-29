import type {
  AudienceFieldDef,
  AudienceRuleCondition,
  AudienceRuleGroup,
  AudienceRuleTree,
} from "@workspace/api-client-react";

export const RULE_SCHEMA_VERSION = 1;

/** Operators that never take a value. */
export const VALUELESS_OPERATORS = new Set([
  "is_set",
  "is_missing",
  "is_true",
  "is_false",
]);

/** Operators whose value is a number of days (relative dates). */
export const RELATIVE_DAY_OPERATORS = new Set([
  "within_last_days",
  "more_than_days_ago",
  "within_next_days",
]);

/** Operators whose value is a list. */
export const LIST_OPERATORS = new Set(["in", "not_in"]);

/** Operators whose value is a two-element range. */
export const RANGE_OPERATORS = new Set(["between"]);

export const OPERATOR_LABELS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  not_in: "is none of",
  is_set: "is set",
  is_missing: "is missing",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  between: "is between",
  before: "is before",
  after: "is after",
  within_last_days: "within the last (days)",
  more_than_days_ago: "more than (days) ago",
  within_next_days: "within the next (days)",
  is_true: "is true",
  is_false: "is false",
  contains: "contains",
  not_contains: "does not contain",
};

export function operatorLabel(op: string): string {
  return OPERATOR_LABELS[op] ?? op.replace(/_/g, " ");
}

/** Currency-styled numeric fields (rendered with a $ prefix). */
export const CURRENCY_FIELDS = new Set(["total_spent", "aov"]);

export function newCondition(field?: AudienceFieldDef): AudienceRuleCondition {
  if (!field) return { field: "", operator: "" };
  const operator = field.operators[0] ?? "";
  return { field: field.key, operator, value: defaultValueFor(field, operator) };
}

export function defaultValueFor(
  field: AudienceFieldDef,
  operator: string,
): unknown {
  if (VALUELESS_OPERATORS.has(operator)) return undefined;
  if (RANGE_OPERATORS.has(operator)) return field.type === "date" ? ["", ""] : [0, 0];
  if (RELATIVE_DAY_OPERATORS.has(operator)) return 30;
  if (LIST_OPERATORS.has(operator)) return [];
  if (field.type === "number") return 0;
  if (field.type === "enum") return field.enumValues?.[0] ?? "";
  return "";
}

export function emptyGroup(logic: "ALL" | "ANY" = "ALL"): AudienceRuleGroup {
  return { logic, conditions: [], groups: [] };
}

/**
 * Transparent default exclusions: globally unsubscribed / suppressed
 * contacts and contacts with no valid destination at all.
 */
export function defaultExclusions(): AudienceRuleGroup {
  return {
    logic: "ANY",
    conditions: [{ field: "is_suppressed", operator: "is_true" }],
    groups: [
      {
        // Invalid destination: neither a valid email nor a valid phone.
        logic: "ALL",
        conditions: [
          { field: "valid_email", operator: "is_false" },
          { field: "valid_phone", operator: "is_false" },
        ],
      },
    ],
  };
}

export function emptyTree(): AudienceRuleTree {
  return {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: emptyGroup("ALL"),
    exclude: defaultExclusions(),
  };
}

// ── Immutable tree editing ────────────────────────────────────────────────
// Paths address a group as an array of child-group indexes rooted at the
// include (or exclude) group; conditions are addressed by index in a group.

export type GroupPath = number[];

function cloneGroup(g: AudienceRuleGroup): AudienceRuleGroup {
  return {
    logic: g.logic,
    conditions: g.conditions.map((c) => ({ ...c })),
    groups: (g.groups ?? []).map(cloneGroup),
  };
}

export function updateGroupAt(
  root: AudienceRuleGroup,
  path: GroupPath,
  fn: (g: AudienceRuleGroup) => void,
): AudienceRuleGroup {
  const next = cloneGroup(root);
  let target = next;
  for (const idx of path) {
    target = (target.groups ?? [])[idx];
    if (!target) return next;
  }
  fn(target);
  return next;
}

export function addCondition(
  root: AudienceRuleGroup,
  path: GroupPath,
  condition: AudienceRuleCondition,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => g.conditions.push(condition));
}

export function removeCondition(
  root: AudienceRuleGroup,
  path: GroupPath,
  index: number,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => g.conditions.splice(index, 1));
}

export function replaceCondition(
  root: AudienceRuleGroup,
  path: GroupPath,
  index: number,
  condition: AudienceRuleCondition,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => (g.conditions[index] = condition));
}

export function duplicateCondition(
  root: AudienceRuleGroup,
  path: GroupPath,
  index: number,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => {
    const src = g.conditions[index];
    if (src) g.conditions.splice(index + 1, 0, { ...src });
  });
}

export function moveCondition(
  root: AudienceRuleGroup,
  path: GroupPath,
  index: number,
  direction: -1 | 1,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => {
    const to = index + direction;
    if (to < 0 || to >= g.conditions.length) return;
    const [c] = g.conditions.splice(index, 1);
    g.conditions.splice(to, 0, c);
  });
}

export function setGroupLogic(
  root: AudienceRuleGroup,
  path: GroupPath,
  logic: "ALL" | "ANY",
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => (g.logic = logic));
}

export function addNestedGroup(
  root: AudienceRuleGroup,
  path: GroupPath,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => {
    g.groups = [...(g.groups ?? []), emptyGroup("ANY")];
  });
}

export function removeNestedGroup(
  root: AudienceRuleGroup,
  path: GroupPath,
  index: number,
): AudienceRuleGroup {
  return updateGroupAt(root, path, (g) => (g.groups ?? []).splice(index, 1));
}

export function groupIsEmpty(g: AudienceRuleGroup | undefined | null): boolean {
  if (!g) return true;
  return g.conditions.length === 0 && (g.groups ?? []).every(groupIsEmpty);
}

// ── Client-side validation ────────────────────────────────────────────────

export type RuleIssue = { path: string; message: string };

export function validateTree(
  tree: AudienceRuleTree,
  fields: AudienceFieldDef[],
): RuleIssue[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const issues: RuleIssue[] = [];
  const walk = (g: AudienceRuleGroup, path: string) => {
    g.conditions.forEach((c, i) => {
      const p = `${path}.conditions[${i}]`;
      if (!c.field) {
        issues.push({ path: p, message: "Choose a field." });
        return;
      }
      const def = byKey.get(c.field);
      if (!def) {
        issues.push({ path: p, message: `Unknown field "${c.field}".` });
        return;
      }
      if (!def.operators.includes(c.operator)) {
        issues.push({ path: p, message: `Choose a valid condition for ${def.label}.` });
        return;
      }
      if (VALUELESS_OPERATORS.has(c.operator)) return;
      if (RANGE_OPERATORS.has(c.operator)) {
        const v = c.value as unknown[];
        if (!Array.isArray(v) || v.length !== 2 || v.some((x) => x === "" || x == null)) {
          issues.push({ path: p, message: `Enter both range values for ${def.label}.` });
        }
        return;
      }
      if (LIST_OPERATORS.has(c.operator)) {
        if (!Array.isArray(c.value) || c.value.length === 0) {
          issues.push({ path: p, message: `Add at least one value for ${def.label}.` });
        }
        return;
      }
      if (RELATIVE_DAY_OPERATORS.has(c.operator)) {
        const n = Number(c.value);
        if (!Number.isFinite(n) || n <= 0) {
          issues.push({ path: p, message: `Enter a number of days for ${def.label}.` });
        }
        return;
      }
      if (c.value === "" || c.value == null) {
        issues.push({ path: p, message: `Enter a value for ${def.label}.` });
      }
    });
    (g.groups ?? []).forEach((child, i) => walk(child, `${path}.groups[${i}]`));
  };
  walk(tree.include, "include");
  if (tree.exclude) walk(tree.exclude, "exclude");
  if (groupIsEmpty(tree.include)) {
    issues.push({ path: "include", message: "Add at least one condition." });
  }
  return issues;
}

// ── Plain-language summary ────────────────────────────────────────────────

function valueText(field: AudienceFieldDef | undefined, c: AudienceRuleCondition): string {
  if (VALUELESS_OPERATORS.has(c.operator)) return "";
  if (RANGE_OPERATORS.has(c.operator) && Array.isArray(c.value)) {
    return ` ${String(c.value[0])} and ${String(c.value[1])}`;
  }
  if (RELATIVE_DAY_OPERATORS.has(c.operator)) {
    const n = Number(c.value);
    const label = OPERATOR_LABELS[c.operator] ?? c.operator;
    return ` ${label.replace("(days)", `${n} day${n === 1 ? "" : "s"}`)}`;
  }
  if (Array.isArray(c.value)) return ` ${c.value.map(String).join(", ")}`;
  const raw = String(c.value ?? "");
  if (field && CURRENCY_FIELDS.has(field.key) && raw !== "") return ` $${raw}`;
  return ` ${raw}`;
}

function conditionText(fields: Map<string, AudienceFieldDef>, c: AudienceRuleCondition): string {
  const def = fields.get(c.field);
  const label = def?.label ?? c.field;
  if (RELATIVE_DAY_OPERATORS.has(c.operator)) {
    return `${label}${valueText(def, c)}`.trim();
  }
  return `${label} ${operatorLabel(c.operator)}${valueText(def, c)}`.trim();
}

function groupText(fields: Map<string, AudienceFieldDef>, g: AudienceRuleGroup): string {
  const joiner = g.logic === "ALL" ? " and " : " or ";
  const parts = [
    ...g.conditions.map((c) => conditionText(fields, c)),
    ...(g.groups ?? [])
      .filter((child) => !groupIsEmpty(child))
      .map((child) => `(${groupText(fields, child)})`),
  ];
  return parts.join(joiner);
}

/** Live plain-language description of the rule tree. */
export function describeTree(
  tree: AudienceRuleTree,
  fields: AudienceFieldDef[],
): string {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  if (groupIsEmpty(tree.include)) return "No conditions yet — everyone would match.";
  let text = `Contacts where ${groupText(byKey, tree.include)}`;
  if (tree.exclude && !groupIsEmpty(tree.exclude)) {
    text += `, excluding those where ${groupText(byKey, tree.exclude)}`;
  }
  return text + ".";
}

// ── Prebuilt VIP rules (replaces the Contacts VIP tab) ───────────────────

export function vipRules(): AudienceRuleTree {
  return {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: {
      logic: "ALL",
      conditions: [{ field: "tags", operator: "contains", value: "vip" }],
      groups: [
        {
          logic: "ANY",
          conditions: [
            { field: "orders_count", operator: "gte", value: 1 },
            { field: "gifts_received_count", operator: "gte", value: 1 },
          ],
        },
      ],
    },
    exclude: {
      logic: "ALL",
      conditions: [{ field: "is_suppressed", operator: "is_true" }],
      groups: [],
    },
  };
}

// ── Stale-response guarding for live preview ─────────────────────────────

/**
 * Latest-wins tracker: `next()` issues a ticket for each request; a response
 * should only be applied when `isCurrent(ticket)` is still true.
 */
export function createRequestTracker() {
  let seq = 0;
  return {
    next(): number {
      return ++seq;
    },
    isCurrent(ticket: number): boolean {
      return ticket === seq;
    },
  };
}
