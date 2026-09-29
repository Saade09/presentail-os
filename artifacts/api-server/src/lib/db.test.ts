import { describe, it, expect, vi, beforeEach } from "vitest";
import type pg from "pg";

vi.useFakeTimers();

const { withTransaction } = await import("./db");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(
  queryImpl: (...args: unknown[]) => unknown,
): pg.PoolClient {
  return {
    query: vi.fn((...args: unknown[]) => queryImpl(...args)),
    release: vi.fn(),
  } as unknown as pg.PoolClient;
}

function pgError(code: string): Error & { code: string } {
  const err = new Error(`PG error ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Run `promise` and `vi.runAllTimersAsync()` together so that fake-timer
 * sleeps inside the promise resolve before we await the result. Attaching
 * the rejection handler via Promise.all prevents unhandled-rejection warnings.
 */
async function drivePromise<T>(promise: Promise<T>): Promise<T> {
  const [result] = await Promise.all([promise, vi.runAllTimersAsync()]);
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes BEGIN → fn → COMMIT on a successful run", async () => {
    const calls: string[] = [];
    const client = makeClient((sql: unknown) => {
      calls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const result = await drivePromise(
      withTransaction(client, async () => {
        calls.push("fn");
        return 42;
      }),
    );

    expect(result).toBe(42);
    expect(calls).toEqual(["BEGIN", "fn", "COMMIT"]);
  });

  it("rolls back and rethrows on a non-retryable error", async () => {
    const calls: string[] = [];
    const client = makeClient((sql: unknown) => {
      calls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const boom = new Error("something bad");
    await expect(
      drivePromise(withTransaction(client, async () => { throw boom; })),
    ).rejects.toThrow("something bad");

    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("retries on a serialization failure (40001) and succeeds on the next attempt", async () => {
    let attempt = 0;
    const queryCalls: string[] = [];

    const client = makeClient((sql: unknown) => {
      queryCalls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const fn = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw pgError("40001");
      return "ok";
    });

    const result = await drivePromise(withTransaction(client, fn));

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(queryCalls.filter((q) => q === "BEGIN")).toHaveLength(2);
    expect(queryCalls.filter((q) => q === "ROLLBACK")).toHaveLength(1);
    expect(queryCalls.filter((q) => q === "COMMIT")).toHaveLength(1);
  });

  it("retries on a deadlock error (40P01) and succeeds on the next attempt", async () => {
    let attempt = 0;
    const queryCalls: string[] = [];

    const client = makeClient((sql: unknown) => {
      queryCalls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const fn = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw pgError("40P01");
      return "done";
    });

    const result = await drivePromise(withTransaction(client, fn));

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(queryCalls.filter((q) => q === "ROLLBACK")).toHaveLength(1);
    expect(queryCalls.filter((q) => q === "COMMIT")).toHaveLength(1);
  });

  it("propagates the error after exhausting maxRetries", async () => {
    const queryCalls: string[] = [];
    const client = makeClient((sql: unknown) => {
      queryCalls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const serialErr = pgError("40001");
    const fn = vi.fn(async () => { throw serialErr; });

    await expect(
      drivePromise(withTransaction(client, fn, { maxRetries: 3 })),
    ).rejects.toThrow(serialErr);

    expect(fn).toHaveBeenCalledTimes(4);
    expect(queryCalls.filter((q) => q === "ROLLBACK")).toHaveLength(4);
    expect(queryCalls.filter((q) => q === "COMMIT")).toHaveLength(0);
  });

  it("does not retry on non-serialization PG errors", async () => {
    const queryCalls: string[] = [];
    const client = makeClient((sql: unknown) => {
      queryCalls.push(sql as string);
      return { rows: [], rowCount: 0 };
    });

    const uniqueErr = pgError("23505");
    const fn = vi.fn(async () => { throw uniqueErr; });

    await expect(
      drivePromise(withTransaction(client, fn)),
    ).rejects.toThrow(uniqueErr);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(queryCalls.filter((q) => q === "ROLLBACK")).toHaveLength(1);
    expect(queryCalls.filter((q) => q === "COMMIT")).toHaveLength(0);
  });

  it("swallows ROLLBACK errors and still rethrows the original error", async () => {
    const client = makeClient((sql: unknown) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });

    const originalErr = new Error("original");
    await expect(
      drivePromise(withTransaction(client, async () => { throw originalErr; })),
    ).rejects.toThrow("original");
  });
});
