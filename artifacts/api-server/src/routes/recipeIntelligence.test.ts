import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let workspaceOwnerId = "workspace_a";
let workspaceRole: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as WorkspaceRequest;
    wreq.workspaceOwnerId = workspaceOwnerId;
    wreq.workspaceRole = workspaceRole;
    wreq.workspaceActualRole = workspaceRole;
    wreq.allowedPages = allowedPages;
    wreq.userId = "user_123";
    next();
  },
  workspace: (req: express.Request) => req as WorkspaceRequest,
}));

import recipeIntelligenceRouter, { upsertCandidateRule } from "./recipeIntelligence";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(recipeIntelligenceRouter);
  return app;
}

const app = makeApp();

const productRows = [
  {
    product_id: 1,
    product_name: "Flower Box Deluxe",
    description: null,
    tags: [],
    main_image_url: "flower.jpg",
    recipe_count: 1,
    catalog_categories: ["Flowers"],
  },
  {
    product_id: 2,
    product_name: "Balloon Bundle",
    description: null,
    tags: [],
    main_image_url: null,
    recipe_count: 0,
    catalog_categories: ["Balloons"],
  },
];

const recipeRows = [
  {
    product_id: 1,
    product_name: "Flower Box Deluxe",
    base_item_id: 11,
    base_item_name: "Floral Sponge",
    base_item_code: "SPONGE",
    base_item_type: "packaging",
    base_item_status: "active",
    base_item_category_name: "Packaging",
    base_item_category_type: "packaging",
  },
  {
    product_id: 1,
    product_name: "Flower Box Deluxe",
    base_item_id: 12,
    base_item_name: "Flower Box",
    base_item_code: "BOX",
    base_item_type: "packaging",
    base_item_status: "active",
    base_item_category_name: "Packaging",
    base_item_category_type: "packaging",
  },
];

describe("recipe intelligence routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceOwnerId = "workspace_a";
    workspaceRole = "owner";
    allowedPages = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("rejects a member without products.manage before querying data", async () => {
    workspaceRole = "member";
    allowedPages = ["products"];

    const response = await request(app).get("/recipe-intelligence/audit");

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/manage products/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["/recipe-intelligence/rules/7/decision", { action: "edit", name: "Changed" }],
    ["/recipe-intelligence/rules/7/decision", { action: "approve" }],
    ["/recipe-intelligence/rules/7/decision", { action: "reject" }],
    ["/recipe-intelligence/rules/7/decision", { action: "deactivate" }],
    ["/recipe-intelligence/rules/7/decision", { action: "rollback" }],
    ["/recipe-intelligence/base-item-aliases/7/decision", { action: "edit", alias: "changed" }],
    ["/recipe-intelligence/base-item-aliases/7/decision", { action: "approve" }],
    ["/recipe-intelligence/base-item-aliases/7/decision", { action: "reject" }],
    ["/recipe-intelligence/base-item-aliases/7/decision", { action: "deactivate" }],
    ["/recipe-intelligence/base-item-metadata-candidates/7/decision", { action: "edit", proposed_value: "changed" }],
    ["/recipe-intelligence/base-item-metadata-candidates/7/decision", { action: "approve" }],
    ["/recipe-intelligence/base-item-metadata-candidates/7/decision", { action: "reject" }],
    ["/recipe-intelligence/base-item-metadata-candidates/7/decision", { action: "deactivate" }],
  ])("rejects unauthorized learning decision %s", async (path, body) => {
    workspaceRole = "member";
    allowedPages = ["products"];
    const response = await request(app).post(path).send(body);
    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns a deterministic, read-only recipe audit with conflict evidence", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: productRows, rowCount: productRows.length })
      .mockResolvedValueOnce({ rows: recipeRows, rowCount: recipeRows.length });

    const response = await request(app).get("/recipe-intelligence/audit");

    expect(response.status).toBe(200);
    expect(response.body.audit.coverage).toMatchObject({
      total_products: 2,
      products_with_recipe: 1,
      products_without_recipe: 1,
      completeness_percent: 50,
    });
    expect(response.body.audit.common_base_items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ base_item_id: 11, name: "Floral Sponge", product_count: 1 }),
      ]),
    );
    expect(response.body.audit.candidate_rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_key: "flower-box-sponge", source: "deterministic" }),
      ]),
    );
    expect(response.body.audit.conflicting_patterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_key: "balloon-metal-ring", product_id: 2 }),
      ]),
    );
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    for (const [statement, params] of mockDbQuery.mock.calls) {
      expect(String(statement)).toMatch(/^SELECT/i);
      expect(String(statement)).not.toMatch(/product_recipes\s+(?:SET|DELETE|INSERT|UPDATE)/i);
      expect(params).toEqual(["workspace_a"]);
    }
  });

  it("scopes rule details and its evidence to the selected workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 7,
          workspace_owner_id: "workspace_a",
          rule_key: "flower-box-sponge",
          name: "Flower-box products need sponge",
          status: "candidate",
          definition: {},
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: 4, evidence_type: "supporting" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 5, action: "seeded" }], rowCount: 1 });

    const response = await request(app).get("/recipe-intelligence/rules/7");

    expect(response.status).toBe(200);
    expect(response.body.rule.id).toBe(7);
    expect(response.body.evidence).toHaveLength(1);
    expect(response.body.actions).toHaveLength(1);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([7, "workspace_a"]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual([7, "workspace_a"]);
    expect(mockDbQuery.mock.calls[2][1]).toEqual([7, "workspace_a"]);
  });

  it("records an approval decision without touching a live recipe", async () => {
    const existingRule = {
      id: 7,
      workspace_owner_id: "workspace_a",
      rule_key: "flower-box-sponge",
      name: "Flower-box products need sponge",
      description: "Old description",
      rule_type: "hidden_item",
      source: "deterministic",
      status: "candidate",
      definition: {},
      confidence: "0.99",
      created_by_user_id: null,
      decided_by_user_id: null,
      decided_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingRule], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...existingRule, status: "approved" }], rowCount: 1 });

    const response = await request(app)
      .post("/recipe-intelligence/rules/7/decision")
      .send({ action: "approve", note: "Reviewed against current recipes" });

    expect(response.status).toBe(200);
    expect(response.body.rule.status).toBe("approved");
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/^WITH previous AS/i);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/UPDATE recipe_rules/i);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/FOR UPDATE/i);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/INSERT INTO recipe_rule_actions/i);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/to_jsonb\(previous\), to_jsonb\(updated\)/i);
    expect(mockDbQuery.mock.calls.flatMap(([, params]) => params ?? [])).not.toContain("product_recipes");
  });

  it("does not let an edit erase the conditions of a scoped candidate rule", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 7,
        workspace_owner_id: "workspace_a",
        status: "candidate",
        definition: { proposed_scope: "exact_phrase", phrase: "red rose", base_item_id: 12 },
      }],
      rowCount: 1,
    });
    const response = await request(app)
      .post("/recipe-intelligence/rules/7/decision")
      .send({ action: "edit", definition: {} });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/phrase condition/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("never rewrites an approved rule when a later audit rediscovers its pattern", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 23,
        workspace_owner_id: "workspace_a",
        rule_key: "discovered-packaging-12",
        name: "Manager-approved packaging rule",
        description: "Approved definition",
        rule_type: "hidden_item",
        source: "discovered",
        status: "approved",
        definition: { approved: true },
        confidence: "0.9",
        created_by_user_id: "user_123",
        decided_by_user_id: "user_123",
        decided_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
      rowCount: 1,
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // evidence is appended

    const result = await upsertCandidateRule("workspace_a", "user_123", {
      rule_key: "discovered-packaging-12",
      name: "Newly observed packaging rule",
      description: "New observation must not overwrite approval",
      rule_type: "hidden_item",
      source: "discovered",
      confidence: 0.6,
      definition: { approved: false },
      supporting_evidence: [{
        evidence_type: "supporting",
        product_id: 1,
        base_item_id: 12,
        product_name_snapshot: "Flower Box",
        base_item_name_snapshot: "Flower Box",
        details: {},
      }],
      conflicting_evidence: [],
    });

    expect(result).toEqual({ id: 23 });
    expect(mockDbQuery.mock.calls.map(([statement]) => String(statement))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^UPDATE recipe_rules/i)]),
    );
    expect(mockDbQuery.mock.calls.map(([statement]) => String(statement))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^INSERT INTO recipe_rule_actions/i)]),
    );
  });

  it("approves candidate Base Item metadata atomically and records its decision history", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        id: 31,
        workspace_owner_id: "workspace_a",
        base_item_id: 11,
        attribute_type: "stem_length_cm",
        proposed_value: 40,
        status: "approved",
      }],
      rowCount: 1,
    });

    const response = await request(app)
      .post("/recipe-intelligence/base-item-metadata-candidates/31/decision")
      .send({ action: "approve", note: "Verified against supplier specification" });

    expect(response.status).toBe(200);
    expect(response.body.candidate).toMatchObject({ id: 31, status: "approved" });
    expect(String(mockDbQuery.mock.calls[0][0])).toMatch(/^WITH previous AS/i);
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("base_item_metadata_candidate_decisions");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      31,
      "workspace_a",
      "approved",
      "user_123",
      "Verified against supplier specification",
      "approved",
    ]));
  });

  it("scopes metadata candidates to the selected workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 31, base_item_id: 11, status: "candidate" }],
      rowCount: 1,
    });

    const response = await request(app).get("/recipe-intelligence/base-item-metadata-candidates");

    expect(response.status).toBe(200);
    expect(response.body.candidates).toHaveLength(1);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["workspace_a"]);
  });

  it("governs candidate aliases with workspace-scoped append-only decisions", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 44, base_item_id: 11, status: "approved" }],
      rowCount: 1,
    });

    const response = await request(app)
      .post("/recipe-intelligence/base-item-aliases/44/decision")
      .send({ action: "approve", note: "Exact supplier phrase" });

    expect(response.status).toBe(200);
    expect(response.body.alias.status).toBe("approved");
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("base_item_alias_decisions");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      44,
      "workspace_a",
      "approved",
      "user_123",
      "Exact supplier phrase",
      "approved",
    ]));
  });

  it("corrects a candidate metadata proposal and appends before/after decision history", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 31, status: "candidate", proposed_value: 50, source_text: "supplier sheet" }],
      rowCount: 1,
    });

    const response = await request(app)
      .post("/recipe-intelligence/base-item-metadata-candidates/31/decision")
      .send({ action: "edit", proposed_value: 60, note: "Corrected supplier dimension" });

    expect(response.status).toBe(200);
    const [statement, params] = mockDbQuery.mock.calls[0];
    expect(String(statement)).toContain("base_item_metadata_candidate_decisions");
    expect(String(statement)).toContain("to_jsonb(previous), to_jsonb(updated)");
    expect(params).toEqual(expect.arrayContaining(["corrected", true, JSON.stringify(60)]));
  });

  it("corrects a candidate alias and appends before/after decision history", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 44, status: "candidate", alias: "old phrase" }],
      rowCount: 1,
    });

    const response = await request(app)
      .post("/recipe-intelligence/base-item-aliases/44/decision")
      .send({ action: "edit", alias: "Supplier Rose", note: "Corrected spelling" });

    expect(response.status).toBe(200);
    const [statement, params] = mockDbQuery.mock.calls[0];
    expect(String(statement)).toContain("base_item_alias_decisions");
    expect(String(statement)).toContain("to_jsonb(previous), to_jsonb(updated)");
    expect(params).toEqual(expect.arrayContaining(["corrected", true, "Supplier Rose", "supplier rose"]));
  });

  it("deactivates an approved contextual rule without deleting its history", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 9,
          workspace_owner_id: "workspace_a",
          rule_key: "red-rose-box",
          name: "Red rose box",
          status: "approved",
          definition: { specificity: 100, priority: 2 },
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 9, status: "inactive" }],
        rowCount: 1,
      });

    const response = await request(app)
      .post("/recipe-intelligence/rules/9/decision")
      .send({ action: "deactivate", note: "Conflicting evidence" });

    expect(response.status).toBe(200);
    expect(response.body.rule.status).toBe("inactive");
    expect(mockDbQuery.mock.calls[1][1]).toContain("deactivate");
    expect(mockDbQuery.mock.calls[1][1]).toContain("deactivated");
  });

  it("returns review queues from only the active workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ line_id: 1, resolution_status: "unresolved" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 2, correction_type: "change_quantity" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 3, candidate_kind: "rule", status: "candidate" }], rowCount: 1 });

    const response = await request(app).get("/recipe-intelligence/review-queue");

    expect(response.status).toBe(200);
    expect(response.body.attention_lines).toHaveLength(1);
    expect(response.body.submitted_corrections).toHaveLength(1);
    expect(response.body.learning_candidates).toHaveLength(1);
    for (const call of mockDbQuery.mock.calls) {
      expect(call[1]).toEqual(["workspace_a"]);
    }
  });
});