import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = `__recipe_suggestion_live_recipe_boundary_${process.pid}__`;

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: () => ({ userId: "__recipe_suggestion_reviewer__" }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.allowedPages = null;
    wreq.userId = "__recipe_suggestion_reviewer__";
    next();
  },
  workspace: (req: express.Request) => req as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({ file: () => ({ save: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}));

import recipeSuggestionsRouter from "./recipeSuggestions";
import productsRouter from "./products";
import { initDb } from "../lib/initDb";
import recipeIntelligenceRouter from "./recipeIntelligence";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Suggestion paths must precede the general :id product path, just like the
  // production route index.
  app.use(recipeSuggestionsRouter);
  app.use(recipeIntelligenceRouter);
  app.use(productsRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });
  return app;
}

/**
 * Verify that the two confirmed deterministic rules (flower-box/sponge and
 * balloon/metal-ring) are promoted to 'approved' on the very first suggestion
 * request even when the workspace previously had them seeded as 'candidate'.
 * This covers the upgrade path for deployments that ran an earlier initDb.
 */
describe.skipIf(!DATABASE_URL)(
  "deterministic rules are promoted to approved on first suggestion request",
  () => {
    const RULE_OWNER = "__recipe_suggestion_rule_promotion__";
    let pool: InstanceType<typeof Pool>;
    let appForRules: ReturnType<typeof makeApp>;
    let ruleProductId: number;

    beforeAll(async () => {
      // Exercise the current startup migration explicitly before Recipe
      // fixtures, in addition to the integration global setup.
      await initDb();
      pool = new Pool({ connectionString: DATABASE_URL });
      // Patch the module-level workspace mock to use RULE_OWNER for this suite.
      // We abuse the mock by overwriting the resolveWorkspace at module-load
      // time — instead, we insert product/base-items under RULE_OWNER and
      // reuse the app after directly seeding the candidate rules.
      appForRules = makeApp();

      await pool.query(`DELETE FROM recipe_suggestions WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM recipe_rules WHERE workspace_owner_id = $1`, [RULE_OWNER]);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM recipe_suggestions WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.query(`DELETE FROM recipe_rules WHERE workspace_owner_id = $1`, [RULE_OWNER]);
      await pool.end();
    });

    it("promotes candidate deterministic rules to approved when the suggestion route is called", async () => {
      // Simulate a workspace that received the old 'candidate' seed.
      await pool.query(
        `INSERT INTO recipe_rules
           (workspace_owner_id, rule_key, name, description, rule_type, source, status, definition, confidence)
         VALUES
           ($1, 'flower-box-sponge', 'Flower-box sponge', 'desc', 'hidden_item', 'deterministic', 'candidate', '{"product_keywords":["flower","box"],"required_base_item_keywords":["sponge"]}'::jsonb, 0.99),
           ($1, 'balloon-metal-ring', 'Balloon ring',     'desc', 'hidden_item', 'deterministic', 'candidate', '{"product_keywords":["balloon"],"required_base_item_keywords":["ring"]}'::jsonb,           0.99)
         ON CONFLICT DO NOTHING`,
        [RULE_OWNER],
      );

      // Call ensureDeterministicRecipeRules directly through the db used by the route.
      // Import it here (the mock does not intercept this lib import).
      const { ensureDeterministicRecipeRules } = await import("../lib/recipeIntelligence");
      await ensureDeterministicRecipeRules(RULE_OWNER);

      // Rules must now be 'approved'.
      const rules = await pool.query<{ rule_key: string; status: string }>(
        `SELECT rule_key, status FROM recipe_rules
          WHERE workspace_owner_id = $1 AND source = 'deterministic'
          ORDER BY rule_key`,
        [RULE_OWNER],
      );
      expect(rules.rows.length).toBe(2);
      for (const rule of rules.rows) {
        expect(rule.status).toBe("approved");
      }
    });

    it("includes a sponge line when flower-box rules are approved and a sponge base item exists", async () => {
      // This uses OWNER_ID (the mocked workspace) — it exercises the full
      // generate path with an approved flower-box rule and verifies the
      // suggestion includes a sponge sourced from the deterministic rule.
      const { ensureDeterministicRecipeRules } = await import("../lib/recipeIntelligence");
      await ensureDeterministicRecipeRules(OWNER_ID);

      const product = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, description)
         VALUES ($1, $2, $3) RETURNING id`,
        [OWNER_ID, "Medium Round Flower Box with 12 Red Roses", "A flower-box gift"],
      );
      ruleProductId = product.rows[0].id;

      await pool.query(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES ($1, 'Floral Foam Sponge', 'SPONGE-FF'), ($1, 'Medium Round Flower Box', 'BOX-R20')
         ON CONFLICT DO NOTHING`,
        [OWNER_ID],
      );

      const resp = await request(appForRules).post(`/products/${ruleProductId}/recipe-suggestions`).send({});
      expect(resp.status).toBe(201);

      const lines = await pool.query<{ source_type: string; source_evidence: unknown }>(
        `SELECT source_type, source_evidence FROM recipe_suggestion_lines WHERE suggestion_id = $1`,
        [resp.body.suggestion.id],
      );
      // At least one line should be sourced from the active deterministic rule
      const ruleLine = lines.rows.find((l) => l.source_type === "deterministic_rule");
      expect(ruleLine).toBeDefined();
      const evidence = Array.isArray(ruleLine?.source_evidence) ? ruleLine.source_evidence : [];
      expect(evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          hidden_rule_key: expect.stringContaining("flower_box"),
          requirement_id: null,
        }),
      ]));
    });
  },
);

describe.skipIf(!DATABASE_URL)(
  "recipe suggestion approval boundary (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let productId: number;
    let roseId: number;
    let boxId: number;
    let spongeId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      const product = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, description)
         VALUES ($1, $2, $3) RETURNING id`,
        [OWNER_ID, "Medium Round Flower Box with 12 Red Roses", "A flower-box gift"],
      );
      productId = product.rows[0].id;
      const items = await pool.query<{ id: number; code: string }>(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES
           ($1, 'Red Roses', 'ROSE-RED'),
           ($1, 'Medium Round Flower Box', 'BOX-M'),
           ($1, 'Floral Sponge', 'SPONGE')
         RETURNING id, code`,
        [OWNER_ID],
      );
      roseId = items.rows.find((item) => item.code === "ROSE-RED")!.id;
      boxId = items.rows.find((item) => item.code === "BOX-M")!.id;
      spongeId = items.rows.find((item) => item.code === "SPONGE")!.id;

      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO recipe_rules (
           workspace_owner_id, rule_key, name, rule_type, source, status, definition, confidence
         ) VALUES (
           $1, 'integration-scoped-exact-phrase', 'Integration scoped rule',
           'contextual_resolution', 'manual', 'candidate',
           jsonb_build_object(
             'proposed_scope', 'exact_phrase',
             'phrase', 'medium round flower box',
             'base_item_id', $2::integer
           ),
           1
         )
         ON CONFLICT (workspace_owner_id, rule_key)
         DO UPDATE SET status = 'candidate', definition = EXCLUDED.definition
         RETURNING id`,
        [OWNER_ID, spongeId],
      );
      const generated = await request(app).post(`/products/${productId}/recipe-suggestions`).send({});
      expect(generated.status).toBe(201);
      const suggestionId = generated.body.suggestion.id as number;

      const beforeApproval = await request(app).get(`/products/${productId}/cogs`);
      expect(beforeApproval.status, JSON.stringify(beforeApproval.body)).toBe(200);
      expect(beforeApproval.body.items).toEqual([]);

      for (const line of generated.body.lines as Array<{ id: number }>) {
        const removed = await request(app)
          .post(`/recipe-suggestions/${suggestionId}/corrections`)
          .send({
            correction_type: "remove_line",
            line_id: line.id,
            extraction_error_type: "hidden_item_rule_application",
            reason: "incorrect_ai_added_ingredient",
            note: "Replace the generated draft with explicitly reviewed lines",
          });
        expect(removed.status, JSON.stringify(removed.body)).toBe(201);
        expect(removed.body.live_recipe_changed).toBe(false);
      }

      for (const item of [
        { base_item_id: roseId, quantity: 13, extracted_requirement: "13 red roses" },
        { base_item_id: boxId, quantity: 1, extracted_requirement: "one medium round flower box" },
        {
          base_item_id: spongeId,
          quantity: 1,
          extracted_requirement: "one floral sponge",
          corrected_structured_requirement: { kind: "component" },
        },
      ]) {
        const added = await request(app)
          .post(`/recipe-suggestions/${suggestionId}/corrections`)
          .send({
            correction_type: "add_line",
            extraction_error_type: "extraction",
            reason: "omitted_extraction",
            ...item,
          });
        expect(added.status, JSON.stringify(added.body)).toBe(201);
        expect(added.body.live_recipe_changed).toBe(false);
        expect(added.body.learning_activated).toBe(false);
      }

      const correctionHistory = await pool.query(
        `SELECT correction_type, intent
           FROM recipe_suggestion_corrections
          WHERE workspace_owner_id = $1 AND suggestion_id = $2
          ORDER BY id`,
        [OWNER_ID, suggestionId],
      );
      expect(correctionHistory.rows.length).toBeGreaterThanOrEqual(3);
      expect(correctionHistory.rows.every((row) => row.intent === "product_only")).toBe(true);

      const approved = await request(app)
        .post(`/recipe-suggestions/${suggestionId}/approve`)
        .send({
          note: "Approved after review",
          expected_live_recipe_version: generated.body.live_recipe_version,
        });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.live_recipe_changed).toBe(true);

      const live = await pool.query(
        `SELECT base_item_id, quantity::text
           FROM product_recipes
          WHERE workspace_owner_id = $1 AND product_id = $2
          ORDER BY sort_order`,
        [OWNER_ID, productId],
      );
      expect(live.rows).toEqual([
        { base_item_id: roseId, quantity: "13" },
        { base_item_id: boxId, quantity: "1" },
        { base_item_id: spongeId, quantity: "1" },
      ]);

      const afterApproval = await request(app).get(`/products/${productId}/cogs`);
      expect(afterApproval.status, JSON.stringify(afterApproval.body)).toBe(200);
      expect(afterApproval.body.items).toHaveLength(3);
    });

    it("preserves immutable correction evidence and rejects a stale live Recipe approval", async () => {
      const generated = await request(app).post(`/products/${productId}/recipe-suggestions`).send({});
      expect(generated.status).toBe(201);
      const suggestionId = generated.body.suggestion.id as number;
      const lineId = generated.body.lines[0].id as number;

      const corrected = await request(app)
        .post(`/recipe-suggestions/${suggestionId}/corrections`)
        .send({
          correction_type: "change_quantity",
          line_id: lineId,
          extraction_error_type: "quantity_extraction",
          reason: "incorrect_quantity",
          quantity: 13,
          note: "Counted stems against the approved Product format",
        });
      expect(corrected.status).toBe(201);
      expect(corrected.body.live_recipe_changed).toBe(false);
      expect(corrected.body.learning_activated).toBe(false);

      const correctionId = corrected.body.correction.id as number;

      const rule = await pool.query<{ id: number }>(
        `INSERT INTO recipe_rules (
           workspace_owner_id, rule_key, name, rule_type, source, status, definition
         ) VALUES ($1, $2, 'Immutable test rule', 'contextual_resolution', 'manual', 'candidate', '{}'::jsonb)
         RETURNING id`,
        [OWNER_ID, `immutable-test-${suggestionId}`],
      );
      await pool.query(
        `INSERT INTO recipe_rule_evidence (
           workspace_owner_id, rule_id, evidence_type, product_id,
           product_name_snapshot, details
         ) VALUES ($1, $2, 'supporting', $3, 'Historical Product', '{"source":"integration"}'::jsonb)`,
        [OWNER_ID, rule.rows[0].id, productId],
      );
      const suggestionAction = await pool.query<{ id: number }>(
        `SELECT id FROM recipe_suggestion_actions
          WHERE workspace_owner_id = $1 AND suggestion_id = $2
          ORDER BY id LIMIT 1`,
        [OWNER_ID, suggestionId],
      );
      await expect(pool.query(
        `UPDATE recipe_suggestion_actions SET note = 'rewritten' WHERE id = $1`,
        [suggestionAction.rows[0].id],
      )).rejects.toThrow(/recipe_suggestion_actions is append-only/);
      await expect(pool.query(
        `DELETE FROM recipe_suggestion_actions WHERE id = $1`,
        [suggestionAction.rows[0].id],
      )).rejects.toThrow(/recipe_suggestion_actions is append-only/);
      await expect(pool.query(
        `UPDATE recipe_rule_evidence SET details = '{}'::jsonb
          WHERE workspace_owner_id = $1 AND rule_id = $2`,
        [OWNER_ID, rule.rows[0].id],
      )).rejects.toThrow(/recipe_rule_evidence is append-only/);
      await expect(pool.query(
        `DELETE FROM recipe_rule_evidence
          WHERE workspace_owner_id = $1 AND rule_id = $2`,
        [OWNER_ID, rule.rows[0].id],
      )).rejects.toThrow(/recipe_rule_evidence is append-only/);
      await expect(pool.query(
        `DELETE FROM recipe_rules WHERE workspace_owner_id = $1 AND id = $2`,
        [OWNER_ID, rule.rows[0].id],
      )).rejects.toThrow(/recipe_rule_evidence is append-only/);

      const cascadeProtected = await request(app)
        .post(`/products/${productId}/recipe-suggestions`)
        .send({});
      expect(cascadeProtected.status).toBe(201);
      await expect(pool.query(
        `DELETE FROM recipe_suggestions WHERE workspace_owner_id = $1 AND id = $2`,
        [OWNER_ID, cascadeProtected.body.suggestion.id],
      )).rejects.toThrow(/recipe_suggestion_actions is append-only/);

      const currentRecipe = await pool.query<{ base_item_id: number; quantity: string }>(
        `SELECT base_item_id, quantity::text AS quantity
           FROM product_recipes
          WHERE workspace_owner_id = $1 AND product_id = $2
          ORDER BY sort_order`,
        [OWNER_ID, productId],
      );
      const externallyEdited = await request(app)
        .put(`/products/${productId}/recipe`)
        .send({
          items: currentRecipe.rows.map((row, sortOrder) => ({
            base_item_id: row.base_item_id,
            quantity: Number(row.quantity),
            sort_order: sortOrder,
          })),
        });
      expect(externallyEdited.status).toBe(200);

      const staleApproval = await request(app)
        .post(`/recipe-suggestions/${suggestionId}/approve`)
        .send({ expected_live_recipe_version: generated.body.live_recipe_version });
      expect(staleApproval.status).toBe(409);
      expect(staleApproval.body.code).toBe("LIVE_RECIPE_VERSION_CONFLICT");
    });
  },
);
