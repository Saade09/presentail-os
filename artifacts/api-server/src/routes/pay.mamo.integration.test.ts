/**
 * Integration tests: Mamo payment webhook handler
 *
 * These tests call the real route handler via HTTP against a real PostgreSQL
 * database. They seed an active payment_links row, fire a signed
 * POST /webhooks/mamo request, and then SELECT to verify the actual DB state.
 *
 * The handler authenticates incoming requests by comparing the `Authorization`
 * header to the MAMO_WEBHOOK_SECRET environment variable using a
 * timing-safe comparison. There is no HMAC involved — the secret is sent
 * verbatim by Mamo as the `auth_header` value configured at webhook
 * registration time.
 *
 * Four core scenarios:
 *  1. charge.succeeded with the correct Authorization header → row becomes 'paid'
 *  2. subscription.succeeded with the correct Authorization header → row becomes 'paid'
 *  3. Missing Authorization header → 401, row stays 'active'
 *  4. Wrong Authorization value → 401, row stays 'active'
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const MAMO_WEBHOOK_SECRET = "mamo_integration_test_secret_abc";
const MAMO_API_KEY = "mamo_integration_api_key_xyz";

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import payRouter from "./pay";

function makeApp(): express.Express {
  const app = express();

  app.use((req: express.Request & { rawBody?: Buffer }, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      req.rawBody = buf;
      if (buf.length > 0) {
        try {
          req.body = JSON.parse(buf.toString("utf-8"));
        } catch {
          // leave body unparsed for non-JSON
        }
      }
      next();
    });
    req.on("error", next);
  });

  app.use(payRouter);
  return app;
}

function mamoPayload(event: string, referenceId: string): string {
  return JSON.stringify({ event, data: { reference_id: referenceId } });
}

async function seedActiveLink(
  pool: InstanceType<typeof Pool>,
  publicToken: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO payment_links
       (workspace_owner_id, amount, currency, provider, status, public_token)
     VALUES ('__mamo_int_test__', 1000, 'USD', 'mamo', 'active', $1)`,
    [publicToken],
  );
}

async function getStatus(
  pool: InstanceType<typeof Pool>,
  publicToken: string,
): Promise<string | null> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE public_token = $1`,
    [publicToken],
  );
  return result.rows[0]?.status ?? null;
}

async function cleanupTestLinks(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM payment_links WHERE workspace_owner_id = '__mamo_int_test__'`,
  );
}

describe.skipIf(!DATABASE_URL)(
  "POST /webhooks/mamo — Mamo webhook handler (integration, real DB)",
  () => {
    let pool: InstanceType<typeof Pool>;
    const app = makeApp();

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanupTestLinks(pool);
      process.env.MAMO_API_KEY = MAMO_API_KEY;
      process.env.MAMO_WEBHOOK_SECRET = MAMO_WEBHOOK_SECRET;
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanupTestLinks(pool);
      await pool.end();
      delete process.env.MAMO_API_KEY;
      delete process.env.MAMO_WEBHOOK_SECRET;
    });

    it(
      "charge.succeeded with the correct Authorization header marks the payment_links row as paid",
      async () => {
        const publicToken = `mamo-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("charge.succeeded", publicToken);
        const res = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", MAMO_WEBHOOK_SECRET)
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });

        const status = await getStatus(pool, publicToken);
        expect(status, "payment_links row must be 'paid' after charge.succeeded").toBe("paid");
      },
    );

    it(
      "subscription.succeeded with the correct Authorization header marks the payment_links row as paid",
      async () => {
        const publicToken = `mamo-sub-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("subscription.succeeded", publicToken);
        const res = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", MAMO_WEBHOOK_SECRET)
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });

        const status = await getStatus(pool, publicToken);
        expect(
          status,
          "payment_links row must be 'paid' after subscription.succeeded",
        ).toBe("paid");
      },
    );

    it(
      "charge.failed does NOT change the payment_links row status",
      async () => {
        const publicToken = `mamo-fail-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("charge.failed", publicToken);
        const res = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", MAMO_WEBHOOK_SECRET)
          .send(body);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ received: true });

        const status = await getStatus(pool, publicToken);
        expect(status, "payment_links row must remain 'active' for charge.failed").toBe("active");
      },
    );

    it(
      "missing Authorization header returns 401 and does not change the row",
      async () => {
        const publicToken = `mamo-noauth-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("charge.succeeded", publicToken);
        const res = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .send(body);

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: expect.stringMatching(/authorization/i) });

        const status = await getStatus(pool, publicToken);
        expect(status, "payment_links row must remain 'active' when Authorization is missing").toBe(
          "active",
        );
      },
    );

    it(
      "wrong Authorization value returns 401 and does not change the row",
      async () => {
        const publicToken = `mamo-badauth-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("charge.succeeded", publicToken);
        const res = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", "wrong_secret_value_not_the_real_one")
          .send(body);

        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ error: expect.stringMatching(/authorization/i) });

        const status = await getStatus(pool, publicToken);
        expect(
          status,
          "payment_links row must remain 'active' when Authorization is wrong",
        ).toBe("active");
      },
    );

    it(
      "duplicate charge.succeeded for an already-paid link leaves it paid (idempotent)",
      async () => {
        const publicToken = `mamo-dup-int-${randomBytes(8).toString("hex")}`;
        await seedActiveLink(pool, publicToken);

        const body = mamoPayload("charge.succeeded", publicToken);

        await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", MAMO_WEBHOOK_SECRET)
          .send(body);

        const afterFirst = await getStatus(pool, publicToken);
        expect(afterFirst).toBe("paid");

        const res2 = await request(app)
          .post("/webhooks/mamo")
          .set("Content-Type", "application/json")
          .set("Authorization", MAMO_WEBHOOK_SECRET)
          .send(body);

        expect(res2.status).toBe(200);
        expect(res2.body).toEqual({ received: true });

        const afterSecond = await getStatus(pool, publicToken);
        expect(afterSecond, "row must still be 'paid' after duplicate webhook").toBe("paid");
      },
    );
  },
);
