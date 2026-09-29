// ---------------------------------------------------------------------------
// Omnichannel Phase 5 — Automation flows API routes
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { workspace } from "../../../lib/workspace";
import { validateFlowGraph } from "../automation/flowTypes";
import { runMockExecution, startFlow } from "../automation/flowExecutor";
import type { FlowGraph } from "../automation/flowTypes";

const router = Router();

const managerAuth = requireOmnichannelRole("omnichannel:manager");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TRIGGER_TYPES = [
  "first_inbound_message",
  "keyword_match",
  "tag_added",
  "message_not_responded",
] as const;

const createFlowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  trigger_type: z.enum(["first_inbound_message", "keyword_match", "tag_added", "message_not_responded"]),
  trigger_conditions: z.record(z.string(), z.unknown()).optional(),
  flow_graph: z.record(z.string(), z.unknown()),
  channel_account_id: z.number().optional(),
});

const updateFlowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  trigger_type: z.enum(["first_inbound_message", "keyword_match", "tag_added", "message_not_responded"]).optional(),
  trigger_conditions: z.record(z.string(), z.unknown()).nullable().optional(),
  flow_graph: z.record(z.string(), z.unknown()).optional(),
  channel_account_id: z.number().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FlowRow {
  id: number;
  workspace_owner_id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_conditions: unknown | null;
  flow_graph: FlowGraph;
  state: string;
  channel_account_id: number | null;
  execution_count: number;
  created_by_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function serializeFlow(row: FlowRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger_type: row.trigger_type,
    trigger_conditions: row.trigger_conditions,
    flow_graph: row.flow_graph,
    state: row.state,
    channel_account_id: row.channel_account_id,
    execution_count: row.execution_count,
    created_by_agent_id: row.created_by_agent_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getFlow(id: number, workspaceOwnerId: string): Promise<FlowRow | null> {
  const result = await db.query<FlowRow>(
    `SELECT * FROM omni_automation_flows WHERE id = $1 AND workspace_owner_id = $2`,
    [id, workspaceOwnerId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// GET /omnichannel/flows
// ---------------------------------------------------------------------------

router.get("/omnichannel/flows", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const state = req.query.state as string | undefined;

    const conditions = ["workspace_owner_id = $1"];
    const params: unknown[] = [wreq.workspaceOwnerId];
    let pIdx = 2;

    if (state) {
      conditions.push(`state = $${pIdx++}`);
      params.push(state);
    }

    const result = await db.query<FlowRow>(
      `SELECT * FROM omni_automation_flows
       WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC`,
      params,
    );

    res.json({ flows: result.rows.map(serializeFlow) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to list flows");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows
// ---------------------------------------------------------------------------

router.post("/omnichannel/flows", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const parsed = createFlowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }

    const d = parsed.data;

    const result = await db.query<FlowRow>(
      `INSERT INTO omni_automation_flows
         (workspace_owner_id, name, description, trigger_type, trigger_conditions,
          flow_graph, state, channel_account_id, created_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        d.name,
        d.description ?? null,
        d.trigger_type,
        d.trigger_conditions ? JSON.stringify(d.trigger_conditions) : null,
        JSON.stringify(d.flow_graph),
        d.channel_account_id ?? null,
        wreq.userId,
      ],
    );

    res.status(201).json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to create flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /omnichannel/flows/:id
// ---------------------------------------------------------------------------

router.get("/omnichannel/flows/:id", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const execResult = await db.query<{ id: string; status: string; started_at: Date; finished_at: Date | null }>(
      `SELECT id, status, started_at, finished_at FROM omni_automation_executions
       WHERE flow_id = $1 ORDER BY started_at DESC LIMIT 10`,
      [id],
    );

    res.json({ flow: serializeFlow(flow), recent_executions: execResult.rows });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to get flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /omnichannel/flows/:id
// ---------------------------------------------------------------------------

router.patch("/omnichannel/flows/:id", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const parsed = updateFlowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const d = parsed.data;
    const updates: string[] = [];
    const params: unknown[] = [];
    let pIdx = 1;

    if (d.name !== undefined) { updates.push(`name = $${pIdx++}`); params.push(d.name); }
    if (d.description !== undefined) { updates.push(`description = $${pIdx++}`); params.push(d.description); }
    if (d.trigger_type !== undefined) { updates.push(`trigger_type = $${pIdx++}`); params.push(d.trigger_type); }
    if (d.trigger_conditions !== undefined) {
      updates.push(`trigger_conditions = $${pIdx++}`);
      params.push(d.trigger_conditions ? JSON.stringify(d.trigger_conditions) : null);
    }
    if (d.flow_graph !== undefined) { updates.push(`flow_graph = $${pIdx++}`); params.push(JSON.stringify(d.flow_graph)); }
    if (d.channel_account_id !== undefined) { updates.push(`channel_account_id = $${pIdx++}`); params.push(d.channel_account_id); }

    if (updates.length === 0) {
      res.json({ flow: serializeFlow(flow) });
      return;
    }

    updates.push(`updated_at = NOW()`);
    params.push(wreq.workspaceOwnerId, id);

    const result = await db.query<FlowRow>(
      `UPDATE omni_automation_flows SET ${updates.join(", ")}
       WHERE workspace_owner_id = $${pIdx++} AND id = $${pIdx++}
       RETURNING *`,
      params,
    );

    res.json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to update flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/publish
// ---------------------------------------------------------------------------

router.post("/omnichannel/flows/:id/publish", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const validation = validateFlowGraph(flow.flow_graph);
    if (!validation.valid) {
      res.status(422).json({ error: "Flow graph validation failed", errors: validation.errors });
      return;
    }

    const result = await db.query<FlowRow>(
      `UPDATE omni_automation_flows SET state = 'active', updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId],
    );

    res.json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to publish flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/pause
// ---------------------------------------------------------------------------

router.post("/omnichannel/flows/:id/pause", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const result = await db.query<FlowRow>(
      `UPDATE omni_automation_flows SET state = 'paused', updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId],
    );

    res.json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to pause flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/test
// ---------------------------------------------------------------------------

const testFlowSchema = z.object({
  mock_contact: z.record(z.string(), z.string()).optional(),
});

router.post("/omnichannel/flows/:id/test", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const parsed = testFlowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const validation = validateFlowGraph(flow.flow_graph);
    if (!validation.valid) {
      res.status(422).json({ error: "Flow graph validation failed", errors: validation.errors });
      return;
    }

    const mockContact: Record<string, string> = parsed.data.mock_contact ?? {
      name: "Test Contact",
      phone: "+1234567890",
      _lastInboundContent: "Hello, I want to know the price",
    };

    const events = await runMockExecution(flow.flow_graph, mockContact);

    res.json({ events, validation });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to test flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/duplicate
// ---------------------------------------------------------------------------

router.post("/omnichannel/flows/:id/duplicate", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const result = await db.query<FlowRow>(
      `INSERT INTO omni_automation_flows
         (workspace_owner_id, name, description, trigger_type, trigger_conditions,
          flow_graph, state, channel_account_id, created_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        `${flow.name} (copy)`,
        flow.description,
        flow.trigger_type,
        flow.trigger_conditions ? JSON.stringify(flow.trigger_conditions) : null,
        JSON.stringify(flow.flow_graph),
        flow.channel_account_id,
        wreq.userId,
      ],
    );

    res.status(201).json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to duplicate flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/archive
// ---------------------------------------------------------------------------

router.post("/omnichannel/flows/:id/archive", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const result = await db.query<FlowRow>(
      `UPDATE omni_automation_flows SET state = 'archived', updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId],
    );

    res.json({ flow: serializeFlow(result.rows[0]) });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to archive flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/flows/:id/run (test-trigger a real execution)
// ---------------------------------------------------------------------------

const runFlowSchema = z.object({
  conversation_id: z.number(),
});

router.post("/omnichannel/flows/:id/run", managerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid flow id" }); return; }

    const parsed = runFlowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }

    const flow = await getFlow(id, wreq.workspaceOwnerId);
    if (!flow) { res.status(404).json({ error: "Flow not found" }); return; }

    const executionId = await startFlow(id, parsed.data.conversation_id, { manual: true });
    if (!executionId) {
      res.status(409).json({ error: "Could not start flow — conversation may already have an active execution or be paused" });
      return;
    }

    res.json({ ok: true, execution_id: executionId });
  } catch (err) {
    logger.error({ err }, "omnichannel: failed to run flow");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
