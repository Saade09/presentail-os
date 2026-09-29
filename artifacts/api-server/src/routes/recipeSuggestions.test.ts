import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockRelease,
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

let role: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as WorkspaceRequest;
    wreq.workspaceOwnerId = "workspace_recipe";
    wreq.workspaceRole = role;
    wreq.workspaceActualRole = role;
    wreq.allowedPages = allowedPages;
    wreq.userId = "reviewer_1";
    next();
  },
  workspace: (req: express.Request) => req as WorkspaceRequest,
}));

import { generateRecipeSuggestion } from "../lib/recipeSuggestionEngine";
import recipeSuggestionsRouter, { toDraftLines, validateBoundedAiChoice, type BaseItemRow } from "./recipeSuggestions";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(recipeSuggestionsRouter);
  return instance;
}

function sql(value: unknown): string {
  return String(value);
}

async function persistReviewerAddedLine(options: {
  suggestionId: number;
  phrase: string;
  quantity: number;
  unit: string;
  item: {
    id: number;
    name: string;
    code: string;
    approved_metadata?: Record<string, unknown>;
  };
  correctedStructuredRequirement?: Record<string, unknown>;
}) {
  mockClientQuery.mockImplementation((statement: unknown, values?: unknown[]) => {
    const query = sql(statement);
    if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [{
      id: options.suggestionId, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
      status: "generated", generation_context: { structured_requirements: [] }, confidence: "0",
      rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
    }], rowCount: 1 });
    if (query.includes("FROM base_items bi")) return Promise.resolve({ rows: [{
      ...options.item, canonical_unit: options.unit, package_name: null, package_quantity: null,
      approved_metadata: options.item.approved_metadata ?? {}, candidate_metadata: [], approved_aliases: [],
    }], rowCount: 1 });
    if (query.includes("SELECT COALESCE(MAX(line_order)")) return Promise.resolve({ rows: [{ line_order: 3 }], rowCount: 1 });
    if (query.includes("INSERT INTO recipe_suggestion_lines")) return Promise.resolve({ rows: [{
      id: options.suggestionId * 10, line_order: values?.[2], proposed_base_item_id: values?.[3],
      proposed_base_item_name: values?.[4], proposed_base_item_code: values?.[5],
      extracted_requirement: values?.[6], unit_context: values?.[7],
      source_evidence: JSON.parse(String(values?.[8])), match_confidence: values?.[9],
      quantity: values?.[10], confidence: values?.[11], source_type: "reviewer_correction",
      source_rule_id: null, rationale: values?.[12], resolution_status: values?.[13],
      exclusion_reason: null, exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
    }], rowCount: 1 });
    if (query.includes("INSERT INTO recipe_suggestion_corrections")) return Promise.resolve({ rows: [{ id: options.suggestionId * 10 + 1 }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
  const response = await request(app()).post(`/recipe-suggestions/${options.suggestionId}/corrections`).send({
    correction_type: "add_line", extraction_error_type: "extraction", reason: "omitted_extraction",
    base_item_id: options.item.id, extracted_requirement: options.phrase,
    quantity: options.quantity, unit_context: options.unit,
    corrected_structured_requirement: options.correctedStructuredRequirement,
  });
  const insert = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("INSERT INTO recipe_suggestion_lines"));
  const evidence = JSON.parse(String(insert?.[1]?.[8])) as Array<Record<string, unknown>>;
  return { response, insert, evidence: evidence[0] };
}

describe("safe recipe suggestion workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "owner";
    allowedPages = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("keeps bounded AI scoped to one requirement and preserves its quantity", () => {
    const requirement = {
      requirementId: "req_balloon_1",
      requirement: "4 Foil Balloons (ambiguous Base Item variant; review required)",
      quantity: 4,
      reason: "Multiple candidates.",
      candidateBaseItemIds: [41, 42],
    };
    const items: BaseItemRow[] = [41, 42, 99].map((id) => ({
      id,
      name: id === 99 ? "Unrelated Cake" : `Foil Balloon ${id}`,
      code: `ITEM-${id}`,
      canonical_unit: "unit",
      package_name: null,
      package_quantity: null,
      approved_metadata: null,
      candidate_metadata: null,
      approved_aliases: null,
    }));

    expect(validateBoundedAiChoice(requirement, items, {
      requirement_id: requirement.requirementId,
      choice: { base_item_id: 42, quantity: 999, confidence: 0.9, rationale: "Best supported candidate." },
    })).toMatchObject({
      baseItemId: 42,
      quantity: 4,
      requirementId: requirement.requirementId,
    });
    expect(validateBoundedAiChoice(requirement, items, {
      requirement_id: "req_unrelated",
      choice: { base_item_id: 42, confidence: 0.9, rationale: "Wrong requirement." },
    })).toBeNull();
    expect(validateBoundedAiChoice(requirement, items, {
      requirement_id: requirement.requirementId,
      choice: { base_item_id: 99, confidence: 0.9, rationale: "Unrelated item." },
    })).toBeNull();
  });

  it("does not let bounded AI promote a survivor with unknown explicit evidence", () => {
    const requirement = {
      requirementId: "req_red_rose",
      requirement: "5 Red Roses",
      quantity: 5,
      reason: "Unknown color.",
      candidateBaseItemIds: [41],
      requirementProvenance: {
        requirementId: "req_red_rose",
        kind: "ingredient" as const,
        subtype: "botanical",
        phrase: "Red Roses",
        quantity: 5,
        unit: null,
        category: "flowers_greenery",
        attributes: { color: "red" },
        candidateBaseItemIds: [41],
        resolution: "ambiguous" as const,
        evidence: {
          sourceField: "name" as const, sourceIndex: 0, lineIndex: 0, componentIndex: 0,
          occurrence: 1, exactPhrase: "Red Roses", normalizedPhrase: "red roses", span: { start: 0, end: 9 },
        },
        similarEvidence: [],
        candidateCompatibility: [{
          baseItemId: 41,
          attributes: {},
          comparisons: {
            color: { state: "unknown" as const, required: "red", candidate: [], sources: [] },
          },
          hardExclusions: [],
          hasUnknownExplicitDiscriminator: true,
          survivor: true,
        }],
      },
    };
    const item: BaseItemRow = {
      id: 41, name: "Rose", code: null, canonical_unit: "stem",
      package_name: null, package_quantity: null, approved_metadata: null,
      candidate_metadata: null, approved_aliases: null,
    };
    expect(validateBoundedAiChoice(requirement, [item], {
      requirement_id: requirement.requirementId,
      choice: { base_item_id: 41, confidence: 0.99, rationale: "Only candidate." },
    })).toBeNull();
  });

  it("persists only similar Products that actually support the selected Base Item", () => {
    const generated = generateRecipeSuggestion(
      {
        id: 800,
        name: "12 Red Roses Bouquet",
        description: null,
        category: "Flowers",
        tags: [],
      },
      [
        {
          id: 801,
          name: "12 Red Roses Bouquet",
          description: null,
          category: "Flowers",
          tags: [],
          recipes: [{ baseItemId: 1, baseItemName: "Red Roses", quantity: 12 }],
        },
        {
          id: 802,
          name: "12 Red Roses Bouquet",
          description: null,
          category: "Flowers",
          tags: [],
          recipes: [{ baseItemId: 99, baseItemName: "Unrelated Chocolate", quantity: 1 }],
        },
      ],
      [{ baseItemId: 1, baseItemName: "Red Roses", quantity: 1 }],
    );
    const item: BaseItemRow = {
      id: 1,
      name: "Red Roses",
      code: "ROSE-RED",
      canonical_unit: "stem",
      package_name: null,
      package_quantity: null,
      approved_metadata: null,
      candidate_metadata: null,
      approved_aliases: null,
    };
    const draft = toDraftLines(generated, [item], [], []);
    expect(draft[0].evidence).toEqual([
      expect.objectContaining({ supporting_product_ids: [801] }),
    ]);
  });

  it("enforces product management permission before exposing generation data", async () => {
    role = "member";
    allowedPages = ["products"];

    const response = await request(app()).post("/products/7/recipe-suggestions").send({});

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("disables positional bulk edits without touching the database", async () => {
    const response = await request(app()).patch("/recipe-suggestions/7").send({
      items: [{ base_item_id: 11, quantity: 1 }],
    });
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("LINE_LEVEL_CORRECTIONS_REQUIRED");
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns a distinct active-product attention count with queue data", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [
        {
          product_id: 7,
          missing_recipe: true,
          suggestion_id: 70,
          version: 2,
          confidence: "0.91",
          created_at: "2026-08-24T10:00:00.000Z",
        },
        {
          product_id: 8,
          missing_recipe: false,
          suggestion_id: 80,
          version: 1,
          confidence: null,
          created_at: "2026-08-24T11:00:00.000Z",
        },
      ],
      rowCount: 2,
    });

    const response = await request(app()).get("/products/recipe-review-summary");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      attention_count: 2,
      products_without_recipe: [7],
      products_with_pending_suggestion: [
        {
          product_id: 7,
          suggestion_id: 70,
          version: 2,
          confidence: 0.91,
          created_at: "2026-08-24T10:00:00.000Z",
        },
        {
          product_id: 8,
          suggestion_id: 80,
          version: 1,
          confidence: null,
          created_at: "2026-08-24T11:00:00.000Z",
        },
      ],
    });
    expect(sql(mockDbQuery.mock.calls[0][0])).toContain("COALESCE(p.is_archived, false) = false");
    expect(sql(mockDbQuery.mock.calls[0][0])).toContain("rs.status IN ('draft', 'generated', 'under_review')");
  });

  it("returns an empty confirmed queue when no active product needs attention", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const response = await request(app()).get("/products/recipe-review-summary");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      attention_count: 0,
      products_without_recipe: [],
      products_with_pending_suggestion: [],
    });
  });

  it("does not expose the review summary to members without product management", async () => {
    role = "member";
    allowedPages = ["products"];

    const response = await request(app()).get("/products/recipe-review-summary");

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("saves a reviewable draft without inserting or changing the live recipe", async () => {
    mockDbQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM products p")) {
        return Promise.resolve({
          rows: [{
            id: 7,
            name: "Medium Round Flower Box with 12 Red Roses",
            description: "Gift flowers",
            main_image_url: "https://example.test/flower.jpg",
            additional_image_urls: [],
            tags: ["flowers"],
            category: "Flowers",
            catalog_categories: [{ name: "Flowers" }],
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({
          rows: [
            { id: 11, name: "Red Roses", code: "ROSE-RED", canonical_unit: "stem", package_name: "Bunch", package_quantity: 20 },
            { id: 12, name: "Medium Round Flower Box", code: "BOX-M", canonical_unit: "unit", package_name: "Single", package_quantity: 1 },
            { id: 13, name: "Floral Sponge", code: "SPONGE", canonical_unit: "unit", package_name: "Single", package_quantity: 1 },
          ],
          rowCount: 3,
        });
      }
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 91, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
            status: "generated", generation_context: {}, confidence: "0.9", rationale: "draft",
            created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines")) return Promise.resolve({ rows: [], rowCount: 0 });
      if (query.includes("FROM recipe_suggestion_actions")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("COALESCE(MAX(version)")) return Promise.resolve({ rows: [{ version: 1 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestions")) return Promise.resolve({ rows: [{ id: 91 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app()).post("/products/7/recipe-suggestions").send({});

    expect(response.status).toBe(201);
    expect(response.body.live_recipe_changed).toBe(false);
    const writeQueries = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(writeQueries).toContainEqual(expect.stringContaining("INSERT INTO recipe_suggestions"));
    expect(writeQueries).toContainEqual(expect.stringContaining("INSERT INTO recipe_suggestion_lines"));
    expect(writeQueries.some((query) => query.includes("INSERT INTO product_recipes"))).toBe(false);
    expect(writeQueries.some((query) => query.includes("DELETE FROM product_recipes"))).toBe(false);
    const suggestionInsert = mockClientQuery.mock.calls.find(([statement]) =>
      sql(statement).includes("INSERT INTO recipe_suggestions"),
    );
    expect(JSON.parse(String(suggestionInsert?.[1]?.[3]))).toMatchObject({
      configuration_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      case_input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(String(suggestionInsert?.[1]?.[4]))).toMatchObject({
      deterministic_matcher: {
        configuration_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        case_input_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("persists the quantity from the most specific compatible ingredient match", async () => {
    mockDbQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM products p")) {
        return Promise.resolve({
          rows: [{
            id: 17,
            name: "25 pieces of Orange Roses Arrangement",
            description: null,
            main_image_url: null,
            additional_image_urls: [],
            tags: [],
            category: "Flowers",
            catalog_categories: [{ name: "Flowers" }],
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({
          rows: [
            { id: 21, name: "Orange", code: "COLOR-ORANGE", canonical_unit: "unit", package_name: null, package_quantity: null },
            { id: 22, name: "Orange Rose", code: "ROSE-ORANGE", canonical_unit: "stem", package_name: "Bunch", package_quantity: 20 },
            { id: 23, name: "Orange Ranunculus", code: "RAN-ORANGE", canonical_unit: "stem", package_name: null, package_quantity: null },
            { id: 24, name: "Dried Orange Ruscus", code: "RUSCUS-DRIED", canonical_unit: "stem", package_name: null, package_quantity: null },
          ],
          rowCount: 4,
        });
      }
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 191, workspace_owner_id: "workspace_recipe", product_id: 17, version: 1,
            status: "generated", generation_context: {}, confidence: "0.95", rationale: "draft",
            created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines")) return Promise.resolve({ rows: [], rowCount: 0 });
      if (query.includes("FROM recipe_suggestion_actions")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("COALESCE(MAX(version)")) return Promise.resolve({ rows: [{ version: 1 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestions")) return Promise.resolve({ rows: [{ id: 191 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app()).post("/products/17/recipe-suggestions").send({});

    expect(response.status).toBe(201);
    expect(response.body.live_recipe_changed).toBe(false);
    const lineInserts = mockClientQuery.mock.calls.filter(([statement]) =>
      sql(statement).includes("INSERT INTO recipe_suggestion_lines"),
    );
    expect(lineInserts).toHaveLength(1);
    expect(lineInserts[0][1]).toEqual(expect.arrayContaining([
      22,
      "Orange Rose",
      "ROSE-ORANGE",
      25,
      "high",
      "deterministic_rule",
    ]));
    expect(lineInserts[0][1]).not.toContain(21);
  });

  it("persists ambiguous size variants as an unresolved quantity instead of a high-confidence item", async () => {
    const originalBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const originalApiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "";
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "";
    mockDbQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM products p")) {
        return Promise.resolve({
          rows: [{
            id: 18,
            name: "25 Orange Roses Arrangement",
            description: null,
            main_image_url: null,
            additional_image_urls: [],
            tags: [],
            category: "Flowers",
            catalog_categories: [{ name: "Flowers" }],
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({
          rows: [
            { id: 31, name: "Orange", code: "COLOR-ORANGE", canonical_unit: "unit", package_name: null, package_quantity: null },
            { id: 32, name: "Orange Rose 40cm", code: "ROSE-ORANGE-40", canonical_unit: "stem", package_name: null, package_quantity: null },
            { id: 33, name: "Orange Rose 60cm", code: "ROSE-ORANGE-60", canonical_unit: "stem", package_name: null, package_quantity: null },
          ],
          rowCount: 3,
        });
      }
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 192, workspace_owner_id: "workspace_recipe", product_id: 18, version: 1,
            status: "generated", generation_context: {}, confidence: "0", rationale: "draft",
            created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines")) return Promise.resolve({ rows: [], rowCount: 0 });
      if (query.includes("FROM recipe_suggestion_actions")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("COALESCE(MAX(version)")) return Promise.resolve({ rows: [{ version: 1 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestions")) return Promise.resolve({ rows: [{ id: 192 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    try {
      const response = await request(app()).post("/products/18/recipe-suggestions").send({});

      expect(response.status).toBe(201);
      expect(response.body.live_recipe_changed).toBe(false);
      const lineInsert = mockClientQuery.mock.calls.find(([statement]) =>
        sql(statement).includes("INSERT INTO recipe_suggestion_lines"),
      );
      expect(lineInsert?.[1]).toEqual(expect.arrayContaining([
        null,
        25,
        "no_match",
        "unresolved",
      ]));
      expect(lineInsert?.[1]?.[6]).toContain("ambiguous Base Item variant");
      expect(lineInsert?.[1]).not.toContain(31);
      expect(lineInsert?.[1]).not.toContain(32);
      expect(lineInsert?.[1]).not.toContain(33);
    } finally {
      if (originalBaseUrl === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
      else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = originalBaseUrl;
      if (originalApiKey === undefined) delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
      else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = originalApiKey;
    }
  });

  it("refuses to approve a draft that still has an unresolved no-match line", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 77, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
            status: "generated", generation_context: { suggested_lines: [], live_recipe_version: 0 }, confidence: "0",
            rationale: "draft", created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 1, line_order: 0, proposed_base_item_id: null, proposed_base_item_name: null,
            proposed_base_item_code: null, extracted_requirement: "Unknown packaging",
            unit_context: null, source_evidence: [], match_confidence: "no_match", quantity: "1",
            confidence: "0", source_type: "unresolved", source_rule_id: null,
            rationale: "Review needed", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("SELECT recipe_version FROM products")) {
        return Promise.resolve({ rows: [{ recipe_version: 0 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app())
      .post("/recipe-suggestions/77/approve")
      .send({ expected_live_recipe_version: 0 });

    expect(response.status).toBe(422);
    const writes = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(writes.some((query) => query.includes("DELETE FROM product_recipes"))).toBe(false);
    expect(writes.some((query) => query.includes("INSERT INTO product_recipes"))).toBe(false);
  });

  it("combines reviewer-approved duplicate Base Items and records the approval audit", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 78, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
            status: "under_review", generation_context: {
              suggested_lines: [{ baseItemId: 11, quantity: 1 }],
              live_recipe_version: 0,
            },
            confidence: "0.8", rationale: "draft", created_by_user_id: "reviewer_1",
            created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [
            {
              id: 1, line_order: 0, proposed_base_item_id: 11, proposed_base_item_name: "Red Roses",
              proposed_base_item_code: "ROSE", extracted_requirement: "Roses", unit_context: "stem",
              source_evidence: [{ requirement_id: "r1", requirement_provenance: { requirementId: "r1", kind: "ingredient", phrase: "Roses", quantity: 1, unit: "stem", attributes: {}, candidateBaseItemIds: [11], resolution: "matched", evidence: { sourceField: "name", sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0, exactPhrase: "Roses", normalizedPhrase: "roses", span: { start: 0, end: 5 } }, similarEvidence: [] } }], match_confidence: "high", quantity: "1", confidence: "0.95",
              source_type: "reviewer_edit", source_rule_id: null, rationale: "First line",
              resolution_status: "resolved", exclusion_reason: null, exclusion_acknowledged: false,
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              id: 2, line_order: 1, proposed_base_item_id: 11, proposed_base_item_name: "Red Roses",
              proposed_base_item_code: "ROSE", extracted_requirement: "More roses", unit_context: "stem",
              source_evidence: [{ requirement_id: "r2", requirement_provenance: { requirementId: "r2", kind: "ingredient", phrase: "More roses", quantity: 2, unit: "stem", attributes: {}, candidateBaseItemIds: [11], resolution: "matched", evidence: { sourceField: "name", sourceIndex: 0, lineIndex: 1, componentIndex: 0, occurrence: 0, exactPhrase: "More roses", normalizedPhrase: "more roses", span: { start: 0, end: 10 } }, similarEvidence: [] } }], match_confidence: "high", quantity: "2", confidence: "0.95",
              source_type: "reviewer_edit", source_rule_id: null, rationale: "Second line",
              resolution_status: "resolved", exclusion_reason: null, exclusion_acknowledged: false,
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
          rowCount: 2,
        });
      }
      if (query.includes("FROM base_items bi") && query.includes("approved_metadata")) return Promise.resolve({ rows: [{ id: 11, name: "Red Roses", code: "ROSE", canonical_unit: "stem", package_name: null, package_quantity: null, approved_metadata: {}, approved_aliases: [] }], rowCount: 1 });
      if (query.includes("SELECT id FROM base_items")) return Promise.resolve({ rows: [{ id: 11 }], rowCount: 1 });
      if (query.includes("SELECT recipe_version FROM products")) {
        return Promise.resolve({ rows: [{ recipe_version: 0 }], rowCount: 1 });
      }
      if (query.includes("UPDATE products SET recipe_version")) {
        return Promise.resolve({ rows: [{ recipe_version: 1 }], rowCount: 1 });
      }
      if (query.includes("FROM product_recipes")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app())
      .post("/recipe-suggestions/78/approve")
      .send({ note: "Reviewed", expected_live_recipe_version: 0 });

    expect(response.status).toBe(200);
    expect(response.body.live_recipe_changed).toBe(true);
    const recipeInsert = mockClientQuery.mock.calls.find(([statement]) =>
      sql(statement).includes("INSERT INTO product_recipes"),
    );
    expect(recipeInsert?.[1]).toEqual(["workspace_recipe", 7, 11, 3, 0]);
    const actionInsert = mockClientQuery.mock.calls.find(([statement]) =>
      sql(statement).includes("INSERT INTO recipe_suggestion_actions"),
    );
    expect(actionInsert?.[1]?.[4]).toContain("difference_from_suggestion");
  });

  it("retains a rejected draft and its actor audit instead of touching the live recipe", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      if (sql(statement).includes("UPDATE recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 79, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
            status: "rejected", generation_context: { suggested_lines: [] }, confidence: "0",
            rationale: "draft", created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app()).post("/recipe-suggestions/79/reject").send({ note: "Need supplier confirmation" });

    expect(response.status).toBe(200);
    expect(response.body.live_recipe_changed).toBe(false);
    const writes = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(writes).toContainEqual(expect.stringContaining("INSERT INTO recipe_suggestion_actions"));
    expect(writes.some((query) => query.includes("product_recipes"))).toBe(false);
  });

  it("keeps a replacement without a requirement unresolved and reviewable", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [{
            id: 81,
            workspace_owner_id: "workspace_recipe",
            product_id: 7,
            version: 1,
            status: "generated",
            generation_context: {
              target_product: { name: "Red Rose Box" },
              structured_requirements: { ingredient: "red rose" },
            },
            confidence: "0.5",
            rationale: "draft",
            created_by_user_id: "reviewer_1",
            created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM recipe_suggestion_lines") && query.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [{
            id: 101,
            line_order: 0,
            proposed_base_item_id: 11,
            proposed_base_item_name: "Pink Rose",
            proposed_base_item_code: "ROSE-PINK",
            extracted_requirement: "red rose",
            unit_context: "stem",
            source_evidence: [{ type: "product_name" }],
            match_confidence: "low",
            quantity: "12",
            confidence: "0.4",
            source_type: "ai",
            source_rule_id: null,
            rationale: "Similar wording",
            resolution_status: "resolved",
            exclusion_reason: null,
            exclusion_acknowledged: false,
            created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({
          rows: [{
            id: 12,
            name: "Red Rose",
            code: "ROSE-RED",
            canonical_unit: "stem",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("UPDATE recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 101,
            line_order: 0,
            proposed_base_item_id: 12,
            proposed_base_item_name: "Red Rose",
            proposed_base_item_code: "ROSE-RED",
            extracted_requirement: "red rose",
            unit_context: "stem",
            source_evidence: [{ type: "product_name" }],
            match_confidence: "high",
            quantity: "12",
            confidence: "0.95",
            source_type: "reviewer_correction",
            source_rule_id: null,
            rationale: "Verified",
            resolution_status: "resolved",
            exclusion_reason: null,
            exclusion_acknowledged: false,
            created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) {
        return Promise.resolve({
          rows: [{ id: 501, correction_type: "replace_base_item", intent: "product_only" }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app())
      .post("/recipe-suggestions/81/corrections")
      .send({
        correction_type: "replace_base_item",
        line_id: 101,
        extraction_error_type: "base_item_selection",
        reason: "incorrect_base_item",
        base_item_id: 12,
        note: "Verified",
      });

    expect(response.status).toBe(201);
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements).toContainEqual(expect.stringContaining("INSERT INTO recipe_suggestion_corrections"));
    expect(mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("UPDATE recipe_suggestion_lines"))?.[1]).toContain("unresolved");
    expect(statements).not.toContainEqual(expect.stringContaining("product_recipes"));
    expect(statements.some((query) => query.includes("INSERT INTO product_recipes"))).toBe(false);
    expect(statements.some((query) => query.includes("INSERT INTO base_item_aliases"))).toBe(false);
  });

  it("requires explicit acknowledgement for no-suitable-item exclusion", async () => {
    const response = await request(app())
      .post("/recipe-suggestions/81/corrections")
      .send({
        correction_type: "preserve_unresolved",
        line_id: 101,
        extraction_error_type: "candidate_retrieval",
        reason: "no_suitable_existing_base_item",
        acknowledge_exclusion: false,
      });

    expect(response.status).toBe(400);
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it("returns the newer live Recipe instead of overwriting a concurrent version", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions")) {
        return Promise.resolve({
          rows: [{
            id: 82,
            workspace_owner_id: "workspace_recipe",
            product_id: 7,
            version: 1,
            status: "under_review",
            generation_context: { live_recipe_version: 3 },
            confidence: "0.9",
            rationale: "draft",
            created_by_user_id: "reviewer_1",
            created_at: "2026-01-01T00:00:00Z",
          }],
          rowCount: 1,
        });
      }
      if (query.includes("SELECT recipe_version")) {
        return Promise.resolve({ rows: [{ recipe_version: 4 }], rowCount: 1 });
      }
      if (query.includes("FROM product_recipes pr")) {
        return Promise.resolve({
          rows: [{
            product_id: 7,
            base_item_id: 99,
            base_item_name: "New live item",
            base_item_code: "NEW",
            quantity: "2",
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app())
      .post("/recipe-suggestions/82/approve")
      .send({ expected_live_recipe_version: 3 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "LIVE_RECIPE_VERSION_CONFLICT",
      expected_live_recipe_version: 3,
      live_recipe_version: 4,
      live_recipe: [{ baseItemId: 99, baseItemName: "New live item", quantity: 2 }],
    });
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements.some((query) => query.includes("DELETE FROM product_recipes"))).toBe(false);
    expect(statements).toContain("ROLLBACK");
  });

  it("rejects an incompatible reviewer add_line before draft, correction history, or live writes", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: [{
          id: 90, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
          status: "generated", generation_context: { structured_requirements: [] },
          confidence: "0", rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
        }], rowCount: 1 });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({ rows: [{
          id: 12, name: "Pink Rose", code: "ROSE-PINK", canonical_unit: "stem",
          package_name: null, package_quantity: null, approved_metadata: { color: "pink" },
          candidate_metadata: [], approved_aliases: [],
        }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app()).post("/recipe-suggestions/90/corrections").send({
      correction_type: "add_line",
      extraction_error_type: "extraction",
      reason: "omitted_extraction",
      base_item_id: 12,
      extracted_requirement: "12 red roses",
      quantity: 12,
      corrected_structured_requirement: { attributes: { color: "red" } },
    });

    expect(response.status).toBe(422);
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements.some((query) => query.includes("INSERT INTO recipe_suggestion_lines"))).toBe(false);
    expect(statements.some((query) => query.includes("INSERT INTO recipe_suggestion_corrections"))).toBe(false);
    expect(statements.some((query) => query.includes("recipe_suggestion_actions"))).toBe(false);
    expect(statements.some((query) => query.includes("product_recipes"))).toBe(false);
  });

  it("rejects an explicit container with a balloon subtype before beginning an add_line transaction", async () => {
    const response = await request(app()).post("/recipe-suggestions/109/corrections").send({
      correction_type: "add_line",
      extraction_error_type: "extraction",
      reason: "omitted_extraction",
      base_item_id: 30,
      extracted_requirement: "foil balloon",
      quantity: 1,
      corrected_structured_requirement: { kind: "container", subtype: "balloon" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid recipe correction");
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements).not.toContain("BEGIN");
    expect(statements.some((query) => query.includes("INSERT INTO recipe_suggestion_lines"))).toBe(false);
    expect(statements.some((query) => query.includes("INSERT INTO recipe_suggestion_corrections"))).toBe(false);
  });

  it("persists a reviewer botanical ingredient with stable semantic provenance after current compatibility passes", async () => {
    const result = await persistReviewerAddedLine({
      suggestionId: 110,
      phrase: "12 red roses",
      quantity: 12,
      unit: "stem",
      item: { id: 31, name: "Red Rose", code: "ROSE-RED", approved_metadata: { color: "red" } },
      correctedStructuredRequirement: {
        kind: "ingredient", subtype: "botanical", attributes: { color: "red" },
      },
    });

    expect(result.response.status).toBe(201);
    expect(result.evidence).toMatchObject({
      type: "reviewer_added_requirement",
      requirement_id: "reviewer:110:3",
      actor_user_id: "reviewer_1",
      requirement_provenance: {
        requirementId: "reviewer:110:3", kind: "ingredient", subtype: "botanical",
        phrase: "12 red roses", quantity: 12, unit: "stem", resolution: "matched",
      },
    });
    expect(result.insert?.[1]).toEqual(expect.arrayContaining(["high", 0.95, "resolved"]));
  });

  it("persists a reviewer container as container semantics without coercing it to an ingredient", async () => {
    const result = await persistReviewerAddedLine({
      suggestionId: 111,
      phrase: "medium round flower box",
      quantity: 1,
      unit: "unit",
      item: { id: 32, name: "Medium Round Flower Box", code: "BOX-M" },
      correctedStructuredRequirement: { kind: "container", subtype: "container" },
    });

    expect(result.response.status).toBe(201);
    expect(result.evidence).toMatchObject({
      requirement_id: "reviewer:111:3",
      actor_user_id: "reviewer_1",
      requirement_provenance: {
        requirementId: "reviewer:111:3", kind: "container", subtype: "container",
        quantity: 1, unit: "unit", resolution: "matched",
      },
    });
    expect(result.evidence.requirement_provenance).not.toMatchObject({ kind: "ingredient" });
    expect(result.insert?.[1]).toEqual(expect.arrayContaining(["high", 0.95, "resolved"]));
  });

  it("preserves explicit balloon component semantics and subtype on a compatible reviewer line", async () => {
    const result = await persistReviewerAddedLine({
      suggestionId: 112,
      phrase: "one foil balloon",
      quantity: 1,
      unit: "unit",
      item: { id: 33, name: "Foil Balloon", code: "BALLOON-FOIL" },
      correctedStructuredRequirement: { kind: "component", subtype: "balloon" },
    });

    expect(result.response.status).toBe(201);
    expect(result.evidence).toMatchObject({
      type: "reviewer_added_requirement",
      requirement_id: "reviewer:112:3",
      actor_user_id: "reviewer_1",
      requirement_provenance: {
        requirementId: "reviewer:112:3", kind: "component", subtype: "balloon",
        phrase: "one foil balloon", quantity: 1, unit: "unit", resolution: "matched",
      },
    });
    expect(result.insert?.[1]).toEqual(expect.arrayContaining(["high", 0.95, "resolved"]));
  });

  it("keeps an unclassifiable reviewer phrase semantically unresolved and blocks compatibility promotion", async () => {
    const result = await persistReviewerAddedLine({
      suggestionId: 113,
      phrase: "Meaningful Moments",
      quantity: 2,
      unit: "unit",
      item: { id: 34, name: "Miscellaneous Supply", code: "MISC" },
    });

    expect(result.response.status).toBe(201);
    expect(result.evidence).toMatchObject({
      type: "reviewer_added_requirement",
      requirement_id: "reviewer:113:3",
      actor_user_id: "reviewer_1",
      requirement_provenance: {
        requirementId: "reviewer:113:3", semanticKindStatus: "unresolved",
        phrase: "Meaningful Moments", quantity: 2, unit: "unit",
        reviewerProvenance: { actorUserId: "reviewer_1" },
      },
    });
    expect(result.evidence.requirement_provenance).not.toHaveProperty("kind");
    expect(result.insert?.[1]).toEqual(expect.arrayContaining(["low", 0.4, "unresolved"]));
    expect(result.insert?.[1]).not.toContain("high");
    expect(result.insert?.[1]).not.toContain("resolved");
  });

  it("persists an unknown reviewer add_line as low and unresolved, so it cannot be approved", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: [{
          id: 91, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
          status: "generated", generation_context: { structured_requirements: [] },
          confidence: "0", rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
        }], rowCount: 1 });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({ rows: [{
          id: 13, name: "Rose", code: "ROSE", canonical_unit: "stem",
          package_name: null, package_quantity: null, approved_metadata: {},
          candidate_metadata: [], approved_aliases: [],
        }], rowCount: 1 });
      }
      if (query.includes("SELECT COALESCE(MAX(line_order)")) return Promise.resolve({ rows: [{ line_order: 0 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_lines")) return Promise.resolve({ rows: [{ id: 901 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) return Promise.resolve({ rows: [{ id: 902 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app()).post("/recipe-suggestions/91/corrections").send({
      correction_type: "add_line",
      extraction_error_type: "extraction",
      reason: "omitted_extraction",
      base_item_id: 13,
      extracted_requirement: "12 red roses",
      quantity: 12,
      corrected_structured_requirement: { attributes: { color: "red" } },
    });

    expect(response.status).toBe(201);
    const insert = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("INSERT INTO recipe_suggestion_lines"));
    expect(insert?.[1]).toEqual(expect.arrayContaining(["low", 0.4, "unresolved"]));
    expect(insert?.[1]).not.toContain("resolved");
  });

  it("does not approve the unresolved low-confidence reviewer-added requirement", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions")) return Promise.resolve({ rows: [{
        id: 95, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1, status: "under_review",
        generation_context: { live_recipe_version: 0 }, confidence: "0", rationale: null,
        created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("SELECT recipe_version FROM products")) return Promise.resolve({ rows: [{ recipe_version: 0 }], rowCount: 1 });
      if (query.includes("FROM recipe_suggestion_lines")) return Promise.resolve({ rows: [{
        id: 105, line_order: 0, proposed_base_item_id: 13, proposed_base_item_name: "Rose", proposed_base_item_code: "ROSE",
        extracted_requirement: "12 red roses", unit_context: "stem", source_evidence: [{ requirement_id: "reviewer:95:0" }],
        match_confidence: "low", quantity: "12", confidence: "0.4", source_type: "reviewer_correction", source_rule_id: null,
        rationale: "Reviewer-added requirement", resolution_status: "unresolved", exclusion_reason: null, exclusion_acknowledged: false,
        created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app()).post("/recipe-suggestions/95/approve").send({ expected_live_recipe_version: 0 });

    expect(response.status).toBe(422);
    expect(response.body.error).toContain("Resolve every no-match line");
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements.some((query) => query.includes("product_recipes"))).toBe(false);
  });

  it("persists a compatible reviewer add_line as high and resolved", async () => {
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) {
        return Promise.resolve({ rows: [{
          id: 92, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1,
          status: "generated", generation_context: { structured_requirements: [] },
          confidence: "0", rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
        }], rowCount: 1 });
      }
      if (query.includes("FROM base_items bi")) {
        return Promise.resolve({ rows: [{
          id: 14, name: "Red Rose", code: "ROSE-RED", canonical_unit: "stem",
          package_name: null, package_quantity: null, approved_metadata: { color: "red" },
          candidate_metadata: [], approved_aliases: [],
        }], rowCount: 1 });
      }
      if (query.includes("SELECT COALESCE(MAX(line_order)")) return Promise.resolve({ rows: [{ line_order: 0 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_lines")) return Promise.resolve({ rows: [{ id: 903 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) return Promise.resolve({ rows: [{ id: 904 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app()).post("/recipe-suggestions/92/corrections").send({
      correction_type: "add_line",
      extraction_error_type: "extraction",
      reason: "omitted_extraction",
      base_item_id: 14,
      extracted_requirement: "12 red roses",
      quantity: 12,
      corrected_structured_requirement: { attributes: { color: "red" } },
    });

    expect(response.status).toBe(201);
    const insert = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("INSERT INTO recipe_suggestion_lines"));
    expect(insert?.[1]).toEqual(expect.arrayContaining(["high", 0.95, "resolved"]));
  });

  it("rejects approval after current governed metadata makes an earlier-compatible requirement incompatible, without product recipe writes", async () => {
    const requirement = {
      requirementId: "red-rose", kind: "ingredient" as const, phrase: "red roses", quantity: 12, unit: "stem",
      attributes: { color: "red" }, candidateBaseItemIds: [15], resolution: "matched" as const,
      evidence: { sourceField: "name" as const, sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0, exactPhrase: "red roses", normalizedPhrase: "red roses", span: { start: 0, end: 9 } },
      similarEvidence: [],
      // This stale generation diagnostic intentionally says the now-changed item was safe.
      candidateCompatibility: [{ baseItemId: 15, survivor: true, hardExclusions: [], hasUnknownExplicitDiscriminator: false }],
    };
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions")) return Promise.resolve({ rows: [{
        id: 94, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1, status: "under_review",
        generation_context: { live_recipe_version: 0, structured_requirements: [requirement] }, confidence: "0",
        rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("SELECT recipe_version FROM products")) return Promise.resolve({ rows: [{ recipe_version: 0 }], rowCount: 1 });
      if (query.includes("FROM recipe_suggestion_lines")) return Promise.resolve({ rows: [{
        id: 104, line_order: 0, proposed_base_item_id: 15, proposed_base_item_name: "Red Rose", proposed_base_item_code: "ROSE-RED",
        extracted_requirement: "red roses", unit_context: "stem", source_evidence: [{ requirement_id: "red-rose", requirement_provenance: requirement }],
        match_confidence: "high", quantity: "12", confidence: "0.95", source_type: "reviewer_correction", source_rule_id: null,
        rationale: "reviewed", resolution_status: "resolved", exclusion_reason: null, exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("FROM products p")) return Promise.resolve({ rows: [], rowCount: 0 });
      if (query.includes("FROM product_recipes pr")) return Promise.resolve({ rows: [], rowCount: 0 });
      if (query.includes("FROM base_items bi")) return Promise.resolve({ rows: [{
        id: 15, name: "Pink Rose", code: "ROSE-RED", canonical_unit: "stem", package_name: null, package_quantity: null,
        status: "active", archived_at: null, approved_metadata: { color: "pink" }, candidate_metadata: [], approved_aliases: [],
      }], rowCount: 1 });
      if (query.includes("FROM recipe_rules")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const response = await request(app()).post("/recipe-suggestions/94/approve").send({ expected_live_recipe_version: 0 });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("RECIPE_COMPATIBILITY_REVIEW_REQUIRED");
    expect(response.body.compatibility_failures).toEqual([{ line_id: 104, requirement_id: "red-rose", state: "incompatible" }]);
    const statements = mockClientQuery.mock.calls.map(([statement]) => sql(statement));
    expect(statements.some((query) => query.includes("DELETE FROM product_recipes"))).toBe(false);
    expect(statements.some((query) => query.includes("INSERT INTO product_recipes"))).toBe(false);
  });

  it("snapshots and corrects only selected requirement A, preserving a reviewer-added stable identity and correction evidence", async () => {
    const requirementA = {
      requirementId: "reviewer:93:0", kind: "ingredient" as const, phrase: "red roses", quantity: 12, unit: "stem",
      attributes: { color: "red" }, candidateBaseItemIds: [11], resolution: "matched" as const,
      evidence: { sourceField: "name" as const, sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0, exactPhrase: "red roses", normalizedPhrase: "red roses", span: { start: 0, end: 9 } },
      similarEvidence: [],
    };
    const requirementB = { ...requirementA, requirementId: "requirement-b", phrase: "white lilies", quantity: 3, attributes: { color: "white" } };
    const line = {
      id: 101, line_order: 0, proposed_base_item_id: 11, proposed_base_item_name: "Red Rose", proposed_base_item_code: "ROSE-RED",
      extracted_requirement: "red roses", unit_context: "stem", source_evidence: [{ type: "reviewer_added_requirement", requirement_id: "reviewer:93:0", requirement_provenance: requirementA }],
      match_confidence: "high", quantity: "12", confidence: "0.95", source_type: "deterministic_rule", source_rule_id: null,
      rationale: "matched", resolution_status: "resolved", exclusion_reason: null, exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
    };
    mockClientQuery.mockImplementation((statement: unknown) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [{
        id: 93, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1, status: "generated",
        generation_context: { structured_requirements: [requirementA, requirementB] }, confidence: "0",
        rationale: null, created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("FROM recipe_suggestion_lines") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [line], rowCount: 1 });
      if (query.includes("UPDATE recipe_suggestion_lines SET proposed")) return Promise.resolve({ rows: [line], rowCount: 1 });
      if (query.includes("UPDATE recipe_suggestion_lines SET source_evidence")) return Promise.resolve({ rows: [line], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) return Promise.resolve({ rows: [{ id: 905 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app()).post("/recipe-suggestions/93/corrections").send({
      correction_type: "correct_requirement", line_id: 101, extraction_error_type: "requirement_extraction",
      reason: "incorrect_requirement", corrected_structured_requirement: { phrase: "scarlet roses" },
    });

    expect(response.status).toBe(201);
    const correction = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("INSERT INTO recipe_suggestion_corrections"));
    const original = JSON.parse(String(correction?.[1]?.[5]));
    const corrected = JSON.parse(String(correction?.[1]?.[6]));
    expect(original).toEqual(requirementA);
    expect(original).not.toMatchObject({ requirementId: "requirement-b" });
    expect(corrected).toMatchObject({ requirementId: "reviewer:93:0", quantity: 12, unit: "stem", phrase: "scarlet roses" });
    expect(corrected.evidence).toMatchObject({ exactPhrase: "scarlet roses", provenance: "reviewer_correction" });
    expect(corrected.evidence.exactPhrase).not.toBe(requirementA.evidence.exactPhrase);
  });

  it("merges an attribute correction into only the linked requirement and records exact reviewer provenance", async () => {
    const requirement = {
      requirementId: "requirement-a", kind: "ingredient" as const, phrase: "red roses", quantity: 12, unit: "stem",
      attributes: { color: "red", ingredientType: "rose", stemLength: { value: 50, unit: "cm" } },
      candidateBaseItemIds: [11], resolution: "matched" as const,
      evidence: { sourceField: "name" as const, sourceIndex: 0, lineIndex: 0, componentIndex: 0, occurrence: 0, exactPhrase: "red roses", normalizedPhrase: "red roses", span: { start: 0, end: 9 } },
      similarEvidence: [],
    };
    const line = {
      id: 106, line_order: 0, proposed_base_item_id: 11, proposed_base_item_name: "Rose", proposed_base_item_code: "ROSE",
      extracted_requirement: "different extracted string", unit_context: "stem",
      source_evidence: [{ requirement_id: "requirement-a", requirement_provenance: requirement }],
      match_confidence: "high", quantity: "12", confidence: "0.95", source_type: "reviewer_correction", source_rule_id: null,
      rationale: "matched", resolution_status: "resolved", exclusion_reason: null, exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
    };
    mockClientQuery.mockImplementation((statement: unknown, values?: unknown[]) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [{
        id: 96, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1, status: "generated",
        generation_context: { structured_requirements: [requirement] }, confidence: "0", rationale: null,
        created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("FROM recipe_suggestion_lines") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [line], rowCount: 1 });
      if (query.includes("UPDATE recipe_suggestion_lines SET proposed")) return Promise.resolve({ rows: [line], rowCount: 1 });
      if (query.includes("UPDATE recipe_suggestion_lines SET source_evidence")) {
        return Promise.resolve({ rows: [{ ...line, source_evidence: JSON.parse(String(values?.[3])) }], rowCount: 1 });
      }
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) return Promise.resolve({ rows: [{ id: 906 }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(app()).post("/recipe-suggestions/96/corrections").send({
      correction_type: "correct_requirement", line_id: 106, extraction_error_type: "requirement_extraction",
      reason: "incorrect_structured_requirement",
      corrected_structured_requirement: { attributes: { color: "scarlet" } },
    });

    expect(response.status).toBe(201);
    const correctionCall = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("INSERT INTO recipe_suggestion_corrections"));
    const original = JSON.parse(String(correctionCall?.[1]?.[5]));
    const corrected = JSON.parse(String(correctionCall?.[1]?.[6]));
    expect(original).toEqual(requirement);
    expect(corrected).toMatchObject({
      requirementId: "requirement-a", quantity: 12, unit: "stem",
      attributes: { color: "scarlet", ingredientType: "rose", stemLength: { value: 50, unit: "cm" } },
      reviewerCorrectionProvenance: { changedFields: ["attributes.color"] },
    });
    const evidenceUpdate = mockClientQuery.mock.calls.find(([statement]) => sql(statement).includes("UPDATE recipe_suggestion_lines SET source_evidence"));
    const updatedEvidence = JSON.parse(String(evidenceUpdate?.[1]?.[3]));
    expect(updatedEvidence).toEqual([expect.objectContaining({
      requirement_id: "requirement-a",
      requirement_provenance: expect.objectContaining({ requirementId: "requirement-a", attributes: expect.objectContaining({ color: "scarlet" }) }),
    })]);
  });

  it("keeps the one reviewer add_line requirement ID through a later correct_requirement call", async () => {
    let storedLine: Record<string, unknown> | null = null;
    const correctionRequirements: Record<string, unknown>[] = [];
    mockClientQuery.mockImplementation((statement: unknown, values?: unknown[]) => {
      const query = sql(statement);
      if (query.includes("FROM recipe_suggestions") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: [{
        id: 97, workspace_owner_id: "workspace_recipe", product_id: 7, version: 1, status: "generated",
        generation_context: { structured_requirements: [] }, confidence: "0", rationale: null,
        created_by_user_id: "reviewer_1", created_at: "2026-01-01T00:00:00Z",
      }], rowCount: 1 });
      if (query.includes("FROM base_items bi")) return Promise.resolve({ rows: [{
        id: 17, name: "Red Rose", code: "ROSE-RED", canonical_unit: "stem", package_name: null, package_quantity: null,
        approved_metadata: { color: "red" }, candidate_metadata: [], approved_aliases: [],
      }], rowCount: 1 });
      if (query.includes("SELECT COALESCE(MAX(line_order)")) return Promise.resolve({ rows: [{ line_order: 0 }], rowCount: 1 });
      if (query.includes("INSERT INTO recipe_suggestion_lines")) {
        storedLine = {
          id: 107, line_order: 0, proposed_base_item_id: 17, proposed_base_item_name: "Red Rose", proposed_base_item_code: "ROSE-RED",
          extracted_requirement: values?.[6], unit_context: values?.[7], source_evidence: JSON.parse(String(values?.[8])),
          match_confidence: values?.[9], quantity: values?.[10], confidence: values?.[11], source_type: "reviewer_correction",
          source_rule_id: null, rationale: values?.[12], resolution_status: values?.[13], exclusion_reason: null,
          exclusion_acknowledged: false, created_at: "2026-01-01T00:00:00Z",
        };
        return Promise.resolve({ rows: [storedLine], rowCount: 1 });
      }
      if (query.includes("FROM recipe_suggestion_lines") && query.includes("FOR UPDATE")) return Promise.resolve({ rows: storedLine ? [storedLine] : [], rowCount: storedLine ? 1 : 0 });
      if (query.includes("UPDATE recipe_suggestion_lines SET proposed")) return Promise.resolve({ rows: storedLine ? [storedLine] : [], rowCount: 1 });
      if (query.includes("UPDATE recipe_suggestion_lines SET source_evidence")) {
        storedLine = { ...storedLine, source_evidence: JSON.parse(String(values?.[3])) };
        return Promise.resolve({ rows: [storedLine], rowCount: 1 });
      }
      if (query.includes("INSERT INTO recipe_suggestion_corrections")) {
        correctionRequirements.push(JSON.parse(String(values?.[6])));
        return Promise.resolve({ rows: [{ id: correctionRequirements.length }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const added = await request(app()).post("/recipe-suggestions/97/corrections").send({
      correction_type: "add_line", extraction_error_type: "extraction", reason: "omitted_extraction",
      base_item_id: 17, extracted_requirement: "12 red roses", quantity: 12,
      corrected_structured_requirement: { attributes: { color: "red" } },
    });
    expect(added.status).toBe(201);
    const addedEvidence = (storedLine as unknown as { source_evidence: Array<{ requirement_provenance: { requirementId: string } }> }).source_evidence;
    const addedRequirement = addedEvidence[0].requirement_provenance;
    expect(addedRequirement.requirementId).toBe("reviewer:97:0");

    const corrected = await request(app()).post("/recipe-suggestions/97/corrections").send({
      correction_type: "correct_requirement", line_id: 107, extraction_error_type: "requirement_extraction",
      reason: "incorrect_structured_requirement", corrected_structured_requirement: { phrase: "scarlet roses" },
    });
    expect(corrected.status).toBe(201);
    expect(correctionRequirements[1]).toMatchObject({ requirementId: "reviewer:97:0", phrase: "scarlet roses" });
    const persisted = (storedLine as unknown as { source_evidence: Array<{ requirement_id: string; requirement_provenance: { requirementId: string } }> }).source_evidence[0];
    expect(persisted).toMatchObject({ requirement_id: "reviewer:97:0", requirement_provenance: { requirementId: "reviewer:97:0" } });
  });
});