import { describe, it, expect } from "vitest";
import type { AudienceFieldDef, AudienceRuleTree } from "@workspace/api-client-react";
import {
  addCondition,
  addNestedGroup,
  createRequestTracker,
  defaultExclusions,
  defaultValueFor,
  describeTree,
  duplicateCondition,
  emptyGroup,
  emptyTree,
  groupIsEmpty,
  moveCondition,
  newCondition,
  removeCondition,
  removeNestedGroup,
  replaceCondition,
  setGroupLogic,
  validateTree,
} from "./ruleUtils";

const FIELDS: AudienceFieldDef[] = [
  { key: "country", label: "Country", group: "contact", type: "string", operators: ["eq", "neq", "in", "not_in", "is_set", "is_missing"] },
  { key: "total_spent", label: "Total spent (USD)", group: "purchasing", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"] },
  { key: "last_order_at", label: "Last order date", group: "purchasing", type: "date", operators: ["before", "after", "between", "within_last_days", "more_than_days_ago", "is_set", "is_missing"] },
  { key: "is_suppressed", label: "Globally suppressed", group: "channels", type: "boolean", operators: ["is_true", "is_false"] },
  { key: "contact_type", label: "Contact type", group: "contact", type: "enum", enumValues: ["customer", "recipient", "both"], operators: ["eq", "neq"] },
  { key: "tags", label: "Tags", group: "contact", type: "tags", operators: ["contains", "not_contains", "in", "not_in"] },
];

function fld(key: string): AudienceFieldDef {
  return FIELDS.find((f) => f.key === key)!;
}

describe("ruleUtils — tree mutations", () => {
  it("adds, replaces, duplicates, moves, and removes conditions immutably", () => {
    const root = emptyGroup("ALL");
    let next = addCondition(root, [], newCondition(fld("country")));
    expect(root.conditions).toHaveLength(0);
    expect(next.conditions).toHaveLength(1);
    expect(next.conditions[0]).toMatchObject({ field: "country", operator: "eq" });

    next = addCondition(next, [], newCondition(fld("total_spent")));
    next = replaceCondition(next, [], 1, { field: "total_spent", operator: "gte", value: 500 });
    expect(next.conditions[1]).toMatchObject({ operator: "gte", value: 500 });

    next = duplicateCondition(next, [], 1);
    expect(next.conditions).toHaveLength(3);
    expect(next.conditions[2]).toEqual(next.conditions[1]);

    next = moveCondition(next, [], 2, -1);
    expect(next.conditions[1]).toMatchObject({ field: "total_spent" });

    next = removeCondition(next, [], 0);
    expect(next.conditions).toHaveLength(2);
    expect(next.conditions.every((c) => c.field === "total_spent")).toBe(true);
  });

  it("handles nested groups: add, edit inside, logic change, remove", () => {
    let root = emptyGroup("ALL");
    root = addNestedGroup(root, []);
    expect(root.groups).toHaveLength(1);
    expect(root.groups![0].logic).toBe("ANY");

    root = addCondition(root, [0], newCondition(fld("is_suppressed")));
    expect(root.groups![0].conditions).toHaveLength(1);

    root = setGroupLogic(root, [0], "ALL");
    expect(root.groups![0].logic).toBe("ALL");

    root = removeNestedGroup(root, [], 0);
    expect(root.groups).toHaveLength(0);
  });

  it("groupIsEmpty ignores empty nested groups", () => {
    let root = emptyGroup("ALL");
    expect(groupIsEmpty(root)).toBe(true);
    root = addNestedGroup(root, []);
    expect(groupIsEmpty(root)).toBe(true);
    root = addCondition(root, [0], newCondition(fld("country")));
    expect(groupIsEmpty(root)).toBe(false);
  });
});

describe("ruleUtils — defaults never produce invalid combos", () => {
  it("newCondition picks the field's first operator and a matching default value", () => {
    const c = newCondition(fld("contact_type"));
    expect(c.operator).toBe("eq");
    expect(c.value).toBe("customer");
  });

  it("defaultValueFor matches operator shape", () => {
    expect(defaultValueFor(fld("total_spent"), "between")).toEqual([0, 0]);
    expect(defaultValueFor(fld("last_order_at"), "between")).toEqual(["", ""]);
    expect(defaultValueFor(fld("last_order_at"), "within_last_days")).toBe(30);
    expect(defaultValueFor(fld("country"), "in")).toEqual([]);
    expect(defaultValueFor(fld("country"), "is_set")).toBeUndefined();
    expect(defaultValueFor(fld("is_suppressed"), "is_true")).toBeUndefined();
  });
});

describe("ruleUtils — validateTree", () => {
  const base = (): AudienceRuleTree => ({
    schemaVersion: 1,
    include: { logic: "ALL", conditions: [], groups: [] },
  });

  it("flags an empty include group", () => {
    const issues = validateTree(base(), FIELDS);
    expect(issues.some((i) => i.path === "include")).toBe(true);
  });

  it("accepts a valid tree, including default exclusions", () => {
    const tree = emptyTree();
    tree.include.conditions.push({ field: "country", operator: "eq", value: "Lebanon" });
    const fields: AudienceFieldDef[] = [
      ...FIELDS,
      { key: "valid_email", label: "Valid email", group: "data_quality", type: "boolean", operators: ["is_true", "is_false"] },
      { key: "valid_phone", label: "Valid phone", group: "data_quality", type: "boolean", operators: ["is_true", "is_false"] },
    ];
    expect(validateTree(tree, fields)).toEqual([]);
  });

  it("rejects an operator the field does not support", () => {
    const tree = base();
    tree.include.conditions.push({ field: "is_suppressed", operator: "gt", value: 1 });
    const issues = validateTree(tree, FIELDS);
    expect(issues.some((i) => i.message.includes("valid condition"))).toBe(true);
  });

  it("rejects missing values, empty lists, and incomplete ranges", () => {
    const tree = base();
    tree.include.conditions.push(
      { field: "country", operator: "eq", value: "" },
      { field: "country", operator: "in", value: [] },
      { field: "total_spent", operator: "between", value: [100] },
      { field: "last_order_at", operator: "within_last_days", value: 0 },
    );
    const issues = validateTree(tree, FIELDS);
    expect(issues).toHaveLength(4);
  });

  it("rejects unknown fields and empty field picks", () => {
    const tree = base();
    tree.include.conditions.push({ field: "", operator: "" }, { field: "nope", operator: "eq", value: "x" });
    const issues = validateTree(tree, FIELDS);
    expect(issues.some((i) => i.message === "Choose a field.")).toBe(true);
    expect(issues.some((i) => i.message.includes('Unknown field "nope"'))).toBe(true);
  });

  it("validates conditions inside nested groups and exclusions", () => {
    const tree = base();
    tree.include.conditions.push({ field: "country", operator: "eq", value: "AE" });
    tree.include.groups = [{ logic: "ANY", conditions: [{ field: "total_spent", operator: "gt", value: "" }] }];
    tree.exclude = { logic: "ALL", conditions: [{ field: "tags", operator: "contains", value: "" }], groups: [] };
    const issues = validateTree(tree, FIELDS);
    expect(issues.some((i) => i.path.startsWith("include.groups[0]"))).toBe(true);
    expect(issues.some((i) => i.path.startsWith("exclude"))).toBe(true);
  });
});

describe("ruleUtils — describeTree plain-language summary", () => {
  it("describes a mixed ALL/ANY tree with exclusions", () => {
    const tree: AudienceRuleTree = {
      schemaVersion: 1,
      include: {
        logic: "ALL",
        conditions: [
          { field: "total_spent", operator: "gte", value: 500 },
          { field: "last_order_at", operator: "more_than_days_ago", value: 180 },
        ],
        groups: [
          {
            logic: "ANY",
            conditions: [
              { field: "country", operator: "eq", value: "Lebanon" },
              { field: "country", operator: "eq", value: "UAE" },
            ],
          },
        ],
      },
      exclude: { logic: "ALL", conditions: [{ field: "is_suppressed", operator: "is_true" }], groups: [] },
    };
    const text = describeTree(tree, FIELDS);
    expect(text).toContain("Total spent (USD) is at least $500");
    expect(text).toContain("Last order date more than 180 days ago");
    expect(text).toContain("(Country is Lebanon or Country is UAE)");
    expect(text).toContain("excluding those where Globally suppressed is true");
  });

  it("explains an empty tree", () => {
    expect(describeTree({ schemaVersion: 1, include: emptyGroup("ALL") }, FIELDS)).toContain(
      "No conditions yet",
    );
  });

  it("pluralizes relative days correctly", () => {
    const tree: AudienceRuleTree = {
      schemaVersion: 1,
      include: {
        logic: "ALL",
        conditions: [{ field: "last_order_at", operator: "within_last_days", value: 1 }],
        groups: [],
      },
    };
    expect(describeTree(tree, FIELDS)).toContain("within the last 1 day");
  });
});

describe("ruleUtils — defaultExclusions", () => {
  it("covers suppression and invalid destinations", () => {
    const ex = defaultExclusions();
    expect(ex.logic).toBe("ANY");
    expect(ex.conditions).toEqual([{ field: "is_suppressed", operator: "is_true" }]);
    expect(ex.groups![0].conditions.map((c) => c.field)).toEqual(["valid_email", "valid_phone"]);
  });
});

describe("ruleUtils — createRequestTracker (stale preview responses)", () => {
  it("only the most recent ticket is current", () => {
    const tracker = createRequestTracker();
    const t1 = tracker.next();
    const t2 = tracker.next();
    expect(tracker.isCurrent(t1)).toBe(false);
    expect(tracker.isCurrent(t2)).toBe(true);
    const t3 = tracker.next();
    expect(tracker.isCurrent(t2)).toBe(false);
    expect(tracker.isCurrent(t3)).toBe(true);
  });

  it("discards out-of-order resolutions (latest wins)", async () => {
    const tracker = createRequestTracker();
    const applied: number[] = [];
    async function fakeRequest(id: number, delay: number) {
      const ticket = tracker.next();
      await new Promise((r) => setTimeout(r, delay));
      if (tracker.isCurrent(ticket)) applied.push(id);
    }
    // First request is slower than the second — its response must be discarded.
    await Promise.all([fakeRequest(1, 30), fakeRequest(2, 5)]);
    expect(applied).toEqual([2]);
  });
});
