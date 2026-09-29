import { drizzle } from "drizzle-orm/node-postgres";
import { db as pool } from "./db.js";
import * as schema from "@workspace/db/schema";

/**
 * Drizzle ORM instance wrapping the shared pg.Pool.
 *
 * Use this for type-safe queries on tables that have been graduated to the
 * Drizzle schema in lib/db/src/schema/*.  Route handlers that still query
 * legacy raw-SQL-only tables should continue using the raw `db` pool.
 */
export const drizzleDb = drizzle(pool, { schema });
export type DrizzleDb = typeof drizzleDb;
