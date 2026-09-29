#!/usr/bin/env node
/**
 * Seed production delivery cities for Lebanon, UAE, and Cyprus.
 * Task #1943
 *
 * Run with: node scripts/seed-delivery-cities.js
 */

const { db } = require("./artifacts/api-server/src/lib/db.js");

const OWNER_ID = "user_3DCcbYtdoRYrTOqHwKxb1gwXxJR";

const LEBANON_CITIES = [
  { name: "Akkar", is_active: true },
  { name: "Aley", is_active: true },
  { name: "Baabda", is_active: true },
  { name: "Baalbeck", is_active: false },
  { name: "Batroun", is_active: true },
  { name: "Bcharee", is_active: true },
  { name: "Beirut", is_active: true },
  { name: "Bent Jbeil", is_active: false },
  { name: "Chouf", is_active: true },
  { name: "Hasbaya", is_active: false },
  { name: "Hermel", is_active: false },
  { name: "Jbeil", is_active: true },
  { name: "Jezzine", is_active: false },
  { name: "Kesserwan", is_active: true },
  { name: "Koura", is_active: true },
  { name: "Marjayoun", is_active: false },
  { name: "Metn", is_active: true },
  { name: "Minnieh-Dennaye", is_active: true },
  { name: "Nabatieh", is_active: false },
  { name: "Rachaya", is_active: true },
  { name: "Saida", is_active: true },
  { name: "Tripoli", is_active: true },
  { name: "Tyre", is_active: false },
  { name: "West Bekaa", is_active: true },
  { name: "Zahle", is_active: true },
  { name: "Zghorta", is_active: true },
];

const UAE_CITIES = [
  { name: "Abu Dhabi", is_active: true },
  { name: "Ajman", is_active: true },
  { name: "Al Ain", is_active: true },
  { name: "Dubai", is_active: true },
  { name: "Fujairah", is_active: true },
  { name: "Ras Al Khaimah", is_active: true },
  { name: "Sharjah", is_active: true },
  { name: "Umm Al Quwain", is_active: false },
];

const CYPRUS_CITIES = [
  { name: "Nicosia", is_active: true },
  { name: "Larnaca", is_active: true },
  { name: "Paphos", is_active: true },
  { name: "Limassol", is_active: true },
  { name: "Ammachostos", is_active: true },
];

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function seed() {
  console.log("Seeding delivery cities for workspace:", OWNER_ID);

  // 1. Set workspace slug to 'presentail'
  console.log("\n1. Setting workspace slug...");
  await db.query(
    `UPDATE workspace_settings SET workspace_slug = 'presentail' WHERE workspace_owner_id = $1`,
    [OWNER_ID]
  );
  console.log("   Workspace slug set to 'presentail'");

  // 2. Seed delivery_country_settings for all 3 countries
  console.log("\n2. Seeding delivery_country_settings...");
  const countries = [
    { code: "LB", sort_order: 0 },
    { code: "AE", sort_order: 1 },
    { code: "CY", sort_order: 2 },
  ];
  for (const c of countries) {
    await db.query(
      `INSERT INTO delivery_country_settings (workspace_owner_id, country_code, delivery_active, delivery_sort_order)
       VALUES ($1, $2, true, $3)
       ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
         SET delivery_active = true,
             delivery_sort_order = EXCLUDED.delivery_sort_order,
             updated_at = now()`,
      [OWNER_ID, c.code, c.sort_order]
    );
    console.log(`   ${c.code}: delivery_active=true, sort_order=${c.sort_order}`);
  }

  // 3. Seed Lebanon cities
  console.log("\n3. Seeding Lebanon cities...");
  for (let i = 0; i < LEBANON_CITIES.length; i++) {
    const city = LEBANON_CITIES[i];
    const slug = slugify(city.name);
    await db.query(
      `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
       VALUES ($1, 'LB', $2, $3, $4, $5)
       ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
         SET name = EXCLUDED.name,
             sort_order = EXCLUDED.sort_order,
             is_active = EXCLUDED.is_active,
             updated_at = now()`,
      [OWNER_ID, city.name, slug, i, city.is_active]
    );
    console.log(`   ${city.name} (sort=${i}, active=${city.is_active})`);
  }

  // 4. Seed UAE cities
  console.log("\n4. Seeding UAE cities...");
  for (let i = 0; i < UAE_CITIES.length; i++) {
    const city = UAE_CITIES[i];
    const slug = slugify(city.name);
    await db.query(
      `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
       VALUES ($1, 'AE', $2, $3, $4, $5)
       ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
         SET name = EXCLUDED.name,
             sort_order = EXCLUDED.sort_order,
             is_active = EXCLUDED.is_active,
             updated_at = now()`,
      [OWNER_ID, city.name, slug, i, city.is_active]
    );
    console.log(`   ${city.name} (sort=${i}, active=${city.is_active})`);
  }

  // 5. Seed Cyprus cities
  console.log("\n5. Seeding Cyprus cities...");
  for (let i = 0; i < CYPRUS_CITIES.length; i++) {
    const city = CYPRUS_CITIES[i];
    const slug = slugify(city.name);
    await db.query(
      `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
       VALUES ($1, 'CY', $2, $3, $4, $5)
       ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
         SET name = EXCLUDED.name,
             sort_order = EXCLUDED.sort_order,
             is_active = EXCLUDED.is_active,
             updated_at = now()`,
      [OWNER_ID, city.name, slug, i, city.is_active]
    );
    console.log(`   ${city.name} (sort=${i}, active=${city.is_active})`);
  }

  console.log("\nDone!");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
