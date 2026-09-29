import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER = `__real_deliveries_${process.pid}__`;
const { copyPrivateImageToPublicSanitized } = vi.hoisted(() => ({
  copyPrivateImageToPublicSanitized: vi.fn(
    async (_source: string, key: string) => `${key}.jpg`,
  ),
}));
vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { userId: string }).userId = OWNER; next();
  },
}));
vi.mock("../lib/objectStorage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/objectStorage")>();
  return {
    ...original,
    objectStorageService: {
      ...original.objectStorageService,
      copyPrivateImageToPublicSanitized,
      deletePublicObject: vi.fn(async () => undefined),
    },
  };
});
import router from "./realDeliveries";
import { initDb } from "../lib/initDb";
import {
  backfillRealDeliveryPublications,
  processRealDeliveryPublications,
} from "../lib/realDeliveryPublication";

describe.skipIf(!DATABASE_URL)("real deliveries PostgreSQL eligibility", () => {
  let pool: InstanceType<typeof Pool>;
  let cityId: number, locationId: number, categoryId: number, productId: number, baseItemId: number;
  const app = express();
  app.use(router);
  const ids: string[] = [];
  beforeAll(async () => {
    await initDb();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id=$1`, [OWNER]);
    await pool.query(`DELETE FROM products WHERE workspace_owner_id=$1`, [OWNER]);
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id=$1`, [OWNER]);
    await pool.query(`DELETE FROM catalog_categories WHERE workspace_owner_id=$1`, [OWNER]);
    const city = await pool.query(`INSERT INTO delivery_cities(workspace_owner_id,country_code,name,slug,is_active) VALUES($1,'LB','Beirut','beirut',true) RETURNING id`, [OWNER]); cityId = city.rows[0].id;
    await pool.query(`INSERT INTO delivery_cities(workspace_owner_id,country_code,name,slug,is_active) VALUES($1,'AE','Beirut','beirut-ae',true)`, [OWNER]);
    const loc = await pool.query(`INSERT INTO locations(workspace_owner_id,name,country) VALUES($1,'Beirut florist','Lebanon') RETURNING id`, [OWNER]); locationId = loc.rows[0].id;
    const cat = await pool.query(`INSERT INTO catalog_categories(workspace_owner_id,name,slug,is_active) VALUES($1,'Flowers','flowers',true) RETURNING id`, [OWNER]); categoryId = cat.rows[0].id;
    const base = await pool.query(`INSERT INTO base_items(workspace_owner_id,name,code) VALUES($1,'Rose','RD-ROSE') RETURNING id`, [OWNER]); baseItemId = base.rows[0].id;
    const product = await pool.query(`INSERT INTO products(workspace_owner_id,name,status,is_archived) VALUES($1,'Roses','available',false) RETURNING id`, [OWNER]); productId = product.rows[0].id;
    await pool.query(`INSERT INTO product_catalog_categories(product_id,attribute_id) VALUES($1,$2)`, [productId, categoryId]);
    await pool.query(`INSERT INTO product_recipes(workspace_owner_id,product_id,base_item_id,quantity) VALUES($1,$2,$3,2)`, [OWNER, productId, baseItemId]);
    await pool.query(`INSERT INTO base_item_location_costs(workspace_owner_id,base_item_id,location_id,total_units_on_hand) VALUES($1,$2,$3,2)`, [OWNER, baseItemId, locationId]);
    for (let i = 0; i < 3; i++) {
      const order = await pool.query(`INSERT INTO orders(workspace_owner_id,status,delivery_address) VALUES($1,'completed',jsonb_build_object('cityId',$2::text,'countryCode','LB')) RETURNING id`, [OWNER, cityId]);
      ids.push(order.rows[0].id);
      const assignment = await pool.query(`INSERT INTO order_florist_assignments(workspace_owner_id,order_id,location_id,photo_items_path,photo_set_rev,verification_status) VALUES($1,$2,$3,$4,1,'approved') RETURNING id`, [OWNER, order.rows[0].id, locationId, `/objects/photo-${i}`]);
      await pool.query(`INSERT INTO order_line_items(order_id,product_id,name) VALUES($1,$2,'Roses')`, [order.rows[0].id, productId]);
       await pool.query(`INSERT INTO florist_photo_publications(workspace_owner_id,assignment_id,photo_set_rev,source_photo_path,publication_status,enabled,automatic,public_asset_key) VALUES($1,$2,1,$3,'ready',true,false,$4)`, [OWNER, assignment.rows[0].id, `/objects/photo-${i}`, `real-deliveries/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${i}.jpg`]);
    }
  });
  afterAll(async () => { if (pool) { await pool.query(`DELETE FROM orders WHERE workspace_owner_id=$1`, [OWNER]); await pool.query(`DELETE FROM products WHERE workspace_owner_id=$1`, [OWNER]); await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id=$1`, [OWNER]); await pool.query(`DELETE FROM catalog_categories WHERE workspace_owner_id=$1`, [OWNER]); await pool.end(); } });

  it("supports optional location filters without requiring a minimum collection size", async () => {
    expect((await request(app).get("/storefront/real-deliveries")).body.photos).toHaveLength(3);
    expect((await request(app).get("/storefront/real-deliveries?country=LB&city=Beirut")).body.photos).toHaveLength(3);
    await pool.query(`UPDATE orders SET delivery_address='{}'::jsonb WHERE id=$1`, [ids[0]]);
    expect((await request(app).get("/storefront/real-deliveries?country=LB&city=Beirut")).body.photos).toHaveLength(2);
    expect((await request(app).get("/storefront/real-deliveries")).body.photos).toHaveLength(3);
    await pool.query(`UPDATE orders SET delivery_address=jsonb_build_object('cityId',$1::text,'countryCode','LB') WHERE id=$2`, [cityId, ids[0]]);
  });

  it("trigger disables a prior publication when the photo revision changes", async () => {
    await pool.query(`UPDATE order_florist_assignments SET photo_set_rev=photo_set_rev+1, photo_items_path='/objects/replaced' WHERE order_id=$1`, [ids[1]]);
    const publication = await pool.query(`SELECT publication_status FROM florist_photo_publications f JOIN order_florist_assignments a ON a.id=f.assignment_id WHERE a.order_id=$1`, [ids[1]]);
    expect(publication.rows[0].publication_status).toBe("stale");
  });

  it("registers either approval/completion order without publishing until explicitly enabled", async () => {
    copyPrivateImageToPublicSanitized.mockClear();

    const createLifecycleFixture = async (
      status: "preparing" | "completed",
      verificationStatus: "rejected" | "approved",
      suffix: string,
    ) => {
      const order = await pool.query(
        `INSERT INTO orders(workspace_owner_id,status,delivery_address)
         VALUES($1,$2,jsonb_build_object('cityId',$3::text,'countryCode','LB'))
         RETURNING id`,
        [OWNER, status, cityId],
      );
      const orderId = order.rows[0].id as string;
      ids.push(orderId);
      const assignment = await pool.query(
        `INSERT INTO order_florist_assignments
           (workspace_owner_id,order_id,location_id,photo_items_path,photo_set_rev,verification_status)
         VALUES($1,$2,$3,$4,1,$5)
         RETURNING id`,
        [OWNER, orderId, locationId, `/objects/lifecycle-${suffix}`, verificationStatus],
      );
      await pool.query(
        `INSERT INTO order_line_items(order_id,product_id,name) VALUES($1,$2,'Roses')`,
        [orderId, productId],
      );
      return { orderId, assignmentId: assignment.rows[0].id as number };
    };

    const approvalFirst = await createLifecycleFixture("preparing", "approved", "approval-first");
    await pool.query(`UPDATE orders SET status='completed' WHERE id=$1`, [approvalFirst.orderId]);
    await processRealDeliveryPublications(pool, 10);

    const completionFirst = await createLifecycleFixture("completed", "rejected", "completion-first");
    await pool.query(
      `UPDATE order_florist_assignments SET verification_status='approved' WHERE id=$1`,
      [completionFirst.assignmentId],
    );
    await processRealDeliveryPublications(pool, 10);

    const backfilled = await createLifecycleFixture("completed", "approved", "backfill");
    await backfillRealDeliveryPublications(pool);
    await backfillRealDeliveryPublications(pool);
    const backfillCount = await pool.query(
      `SELECT count(*)::int AS count
         FROM florist_photo_publications
        WHERE assignment_id=$1 AND photo_set_rev=1`,
      [backfilled.assignmentId],
    );
    expect(backfillCount.rows[0].count).toBe(1);
    await processRealDeliveryPublications(pool, 10);

    const pending = await pool.query(
      `SELECT publication_status, enabled, automatic
         FROM florist_photo_publications
        WHERE assignment_id = ANY($1::int[])`,
      [[approvalFirst.assignmentId, completionFirst.assignmentId, backfilled.assignmentId]],
    );
    expect(pending.rows.every((row) =>
      row.publication_status === "pending" && row.enabled === false && row.automatic === false,
    )).toBe(true);

    await pool.query(
      `UPDATE florist_photo_publications
          SET enabled=true, privacy_faces_clear=true, privacy_card_message_clear=true,
              privacy_address_clear=true, privacy_other_personal_info_clear=true,
              next_attempt_at=now()
        WHERE assignment_id = ANY($1::int[])`,
      [[approvalFirst.assignmentId, completionFirst.assignmentId, backfilled.assignmentId]],
    );
    await processRealDeliveryPublications(pool, 10);
    const statuses = await pool.query(
       `SELECT assignment_id, publication_status, enabled, automatic, public_asset_key
         FROM florist_photo_publications
        WHERE assignment_id = ANY($1::int[])
        ORDER BY assignment_id`,
      [[approvalFirst.assignmentId, completionFirst.assignmentId, backfilled.assignmentId]],
    );
    expect(statuses.rows).toHaveLength(3);
    expect(statuses.rows.every((row) =>
      row.publication_status === "ready"
      && row.enabled === true
      && row.automatic === false
      && /^real-deliveries\/[0-9a-f-]+\.jpg$/.test(row.public_asset_key),
    )).toBe(true);
    expect(copyPrivateImageToPublicSanitized.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Keep the threshold table tests below isolated to the original three
    // baseline orders.
    await pool.query(
      `DELETE FROM orders WHERE id = ANY($1::uuid[])`,
      [[approvalFirst.orderId, completionFirst.orderId, backfilled.orderId]],
    );
  });

  it("does not let an old poison backlog starve a newer publishable photo", async () => {
    await pool.query(
      `INSERT INTO orders(workspace_owner_id,status,delivery_address)
       SELECT $1,'completed',
              jsonb_build_object('cityId',$2::text,'countryCode','LB','fairnessFixture',g)
         FROM generate_series(1,21) g`,
      [OWNER, cityId],
    );
    await pool.query(
      `INSERT INTO order_florist_assignments
        (workspace_owner_id,order_id,location_id,photo_items_path,photo_set_rev,verification_status)
       SELECT $1,o.id,$2,
              CASE WHEN (o.delivery_address->>'fairnessFixture')::int <= 20
                   THEN '/objects/poison-' || (o.delivery_address->>'fairnessFixture')
                   ELSE '/objects/healthy' END,
              1,'approved'
         FROM orders o
        WHERE o.workspace_owner_id=$1 AND o.delivery_address ? 'fairnessFixture'`,
      [OWNER, locationId],
    );
    await pool.query(
      `INSERT INTO florist_photo_publications
        (workspace_owner_id,assignment_id,photo_set_rev,source_photo_path,
         publication_status,enabled,automatic,next_attempt_at,created_at)
       SELECT $1,a.id,1,a.photo_items_path,
              CASE WHEN a.photo_items_path='/objects/healthy' THEN 'pending' ELSE 'failed' END,
              true,false,
              CASE WHEN a.photo_items_path='/objects/healthy' THEN now() ELSE now()-interval '1 hour' END,
              CASE WHEN a.photo_items_path='/objects/healthy' THEN now() ELSE now()-interval '2 hours' END
         FROM order_florist_assignments a
         JOIN orders o ON o.id=a.order_id
        WHERE o.workspace_owner_id=$1 AND o.delivery_address ? 'fairnessFixture'`,
      [OWNER],
    );

    copyPrivateImageToPublicSanitized.mockImplementation(async (source: string, key: string) => {
      if (source.includes("/poison-")) throw new Error("missing legacy object");
      return `${key}.jpg`;
    });
    try {
      for (let tick = 0; tick < 4; tick++) {
        await processRealDeliveryPublications(pool, 10);
      }
      const healthy = await pool.query(
        `SELECT f.publication_status
           FROM florist_photo_publications f
           JOIN order_florist_assignments a ON a.id=f.assignment_id
          WHERE a.photo_items_path='/objects/healthy' AND a.workspace_owner_id=$1`,
        [OWNER],
      );
      expect(healthy.rows[0]?.publication_status).toBe("ready");
    } finally {
      copyPrivateImageToPublicSanitized.mockImplementation(
        async (_source: string, key: string) => `${key}.jpg`,
      );
      await pool.query(
        `DELETE FROM orders
          WHERE workspace_owner_id=$1 AND delivery_address ? 'fairnessFixture'`,
        [OWNER],
      );
    }
  });

  it("keeps photos eligible across product merchandising changes while preserving safety gates", async () => {
    // Reset the row altered by the trigger test before table-driving isolated
    // mutations. Each case changes exactly one gate and restores it in finally.
    await pool.query(
      `DELETE FROM florist_photo_publications f
        USING order_florist_assignments a
        WHERE f.assignment_id=a.id AND a.order_id=$1`,
      [ids[1]],
    );
    await pool.query(`UPDATE order_florist_assignments SET photo_set_rev=1,photo_items_path='/objects/photo-1',verification_status='approved' WHERE order_id=$1`, [ids[1]]);
    await pool.query(
      `INSERT INTO florist_photo_publications
        (workspace_owner_id,assignment_id,photo_set_rev,source_photo_path,publication_status,enabled,automatic,public_asset_key)
       SELECT $1,id,1,'/objects/photo-1','ready',true,true,
              'real-deliveries/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1.jpg'
         FROM order_florist_assignments WHERE order_id=$2
       ON CONFLICT (assignment_id,photo_set_rev) DO UPDATE
         SET source_photo_path=EXCLUDED.source_photo_path,
             publication_status='ready',
              enabled=true,
             automatic=true,
             public_asset_key=EXCLUDED.public_asset_key`,
      [OWNER, ids[1]],
    );
    const photoCountAfter = async (
      mutate: () => Promise<void>,
      restore: () => Promise<void>,
      expected: number,
    ) => {
      try {
        await mutate();
        const response = await request(app).get("/storefront/real-deliveries");
        expect(response.status).toBe(200);
        expect(response.body.photos).toHaveLength(expected);
      } finally { await restore(); }
    };
    await photoCountAfter(
      () => pool.query(`UPDATE florist_photo_publications f SET photo_set_rev=9 FROM order_florist_assignments a WHERE f.assignment_id=a.id AND a.order_id=$1`, [ids[0]]).then(() => undefined),
      () => pool.query(`UPDATE florist_photo_publications f SET photo_set_rev=1 FROM order_florist_assignments a WHERE f.assignment_id=a.id AND a.order_id=$1`, [ids[0]]).then(() => undefined),
      2,
    );
    await photoCountAfter(
      () => pool.query(`UPDATE florist_photo_publications f SET source_photo_path='/objects/stale' FROM order_florist_assignments a WHERE f.assignment_id=a.id AND a.order_id=$1`, [ids[0]]).then(() => undefined),
      () => pool.query(`UPDATE florist_photo_publications f SET source_photo_path='/objects/photo-0' FROM order_florist_assignments a WHERE f.assignment_id=a.id AND a.order_id=$1`, [ids[0]]).then(() => undefined),
      2,
    );
    await photoCountAfter(
      () => pool.query(`UPDATE order_florist_assignments SET verification_status='rejected' WHERE order_id=$1`, [ids[0]]).then(() => undefined),
      async () => {
        await pool.query(`UPDATE order_florist_assignments SET verification_status='approved' WHERE order_id=$1`, [ids[0]]);
        await pool.query(`UPDATE florist_photo_publications f SET publication_status='ready',enabled=true,source_photo_path='/objects/photo-0',photo_set_rev=1 FROM order_florist_assignments a WHERE f.assignment_id=a.id AND a.order_id=$1`, [ids[0]]);
      },
      2,
    );
    await photoCountAfter(
      () => pool.query(`UPDATE orders SET status='preparing' WHERE id=$1`, [ids[0]]).then(() => undefined),
      () => pool.query(`UPDATE orders SET status='completed' WHERE id=$1`, [ids[0]]).then(() => undefined),
      2,
    );
    await photoCountAfter(
      () => pool.query(`DELETE FROM order_line_items WHERE order_id=$1`, [ids[0]]).then(() => undefined),
      () => pool.query(`INSERT INTO order_line_items(order_id,product_id,name) VALUES($1,$2,'Roses')`, [ids[0], productId]).then(() => undefined),
      3,
    );
    const second = await pool.query(`INSERT INTO products(workspace_owner_id,name,status,is_archived) VALUES($1,'More roses','available',false) RETURNING id`, [OWNER]);
    try {
      await pool.query(`INSERT INTO order_line_items(order_id,product_id,name) VALUES($1,$2,'More roses')`, [ids[0], second.rows[0].id]);
      const linked = await request(app).get("/storefront/real-deliveries");
      const target = linked.body.photos.find((photo: { products: Array<{ id: number }> }) =>
        photo.products.some((product) => product.id === second.rows[0].id),
      );
      expect(target.products.map((product: { id: number }) => product.id)).toEqual(
        expect.arrayContaining([productId, second.rows[0].id]),
      );
    } finally {
      await pool.query(`DELETE FROM order_line_items WHERE product_id=$1`, [second.rows[0].id]);
      await pool.query(`DELETE FROM products WHERE id=$1`, [second.rows[0].id]);
    }
    for (const [sql, undo] of [
      [`INSERT INTO product_country_availability(product_id,country_code,is_available) VALUES(${productId},'LB',false)`, `DELETE FROM product_country_availability WHERE product_id=${productId} AND country_code='LB'`],
      [`INSERT INTO product_city_availability(product_id,city_id,is_available) VALUES(${productId},${cityId},false)`, `DELETE FROM product_city_availability WHERE product_id=${productId} AND city_id=${cityId}`],
      [`INSERT INTO product_location_statuses(workspace_owner_id,product_id,location_id,is_active) VALUES('${OWNER}',${productId},${locationId},false)`, `DELETE FROM product_location_statuses WHERE product_id=${productId} AND location_id=${locationId}`],
      [`DELETE FROM product_recipes WHERE product_id=${productId}`, `INSERT INTO product_recipes(workspace_owner_id,product_id,base_item_id,quantity) VALUES('${OWNER}',${productId},${baseItemId},2)`],
      [`UPDATE base_item_location_costs SET total_units_on_hand=1 WHERE base_item_id=${baseItemId} AND location_id=${locationId}`, `UPDATE base_item_location_costs SET total_units_on_hand=2 WHERE base_item_id=${baseItemId} AND location_id=${locationId}`],
      [`INSERT INTO catalog_category_city_availability(catalog_category_id,city_id,is_enabled) VALUES(${categoryId},${cityId},false)`, `DELETE FROM catalog_category_city_availability WHERE catalog_category_id=${categoryId} AND city_id=${cityId}`],
    ]) await photoCountAfter(
      () => pool.query(sql).then(() => undefined),
      () => pool.query(undo).then(() => undefined),
      3,
    );
  });
});