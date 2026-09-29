import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("./db", () => ({ db: { query: (...args: unknown[]) => query(...args) } }));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
import { requestStillAllowsProviderSend } from "./supplierStatementWorker";

beforeEach(() => query.mockReset());

describe("supplier statement pre-send recheck", () => {
  it.each(["received", "cancelled", "paused", "reconciled"])(
    "cancels a claimed follow-up when the request is %s",
    async (status) => {
      query.mockResolvedValueOnce({ rows: [{ request_status: status }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      expect(await requestStillAllowsProviderSend(42)).toBe(false);
      expect(String(query.mock.calls[0][0])).toContain("e.status='processing'");
      expect(String(query.mock.calls[1][0])).toContain("status='cancelled'");
    },
  );

  it("allows only a still-processing step on an open request", async () => {
    query.mockResolvedValueOnce({ rows: [{ request_status: "in_progress" }] });
    expect(await requestStillAllowsProviderSend(42)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not send a step cancelled while contact lookup was in flight", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await requestStillAllowsProviderSend(42)).toBe(false);
  });
});