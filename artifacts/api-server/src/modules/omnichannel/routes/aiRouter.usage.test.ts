import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  ownerRole: vi.fn(),
}));

vi.mock("../../../lib/db", () => ({ db: { query: (...args: unknown[]) => mocks.query(...args) } }));
vi.mock("../../../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../omnichannelAuth", () => ({
  requireOmnichannelRole: (role: string) => {
    mocks.ownerRole(role);
    return [(_req: express.Request, _res: express.Response, next: express.NextFunction) => next()];
  },
}));
vi.mock("../../../lib/workspace", () => ({
  workspace: async () => ({ workspaceOwnerId: "workspace-1", userId: "owner-1" }),
}));
vi.mock("../ai", () => ({ getAIProvider: vi.fn(), ENABLE_AI_AUTO_REPLY: false, AI_CONFIDENCE_THRESHOLD: 0.75 }));
vi.mock("../queue/outboundQueue", () => ({ enqueue: vi.fn() }));
vi.mock("../../../lib/credentialEncryption", () => ({ encrypt: (v: string) => v, decryptCredential: async (v: string) => v }));

import router from "./aiRouter";

describe("owner AI usage reports", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("uses owner auth and returns workspace-attributed totals including failures", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      action_key: "omnichannel.draft_reply", provider: "openai", model_id: "gpt-5-mini", calls: "3", successful_calls: "2",
       input_tokens: "12", output_tokens: "7", cached_tokens: "0", reasoning_tokens: "0", cost_usd: "0.12",
       provider_billed_cost_usd: "0.08", estimated_cost_usd: "0.04", provider_billed_calls: "1", estimated_calls: "1",
       unclassified_cost_usd: null, unclassified_cost_calls: "0",
       priced_calls: "2", unpriced_calls: "0", fallback_calls: "0", average_latency_ms: "44",
    }] });
    const app = express();
    app.use(router);
    const response = await request(app).get("/omnichannel/ai/usage-summary?days=7");

    expect(response.status).toBe(200);
    expect(mocks.ownerRole).toHaveBeenCalledWith("omnichannel:owner");
    expect(response.body.totals).toMatchObject({ calls: 3, successful_calls: 2, failed_calls: 1, priced_calls: 2, unpriced_calls: 0, cost_usd: 0.12 });
    expect(response.body.totals).toMatchObject({
      provider_billed_cost_usd: 0.08, estimated_cost_usd: 0.04,
      provider_billed_calls: 1, estimated_calls: 1,
      unclassified_cost_usd: null, unclassified_cost_calls: 0,
    });
    expect(response.body.cost_note).toContain("provider_billed_cost_usd");
    expect(response.body.scope).toBe("workspace_attributed_records_only");
    expect(String(mocks.query.mock.calls[0][0])).toContain("omni_conversations");
    expect(String(mocks.query.mock.calls[0][0])).toContain("workspace:");
    expect(mocks.query.mock.calls[0][1]).toEqual(["workspace-1", 7]);
  });

  it("returns zero totals for no attributed usage and rejects invalid days", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const app = express();
    app.use(router);
    const empty = await request(app).get("/omnichannel/ai/usage-summary");
    expect(empty.status).toBe(200);
    expect(empty.body.totals).toMatchObject({ calls: 0, failed_calls: 0 });
    expect(empty.body.actions).toEqual([]);
    const invalid = await request(app).get("/omnichannel/ai/usage-summary?days=0");
    expect(invalid.status).toBe(400);
  });

  it("exports escaped CSV with the usage headers and same workspace predicate", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      created_at: "2025-01-01T00:00:00Z", action_key: "=a,b", surface: "test",
      provider: "openai", model_id: "gpt-5-mini", key_source: "integration",
      was_fallback: false, input_tokens: 1, output_tokens: 2, cached_tokens: null,
       reasoning_tokens: null, cost_usd: "0.000001", cost_source: "estimated", latency_ms: 3, success: true,
      error_code: null, order_id: null, session_id: "workspace-1", country: "US",
    }] });
    const app = express();
    app.use(router);
    const response = await request(app).get("/omnichannel/ai/usage.csv?days=2");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text).toContain("created_at,action_key,surface");
    expect(response.text).toContain("cost_usd,cost_source,latency_ms");
    expect(response.text).toContain(`"'=a,b"`);
    expect(mocks.query.mock.calls[0][1]).toEqual(["workspace-1", 2]);
    expect(String(mocks.query.mock.calls[0][0])).toContain("omni_conversations");
  });
});