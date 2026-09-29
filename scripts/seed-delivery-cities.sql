-- Seed production delivery cities for Lebanon, UAE, and Cyprus
-- Task #1943
-- Run this against the production database after the latest code is deployed

-- 1. Add workspace_slug column (if not exists from initDb.ts)
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS workspace_slug text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspace_settings_workspace_slug_unique'
  ) THEN
    ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_workspace_slug_unique UNIQUE (workspace_slug);
  END IF;
END $$;

-- 2. Set workspace slug for the Presentail workspace
UPDATE workspace_settings SET workspace_slug = 'presentail' WHERE workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR';

-- 3. Seed delivery_country_settings (upsert)
INSERT INTO delivery_country_settings (workspace_owner_id, country_code, delivery_active, delivery_sort_order)
VALUES
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', true, 0),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', true, 1),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', true, 2)
ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
  SET delivery_active = true,
      delivery_sort_order = EXCLUDED.delivery_sort_order,
      updated_at = now();

-- 4. Seed Lebanon cities (26 cities)
INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
VALUES
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Akkar', 'akkar', 0, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Aley', 'aley', 1, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Baabda', 'baabda', 2, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Baalbeck', 'baalbeck', 3, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Batroun', 'batroun', 4, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Bcharee', 'bcharee', 5, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Beirut', 'beirut', 6, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Bent Jbeil', 'bent-jbeil', 7, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Chouf', 'chouf', 8, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Hasbaya', 'hasbaya', 9, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Hermel', 'hermel', 10, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Jbeil', 'jbeil', 11, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Jezzine', 'jezzine', 12, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Kesserwan', 'kesserwan', 13, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Koura', 'koura', 14, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Marjayoun', 'marjayoun', 15, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Metn', 'metn', 16, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Minnieh-Dennaye', 'minnieh-dennaye', 17, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Nabatieh', 'nabatieh', 18, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Rachaya', 'rachaya', 19, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Saida', 'saida', 20, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Tripoli', 'tripoli', 21, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Tyre', 'tyre', 22, false),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'West Bekaa', 'west-bekaa', 23, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Zahle', 'zahle', 24, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'LB', 'Zghorta', 'zghorta', 25, true)
ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
  SET name = EXCLUDED.name,
      sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active,
      updated_at = now();

-- 5. Seed UAE cities (8 cities)
INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
VALUES
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Abu Dhabi', 'abu-dhabi', 0, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Ajman', 'ajman', 1, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Al Ain', 'al-ain', 2, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Dubai', 'dubai', 3, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Fujairah', 'fujairah', 4, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Ras Al Khaimah', 'ras-al-khaimah', 5, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Sharjah', 'sharjah', 6, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'AE', 'Umm Al Quwain', 'umm-al-quwain', 7, false)
ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
  SET name = EXCLUDED.name,
      sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active,
      updated_at = now();

-- 6. Seed Cyprus cities (5 cities, all active)
INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug, sort_order, is_active)
VALUES
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', 'Nicosia', 'nicosia', 0, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', 'Larnaca', 'larnaca', 1, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', 'Paphos', 'paphos', 2, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', 'Limassol', 'limassol', 3, true),
  ('user_3DCcbYtdoRYrTOqHwKxb1gwXxJR', 'CY', 'Ammachostos', 'ammachostos', 4, true)
ON CONFLICT (workspace_owner_id, country_code, slug) DO UPDATE
  SET name = EXCLUDED.name,
      sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active,
      updated_at = now();
