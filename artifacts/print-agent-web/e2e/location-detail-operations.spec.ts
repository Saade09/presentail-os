import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

/**
 * End-to-end tests for the Location Detail operations dashboard.
 *
 * Covers:
 *   - All five tabs (Overview, Operations, Catalog, Team & Devices, Settings)
 *   - Pause dialog with reason → paused banner / status pill
 *   - Resume → active status restored
 *   - Settings tab save (name, daily capacity, cutoff times)
 *   - Add device → device card appears; Remove device → card disappears
 *   - Add brand (POS) → brand card appears in Catalog; Remove brand → card gone
 */

const OWNER_EMAIL = "e2e-tester@presentail.com";
const LOCATION_ID = 501;
const LOCATION_NAME = "Achrafieh POS";

const BRAND_ID = 10;
const BRAND_NAME = "Bloom";

const DEVICE_ID = 20;
const DEVICE_NAME = "Main Printer";

function makeLocation(overrides: Record<string, unknown> = {}) {
  return {
    id: LOCATION_ID,
    name: LOCATION_NAME,
    country: "Lebanon",
    location_type: "Point of Sale",
    annual_rent: null,
    rent_currency: null,
    payments_per_year: null,
    status: "active",
    daily_capacity: null,
    same_day_cutoff_time: null,
    express_cutoff_time: null,
    operating_hours: null,
    timezone: null,
    backup_location_id: null,
    backup_location_name: null,
    auto_routing_enabled: false,
    served_area_ids: null,
    paused_at: null,
    paused_by: null,
    pause_reason: null,
    internal_notes: null,
    address: null,
    ...overrides,
  };
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    name: DEVICE_NAME,
    machine_id: "abc-123",
    os: "macOS",
    agent_version: "1.2.3",
    printers: ["HP LaserJet"],
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    location_id: null,
    location_name: null,
    ...overrides,
  };
}

function ownerUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
        image_url: null,
        invite_token: null,
        assigned_locations: [],
      },
    ],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

/**
 * Registers all API mocks for the location detail page.
 *
 * @param page         Playwright page instance
 * @param locationData Initial location data returned by GET /api/locations/:id/devices
 * @param assignedBrands  Brands initially assigned to the location
 * @param assignedDevices Devices initially assigned to the location
 */
async function setupLocationRoutes(
  page: Page,
  {
    locationData = makeLocation(),
    assignedBrands = [] as Array<{ id: number; name: string; primary_logo_id: number | null }>,
    assignedDevices = [] as Array<ReturnType<typeof makeDevice>>,
  } = {},
) {
  let currentLocation = { ...locationData };
  let currentBrands = [...assignedBrands];
  let currentDevices = [...assignedDevices];

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ failedRequests: [] }) }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ownerUsersResponse()) });
  });

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );

  await page.route("**/api/time-off/notifications/events**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );

  await page.route("**/api/time-off/notifications/seen**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );

  await page.route("**/api/time-off/notifications**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [] }) });
  });

  // Location detail (devices endpoint doubles as the main location data source)
  await page.route(`**/api/locations/${LOCATION_ID}/devices**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: currentLocation, devices: currentDevices }),
    });
  });

  // Location stats
  await page.route(`**/api/locations/${LOCATION_ID}/stats**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ stats: { total_jobs: 0, total_pages: 0, recent_errors: 0 } }),
    }),
  );

  // Location brands
  await page.route(`**/api/locations/${LOCATION_ID}/brands**`, async (route) => {
    const method = route.request().method();
    const url = route.request().url();

    // DELETE /api/locations/:id/brands/:brandId
    const deleteMatch = url.match(/\/brands\/(\d+)$/);
    if (method === "DELETE" && deleteMatch) {
      const brandId = parseInt(deleteMatch[1], 10);
      currentBrands = currentBrands.filter((b) => b.id !== brandId);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }

    // POST /api/locations/:id/brands
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { brand_id: number };
      const allBrandsFlat = [{ id: BRAND_ID, name: BRAND_NAME, primary_logo_id: null }];
      const toAdd = allBrandsFlat.find((b) => b.id === body.brand_id);
      if (toAdd) currentBrands = [...currentBrands, toAdd];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }

    // GET
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: currentBrands }),
    });
  });

  // Location members
  await page.route(`**/api/locations/${LOCATION_ID}/members**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ members: [] }) }),
  );

  // Workspace-level brands (for the assign dialog)
  await page.route("**/api/brands**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [{ id: BRAND_ID, name: BRAND_NAME, primary_logo_id: null }] }),
    }),
  );

  // Workspace-level devices (for the assign dialog)
  await page.route("**/api/devices**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ devices: [makeDevice()] }),
    }),
  );

  // Products at location
  await page.route(`**/api/products/by-location/${LOCATION_ID}**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [] }) }),
  );

  // Pause endpoint
  await page.route(`**/api/locations/${LOCATION_ID}/pause**`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { reason?: string };
    currentLocation = {
      ...currentLocation,
      status: "paused",
      paused_at: new Date().toISOString(),
      paused_by: OWNER_EMAIL,
      pause_reason: body.reason ?? null,
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  // Resume endpoint
  await page.route(`**/api/locations/${LOCATION_ID}/resume**`, async (route) => {
    currentLocation = { ...currentLocation, status: "active", paused_at: null, paused_by: null, pause_reason: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  // PATCH location (Settings save) — use URL predicate to match ONLY /api/locations/:id
  // (not sub-paths like /devices, /brands, /members, etc.)
  await page.route(
    (url) => {
      const parts = url.pathname.split("/").filter(Boolean);
      // Matches exactly /api/locations/<id> with no further segments
      return parts.length === 3 && parts[0] === "api" && parts[1] === "locations" && parts[2] === String(LOCATION_ID);
    },
    async (route) => {
      if (route.request().method() === "PATCH") {
        const body = JSON.parse(route.request().postData() ?? "{}");
        currentLocation = { ...currentLocation, ...body };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ location: currentLocation }) });
        return;
      }
      await route.continue();
    },
  );

  // Device assign/unassign
  await page.route(`**/api/devices/${DEVICE_ID}/location**`, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() ?? "{}") as { location_id: number | null };
      if (body.location_id === LOCATION_ID) {
        // Assign: add device to currentDevices
        if (!currentDevices.find((d) => d.id === DEVICE_ID)) {
          currentDevices = [...currentDevices, makeDevice({ location_id: LOCATION_ID, location_name: LOCATION_NAME })];
        }
      } else {
        // Unassign
        currentDevices = currentDevices.filter((d) => d.id !== DEVICE_ID);
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.continue();
  });
}

// ──────────────────────────────────────────────────────────────────────────────

test.describe("Location Detail — operations dashboard", () => {
  test("all five tabs are reachable and render their headings", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupLocationRoutes(page);

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Overview tab is active by default
    await expect(page.getByRole("tab", { name: /Overview/i })).toBeVisible();
    await expect(page.getByTestId("location-stats")).toBeVisible();

    // Operations tab
    await page.getByRole("tab", { name: /Operations/i }).click();
    await expect(page.getByText("Cutoff Times")).toBeVisible({ timeout: 5_000 });

    // Catalog tab
    await page.getByRole("tab", { name: /Catalog/i }).click();
    await expect(page.getByText(/Products \(\d+\)/i)).toBeVisible({ timeout: 5_000 });

    // Team & Devices tab
    await page.getByRole("tab", { name: /Team & Devices/i }).click();
    await expect(page.getByText(/Devices \(\d+\)/i)).toBeVisible({ timeout: 5_000 });

    // Settings tab
    await page.getByRole("tab", { name: /^Settings/i }).click();
    await expect(page.getByText("Location Details")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("button-save-settings")).toBeVisible();
  });

  test("pause dialog accepts a reason and the paused banner + status pill appear", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupLocationRoutes(page);

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Status should start as Active
    const statusPill = page.getByTestId("location-status-pill");
    await expect(statusPill).toHaveText("Active");

    // Click the header Pause button
    const pauseBtn = page.getByTestId("button-pause-location");
    await expect(pauseBtn).toBeVisible({ timeout: 5_000 });
    await pauseBtn.click();

    // Pause dialog should open
    const pauseDialog = page.getByTestId("dialog-pause-location");
    await expect(pauseDialog).toBeVisible({ timeout: 5_000 });
    await expect(pauseDialog).toContainText(LOCATION_NAME);

    // Enter a reason
    const reasonInput = page.getByTestId("input-pause-reason");
    await expect(reasonInput).toBeVisible();
    await reasonInput.fill("Staff shortage");

    // Confirm the pause
    await page.getByTestId("button-confirm-pause").click();

    // Dialog should close
    await expect(pauseDialog).not.toBeVisible({ timeout: 8_000 });

    // Status pill should now show Paused
    await expect(statusPill).toHaveText("Paused", { timeout: 8_000 });

    // Pause banner should be visible
    const banner = page.getByTestId("location-paused-banner");
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText("This location is paused");
    await expect(banner).toContainText("Staff shortage");
  });

  test("resume location restores active status and hides the paused banner", async ({ page }) => {
    await setupClerkTestingToken({ page });

    // Start with the location already paused
    const pausedAt = new Date().toISOString();
    await setupLocationRoutes(page, {
      locationData: makeLocation({
        status: "paused",
        paused_at: pausedAt,
        paused_by: OWNER_EMAIL,
        pause_reason: "Maintenance",
      }),
    });

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Verify initially paused
    const statusPill = page.getByTestId("location-status-pill");
    await expect(statusPill).toHaveText("Paused");
    await expect(page.getByTestId("location-paused-banner")).toBeVisible();

    // Resume Location button should be visible instead of Pause
    const resumeBtn = page.getByTestId("button-resume-location");
    await expect(resumeBtn).toBeVisible({ timeout: 5_000 });
    await resumeBtn.click();

    // Status pill should revert to Active
    await expect(statusPill).toHaveText("Active", { timeout: 8_000 });

    // Pause banner should disappear
    await expect(page.getByTestId("location-paused-banner")).not.toBeVisible({ timeout: 5_000 });

    // Pause button should be back (no longer resume button)
    await expect(page.getByTestId("button-pause-location")).toBeVisible({ timeout: 5_000 });
  });

  test("settings tab saves updated name and daily capacity", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupLocationRoutes(page);

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Navigate to Settings tab
    await page.getByRole("tab", { name: /^Settings/i }).click();
    await expect(page.getByText("Location Details")).toBeVisible({ timeout: 5_000 });

    // Change the location name
    const nameInput = page.getByPlaceholder("e.g. Achrafieh POS");
    await expect(nameInput).toBeVisible();
    await nameInput.clear();
    await nameInput.fill("Gemmayzeh POS");

    // Change daily capacity
    const capacityInput = page.getByPlaceholder("e.g. 50");
    await expect(capacityInput).toBeVisible();
    await capacityInput.clear();
    await capacityInput.fill("75");

    // Change same-day cutoff
    const sameDayInput = page.getByPlaceholder("e.g. 14:00");
    await expect(sameDayInput).toBeVisible();
    await sameDayInput.clear();
    await sameDayInput.fill("15:00");

    // Save
    const saveBtn = page.getByTestId("button-save-settings");
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Toast confirmation appears (first() avoids strict-mode clash with the aria-live shadow copy)
    await expect(page.getByText("Location settings saved").first()).toBeVisible({ timeout: 8_000 });
  });

  test("add device dialog assigns a device; remove button unassigns it", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupLocationRoutes(page, { assignedDevices: [] });

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Navigate to Team & Devices tab
    await page.getByRole("tab", { name: /Team & Devices/i }).click();
    await expect(page.getByText(/Devices \(\d+\)/i)).toBeVisible({ timeout: 5_000 });

    // No devices yet
    await expect(page.getByTestId(`device-${DEVICE_ID}`)).not.toBeVisible();

    // Click "Add Device" button in the Devices card
    const addDeviceBtn = page.getByTestId("button-add-device-to-location");
    await expect(addDeviceBtn).toBeVisible({ timeout: 5_000 });
    await addDeviceBtn.click();

    // Add device dialog should open
    const addDialog = page.getByTestId("dialog-add-device");
    await expect(addDialog).toBeVisible({ timeout: 5_000 });

    // Select the device from the dropdown
    const deviceSelect = page.getByTestId("select-device");
    await deviceSelect.click();
    const deviceOption = page.getByRole("option", { name: new RegExp(DEVICE_NAME) });
    await expect(deviceOption).toBeVisible({ timeout: 5_000 });
    await deviceOption.click();

    // Confirm the assignment
    const confirmBtn = page.getByTestId("button-confirm-add-device");
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // Dialog should close
    await expect(addDialog).not.toBeVisible({ timeout: 8_000 });

    // Device card should now appear
    const deviceCard = page.getByTestId(`device-${DEVICE_ID}`);
    await expect(deviceCard).toBeVisible({ timeout: 8_000 });
    await expect(deviceCard).toContainText(DEVICE_NAME);

    // Remove the device
    const removeBtn = page.getByTestId(`button-remove-device-${DEVICE_ID}`);
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Device card should disappear
    await expect(deviceCard).not.toBeVisible({ timeout: 8_000 });
  });

  test("assign brand dialog adds a brand card in Catalog tab; remove button removes it", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupLocationRoutes(page, { assignedBrands: [] });

    await page.goto(`/locations/${LOCATION_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: LOCATION_NAME })).toBeVisible({ timeout: 15_000 });

    // Navigate to Catalog tab
    await page.getByRole("tab", { name: /Catalog/i }).click();
    await expect(page.getByText(/Brands \(\d+\)/i)).toBeVisible({ timeout: 5_000 });

    // No brands yet
    await expect(page.getByTestId(`location-brand-${BRAND_ID}`)).not.toBeVisible();
    await expect(page.getByText("No brands assigned")).toBeVisible();

    // Click "Add Brand" button within the Catalog tab brands card
    const addBrandCatalogBtn = page.getByRole("button", { name: /Add Brand/i }).first();
    await expect(addBrandCatalogBtn).toBeVisible({ timeout: 5_000 });
    await addBrandCatalogBtn.click();

    // Add brand dialog should open
    const brandDialog = page.getByTestId("dialog-add-brand");
    await expect(brandDialog).toBeVisible({ timeout: 5_000 });

    // Select the brand from the dropdown
    const brandSelect = page.getByTestId("select-brand-to-add");
    await brandSelect.click();
    const brandOption = page.getByRole("option", { name: BRAND_NAME });
    await expect(brandOption).toBeVisible({ timeout: 5_000 });
    await brandOption.click();

    // Confirm the assignment
    const confirmBrandBtn = page.getByTestId("button-confirm-add-brand");
    await expect(confirmBrandBtn).toBeEnabled();
    await confirmBrandBtn.click();

    // Dialog should close
    await expect(brandDialog).not.toBeVisible({ timeout: 8_000 });

    // Brand card should appear in the Catalog tab
    const brandCard = page.getByTestId(`location-brand-${BRAND_ID}`);
    await expect(brandCard).toBeVisible({ timeout: 8_000 });
    await expect(brandCard).toContainText(BRAND_NAME);

    // Remove the brand
    const removeBrandBtn = page.getByTestId(`button-remove-brand-${BRAND_ID}`);
    await expect(removeBrandBtn).toBeVisible();
    await removeBrandBtn.click();

    // Brand card should disappear
    await expect(brandCard).not.toBeVisible({ timeout: 8_000 });
  });
});
