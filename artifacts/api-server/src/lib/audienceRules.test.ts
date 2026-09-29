/**
 * Unit tests: audience rule validation, summary helper, condition→SQL
 * translation, and template shapes.
 */
import { describe, it, expect } from "vitest";
import {
  RULE_SCHEMA_VERSION,
  AUDIENCE_FIELDS,
  FIELDS_BY_KEY,
  validateRuleTree,
  summarizeRuleTree,
  groupIsEmpty,
  flattenConditions,
  type RuleTree,
} from "./audienceRules";
import { conditionSql, groupSql } from "./audienceEvaluate";
import { buildTemplates, SUMMARY_RULES } from "./audienceTemplates";

function tree(partial: Partial<RuleTree>): RuleTree {
  return {
    schemaVersion: RULE_SCHEMA_VERSION,
    include: { logic: "ALL", conditions: [{ field: "orders_count", operator: "gte", value: 1 }] },
    ...partial,
  } as RuleTree;
}

class FakeParams {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

describe("validateRuleTree", () => {
  it("accepts a valid ALL/ANY tree with exclusions", () => {
    const t = tree({
      include: {
        logic: "ALL",
        conditions: [
          { field: "contact_type", operator: "eq", value: "recipient" },
          { field: "total_spent", operator: "between", value: [10, 100] },
        ],
        groups: [
          {
            logic: "ANY",
            conditions: [
              { field: "tags", operator: "contains", value: "vip" },
              { field: "email_reachable", operator: "is_true" },
            ],
          },
        ],
      },
      exclude: {
        logic: "ALL",
        conditions: [{ field: "is_suppressed", operator: "is_true" }],
      },
    });
    expect(validateRuleTree(t)).toEqual([]);
  });

  it("rejects a wrong schema version with a path", () => {
    const errs = validateRuleTree({ ...tree({}), schemaVersion: 99 });
    expect(errs).toContainEqual(
      expect.objectContaining({ path: "schemaVersion" }),
    );
  });

  it("rejects unknown fields with per-node paths", () => {
    const errs = validateRuleTree(
      tree({
        include: {
          logic: "ALL",
          conditions: [
            { field: "orders_count", operator: "gte", value: 1 },
            { field: "nonsense_field", operator: "eq", value: "x" },
          ],
        },
      }),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe("include.conditions[1].field");
  });

  it("rejects operators not allowed for the field", () => {
    const errs = validateRuleTree(
      tree({
        include: {
          logic: "ALL",
          conditions: [{ field: "email_consent", operator: "gt", value: 1 }],
        },
      }),
    );
    expect(errs[0].path).toBe("include.conditions[0].operator");
  });

  it("rejects bad value shapes (type + between pair + enum member)", () => {
    const errs = validateRuleTree(
      tree({
        include: {
          logic: "ALL",
          conditions: [
            { field: "orders_count", operator: "eq", value: "three" },
            { field: "total_spent", operator: "between", value: [5] },
            { field: "contact_type", operator: "eq", value: "stranger" },
            { field: "email_consent", operator: "is_true", value: true },
          ],
        },
      }),
    );
    const paths = errs.map((e) => e.path);
    expect(paths).toContain("include.conditions[0].value");
    expect(paths).toContain("include.conditions[1].value");
    expect(paths).toContain("include.conditions[2].value");
    expect(paths).toContain("include.conditions[3].value"); // no-value op given a value
  });

  it("rejects nested group errors with full paths", () => {
    const errs = validateRuleTree(
      tree({
        include: {
          logic: "ALL",
          conditions: [{ field: "orders_count", operator: "gte", value: 1 }],
          groups: [
            {
              logic: "BAD" as never,
              conditions: [{ field: "city", operator: "eq", value: "" }],
            },
          ],
        },
      }),
    );
    const paths = errs.map((e) => e.path);
    expect(paths).toContain("include.groups[0].logic");
    expect(paths).toContain("include.groups[0].conditions[0].value");
  });

  it("rejects an empty include group and non-object trees", () => {
    expect(
      validateRuleTree(tree({ include: { logic: "ALL", conditions: [] } })),
    ).toContainEqual(expect.objectContaining({ path: "include" }));
    expect(validateRuleTree(null)).toHaveLength(1);
    expect(validateRuleTree("x")).toHaveLength(1);
  });

  it("every registry field validates with each of its declared operators", () => {
    for (const def of AUDIENCE_FIELDS) {
      for (const op of def.operators) {
        const value =
          op === "is_true" || op === "is_false" || op === "is_set" || op === "is_missing"
            ? undefined
            : op === "between"
              ? def.type === "date"
                ? ["2024-01-01", "2025-01-01"]
                : [1, 10]
              : op === "in" || op === "not_in"
                ? [def.enumValues?.[0] ?? "x"]
                : op === "within_last_days" || op === "more_than_days_ago" || op === "within_next_days"
                  ? 30
                  : def.type === "number"
                    ? 5
                    : def.type === "date"
                      ? "2024-06-01"
                      : (def.enumValues?.[0] ?? "x");
        const errs = validateRuleTree(
          tree({ include: { logic: "ALL", conditions: [{ field: def.key, operator: op, value }] } }),
        );
        expect(errs, `${def.key} ${op}`).toEqual([]);
      }
    }
  });
});

describe("summarizeRuleTree", () => {
  it("renders ALL/ANY and exclusions in plain language", () => {
    const t = tree({
      include: {
        logic: "ALL",
        conditions: [
          { field: "gifts_sent_count", operator: "gte", value: 1 },
          { field: "days_since_last_order", operator: "gt", value: 180 },
        ],
      },
      exclude: { logic: "ALL", conditions: [{ field: "is_suppressed", operator: "is_true" }] },
    });
    const s = summarizeRuleTree(t);
    expect(s).toContain("Gifts sent is at least 1");
    expect(s).toContain("AND");
    expect(s).toContain("excluding those where");
    expect(s).toContain("Globally unsubscribed / suppressed");
  });

  it("flags inferred fields", () => {
    const s = summarizeRuleTree(
      tree({
        include: {
          logic: "ALL",
          conditions: [{ field: "has_inferred_repeat_date", operator: "is_true" }],
        },
      }),
    );
    expect(s.toLowerCase()).toContain("inferred");
  });
});

describe("groupIsEmpty / flattenConditions", () => {
  it("treats nested empty groups as empty", () => {
    expect(groupIsEmpty({ logic: "ALL", conditions: [], groups: [{ logic: "ANY", conditions: [] }] })).toBe(true);
  });
  it("flattens nested conditions with stable paths", () => {
    const flat = flattenConditions(
      {
        logic: "ALL",
        conditions: [{ field: "orders_count", operator: "eq", value: 0 }],
        groups: [
          { logic: "ANY", conditions: [{ field: "tags", operator: "contains", value: "vip" }] },
        ],
      },
      "include",
    );
    expect(flat.map((f) => f.path)).toEqual([
      "include.conditions[0]",
      "include.groups[0].conditions[0]",
    ]);
  });
});

describe("conditionSql / groupSql", () => {
  it("parameterizes values (no inlined user input)", () => {
    const p = new FakeParams();
    const sql = conditionSql({ field: "city", operator: "eq", value: "Bei'rut" }, p as never);
    expect(sql).not.toContain("Bei'rut");
    expect(p.values).toEqual(["Bei'rut"]);
  });

  it("treats boolean false as NULL-safe (IS NOT TRUE)", () => {
    const p = new FakeParams();
    expect(conditionSql({ field: "email_consent", operator: "is_false" }, p as never)).toContain("IS NOT TRUE");
  });

  it("joins ALL with AND and ANY with OR, honoring nesting", () => {
    const p = new FakeParams();
    const sql = groupSql(
      {
        logic: "ALL",
        conditions: [{ field: "orders_count", operator: "gte", value: 1 }],
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
      p as never,
    );
    expect(sql).toContain(" AND ");
    expect(sql).toContain(" OR ");
  });

  it("every registry field/operator combination produces SQL", () => {
    for (const def of AUDIENCE_FIELDS) {
      for (const op of def.operators) {
        const value =
          op === "is_true" || op === "is_false" || op === "is_set" || op === "is_missing"
            ? undefined
            : op === "between"
              ? def.type === "date"
                ? ["2024-01-01", "2025-01-01"]
                : [1, 10]
              : op === "in" || op === "not_in"
                ? ["x"]
                : op === "within_last_days" || op === "more_than_days_ago" || op === "within_next_days"
                  ? 30
                  : def.type === "number"
                    ? 5
                    : def.type === "date"
                      ? "2024-06-01"
                      : "x";
        const p = new FakeParams();
        expect(
          () => conditionSql({ field: def.key, operator: op, value }, p as never),
          `${def.key} ${op}`,
        ).not.toThrow();
      }
    }
  });
});

describe("templates and summary rules", () => {
  it("all template rule trees validate and reference known fields", () => {
    for (const t of buildTemplates()) {
      expect(validateRuleTree(t.rules), t.key).toEqual([]);
    }
  });
  it("lapsed window is editable", () => {
    const t = buildTemplates(90).find((x) => x.key === "lapsed_gift_senders")!;
    expect(t.rules.include.conditions[1].value).toBe(90);
  });
  it("summary metric rule trees validate", () => {
    for (const [key, t] of Object.entries(SUMMARY_RULES)) {
      expect(validateRuleTree(t), key).toEqual([]);
    }
  });
  it("registry has no duplicate keys", () => {
    expect(FIELDS_BY_KEY.size).toBe(AUDIENCE_FIELDS.length);
  });
});
