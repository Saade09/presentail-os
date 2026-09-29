import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db";
import { assertMutationDatabaseReady } from "./mutationDatabaseReadiness";

describe("mutation database readiness", () => {
  afterAll(async () => {
    await db.end();
  });

  it("proves write privileges and rolls its write-stage transaction back", async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products`,
    );

    await expect(assertMutationDatabaseReady()).resolves.toBeUndefined();

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM products`,
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});