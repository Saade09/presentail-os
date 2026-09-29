import type { PoolClient } from "pg";
import { db } from "./db";

export function orderDestinationLockKey(orderId: string): string {
  return `order-destination:${orderId}`;
}

export async function lockOrderDestinationInTransaction(
  client: Pick<PoolClient, "query">,
  orderId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [orderDestinationLockKey(orderId)],
  );
}

export async function withOrderDestinationLock<T>(
  orderId: string,
  effect: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  const key = orderDestinationLockKey(orderId);
  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [key]);
    return await effect(client);
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
    } finally {
      client.release();
    }
  }
}