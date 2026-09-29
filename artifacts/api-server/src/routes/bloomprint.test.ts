import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockEditImageBuffers = vi.fn();
const mockGetObjectEntityFile = vi.fn();

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
vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    getObjectEntityFile: (...args: unknown[]) => mockGetObjectEntityFile(...args),
    savePrivateObject: vi.fn(),
    copyPrivateObjectToPublic: vi.fn(),
  },
}));
vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  generateImageBuffer: vi.fn(),
  editImageBuffers: (...args: unknown[]) => mockEditImageBuffers(...args),
}));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));

let role: "owner" | "member" = "owner";
let allowedPages: string[] | null = null;
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as WorkspaceRequest;
    wreq.workspaceOwnerId = "workspace_bloomprint";
    wreq.workspaceRole = role;
    wreq.workspaceActualRole = role;
    wreq.allowedPages = allowedPages;
    wreq.userId = "reviewer_1";
    next();
  },
  workspace: (req: express.Request) => req as WorkspaceRequest,
}));

import bloomprintRouter, { calculateBloomprintCostDerivedPrices } from "./bloomprint";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(bloomprintRouter);
  return instance;
}

function statement(call: unknown): string {
  return String(call);
}

const draft = {
  id: 12,
  workspace_owner_id: "workspace_bloomprint",
  inspiration_image_path: "/objects/workspace_bloomprint/uploads/inspiration",
  analysis: { visual_summary: "A compact blush arrangement." },
  name: "Blush Garden",
  description: "A compact blush rose arrangement.",
  price_usd: "65",
  price_aed: "239",
  substitution_notes: null,
  status: "draft",
  style_profile_id: 1,
  recipe_suggestion_id: 90,
  generated_image_path: null,
  generated_image_public_path: null,
  approved_product_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("Bloomprint safe draft workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    role = "owner";
    allowedPages = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockEditImageBuffers.mockReset();
    mockGetObjectEntityFile.mockReset();
  });

  it("applies workspace markup once when deriving AED from recipe cost", () => {
    expect(calculateBloomprintCostDerivedPrices(100, 20, 3.675, "round_nearest_whole"))
      .toEqual({ priceUsd: 120, priceAed: 441 });
  });

  it("does not expose drafts to a member without product-management permission", async () => {
    role = "member";
    allowedPages = ["products"];

    const response = await request(app()).get("/bloomprint/drafts");

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("blocks rendering until every vision requirement has a real Base Item", async () => {
    mockDbQuery.mockImplementation((query: unknown) => {
      const sql = statement(query);
      if (sql.includes("SELECT * FROM bloomprint_drafts")) return Promise.resolve({ rows: [draft] });
      if (sql.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 1, line_order: 0, proposed_base_item_id: null, proposed_base_item_name: null,
            quantity: "12", extracted_requirement: "blush roses", match_confidence: "no_match",
            source_type: "unresolved", rationale: "No safe match",
          }],
        });
      }
      if (sql.includes("FROM bloomprint_render_attempts")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app()).post("/bloomprint/drafts/12/render").send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/resolve every recipe line/i);
    expect(mockDbQuery.mock.calls.some(([query]) => statement(query).includes("bloomprint_render_attempts") && statement(query).includes("INSERT"))).toBe(false);
  });

  it("rechecks that saved recipe selections are still active before rendering", async () => {
    mockDbQuery.mockImplementation((query: unknown) => {
      const sql = statement(query);
      if (sql.includes("SELECT * FROM bloomprint_drafts")) return Promise.resolve({ rows: [draft] });
      if (sql.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 1, line_order: 0, proposed_base_item_id: 55, proposed_base_item_name: "Garden Rose",
            quantity: "12", extracted_requirement: "blush roses", match_confidence: "high",
            source_type: "bloomprint_match", rationale: "Direct visual match",
          }],
        });
      }
      if (sql.includes("FROM bloomprint_render_attempts")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT id FROM base_items")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app()).post("/bloomprint/drafts/12/render").send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/no longer active/i);
    expect(mockDbQuery.mock.calls.some(([query]) => statement(query).includes("bloomprint_render_attempts") && statement(query).includes("INSERT"))).toBe(false);
  });

  it("blocks approval before a private generated image and a resolved recipe exist", async () => {
    mockClientQuery.mockImplementation((query: unknown) => {
      const sql = statement(query);
      if (sql.includes("SELECT * FROM bloomprint_drafts")) return Promise.resolve({ rows: [draft] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app()).post("/bloomprint/drafts/12/approve").send({});

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/render a catalogue image/i);
    expect(mockClientQuery.mock.calls.some(([query]) => statement(query).includes("INSERT INTO products"))).toBe(false);
    expect(mockClientQuery.mock.calls.some(([query]) => statement(query).includes("INSERT INTO product_recipes"))).toBe(false);
  });

  it("rejects a style profile reference image that belongs to another workspace", async () => {
    const response = await request(app())
      .post("/bloomprint/style-profiles")
      .send({
        name: "Imported look",
        prompt: "Use the visual reference when styling the product photograph.",
        reference_image_paths: ["/objects/another_workspace/uploads/private-reference"],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/private uploads in this workspace/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("records reference-guided rendering mode and reference count", async () => {
    mockEditImageBuffers.mockResolvedValue(Buffer.from("rendered-image"));
    mockGetObjectEntityFile.mockResolvedValue({
      getMetadata: async () => [{ contentType: "image/png" }],
      download: async () => [Buffer.from("reference-image")],
    });
    mockDbQuery.mockImplementation((query: unknown) => {
      const sql = statement(query);
      if (sql.includes("SELECT * FROM bloomprint_drafts")) return Promise.resolve({ rows: [draft] });
      if (sql.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 1, line_order: 0, proposed_base_item_id: 55, proposed_base_item_name: "Garden Rose",
            quantity: "12", extracted_requirement: "blush roses", match_confidence: "high",
            source_type: "bloomprint_match", rationale: "Direct visual match",
          }],
        });
      }
      if (sql.includes("FROM bloomprint_render_attempts") && sql.includes("SELECT")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT id FROM base_items")) return Promise.resolve({ rows: [{ id: 55 }] });
      if (sql.includes("SELECT prompt, reference_image_paths")) {
        return Promise.resolve({
          rows: [{
            prompt: "Create a refined premium floral product image.",
            reference_image_paths: ["/objects/workspace_bloomprint/uploads/style-reference"],
          }],
        });
      }
      if (sql.includes("INSERT INTO bloomprint_render_attempts")) return Promise.resolve({ rows: [{ id: 77 }] });
      if (sql.includes("UPDATE bloomprint_render_attempts") || sql.includes("UPDATE bloomprint_drafts")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app()).post("/bloomprint/drafts/12/render").send({});

    expect(response.status).toBe(200);
    expect(mockEditImageBuffers).toHaveBeenCalledOnce();
    const attemptInsert = mockDbQuery.mock.calls.find(([query]) => statement(query).includes("INSERT INTO bloomprint_render_attempts"));
    expect(attemptInsert?.[1]).toContain("reference_edit");
    expect(attemptInsert?.[1]).toContain(1);
  });

  it("persists an explicit error when the configured image model is unsupported", async () => {
    process.env.BLOOMPRINT_IMAGE_MODEL = "unsupported-image-model";
    mockDbQuery.mockImplementation((query: unknown) => {
      const sql = statement(query);
      if (sql.includes("SELECT * FROM bloomprint_drafts")) return Promise.resolve({ rows: [draft] });
      if (sql.includes("FROM recipe_suggestion_lines")) {
        return Promise.resolve({
          rows: [{
            id: 1, line_order: 0, proposed_base_item_id: 55, proposed_base_item_name: "Garden Rose",
            quantity: "12", extracted_requirement: "blush roses", match_confidence: "high",
            source_type: "bloomprint_match", rationale: "Direct visual match",
          }],
        });
      }
      if (sql.includes("FROM bloomprint_render_attempts") && sql.includes("SELECT")) return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT id FROM base_items")) return Promise.resolve({ rows: [{ id: 55 }] });
      if (sql.includes("SELECT prompt, reference_image_paths")) {
        return Promise.resolve({ rows: [{ prompt: "Create a refined premium floral product image.", reference_image_paths: [] }] });
      }
      if (sql.includes("INSERT INTO bloomprint_render_attempts")) return Promise.resolve({ rows: [{ id: 78 }] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(app()).post("/bloomprint/drafts/12/render").send({});
    delete process.env.BLOOMPRINT_IMAGE_MODEL;

    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/not supported by the configured OpenAI integration/i);
    expect(mockDbQuery.mock.calls.some(([query]) => statement(query).includes("UPDATE bloomprint_render_attempts") && statement(query).includes("error_message"))).toBe(true);
  });
});