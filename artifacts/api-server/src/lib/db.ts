import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const RETRYABLE_PG_CODES = new Set(["40001", "40P01"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` inside a BEGIN/COMMIT transaction on `client`.
 *
 * If PostgreSQL raises a serialization failure (40001) or a deadlock (40P01)
 * the transaction is rolled back and retried with exponential back-off, up to
 * `maxRetries` times (default 3).  All other errors are rolled back and
 * re-thrown immediately without retrying.
 *
 * The caller is responsible for acquiring the client from the pool and
 * releasing it after `withTransaction` resolves or rejects.
 */
export async function withTransaction<T>(
  client: pg.PoolClient,
  fn: () => Promise<T>,
  { maxRetries = 3 }: { maxRetries?: number } = {},
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await client.query("BEGIN");
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow rollback errors */
      }

      const code =
        err !== null &&
        typeof err === "object" &&
        "code" in err
          ? (err as { code?: string }).code
          : undefined;

      if (code !== undefined && RETRYABLE_PG_CODES.has(code) && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 50;
        logger.warn(
          { pgCode: code, attempt: attempt + 1, backoffMs },
          "withTransaction: retrying after database conflict",
        );
        await sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }

  throw new Error("withTransaction: exceeded maxRetries without returning");
}
