import { test, expect } from "./fixtures";
import {
  setupFapiWithFakeSession,
  FAPI_HOST,
} from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec.  All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient and
// avoids any dependency on the live FAPI host (clerk.presentail.com) or a
// real .auth-session.json written by global-setup.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const SEED_PHONE = "+96171900001";

const API_BASE = process.env.API_SERVER_URL ?? "http://localhost:8080";

// ── Node-side test-helper calls (no browser auth needed) ────────────────────

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
}

async function getDriverCount(phone: string): Promise<number> {
  const url = new URL(`${API_BASE}/api/test/driver/count`);
  url.searchParams.set("ownerEmail", OWNER_EMAIL);
  url.searchParams.set("phone", phone);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`driver/count → ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { count: number }).count;
}

// ── Mock data ────────────────────────────────────────────────────────────────

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
      },
    ],
    me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
  };
}

const MOCK_VEHICLE_TYPES = {
  vehicle_types: [{ id: 1, name: "Car", is_active: true }],
};

function seedDriverObject(id: number) {
  return {
    id,
    first_name: "Seed",
    last_name: "Driver",
    phone: SEED_PHONE,
    taxi_company: null,
    vehicle_type: "Car",
    license_number: null,
    status: "active",
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    onboarding_status: "pending",
    availability_status: "offline",
  };
}

// ── Page setup helper ────────────────────────────────────────────────────────

/**
 * Mocks all API routes the Fleet page needs.
 *
 * Note: no setupClerkTestingToken call is needed here because
 * setupFapiWithFakeSession (installed via the test.use() override above)
 * already intercepts all FAPI calls, so the __clerk_testing_token query
 * param is never forwarded to the real Clerk FAPI.
 *
 * @param driversToReturn  What GET /api/fleet/drivers should return.
 *                         Pass the seed driver to trigger the client-side guard;
 *                         pass [] to force the form to call POST (server-side path).
 * @param onPost           Optional handler for POST /api/fleet/drivers.
 *                         Defaults to returning 409 DUPLICATE_PHONE.
 */
async function setupFleetPage(
  page: import("@playwright/test").Page,
  opts: {
    seedDriverId: number;
    driversToReturn: ReturnType<typeof seedDriverObject>[];
    onPost?: (body: unknown) => { status: number; body: unknown };
  },
) {
  // Auth / workspace endpoints
  await page.route("**/api/users**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    }),
  );
  await page.route("**/api/roles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roles: [] }),
    }),
  );
  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ seen: [] }),
    }),
  );
  await page.route("**/api/time-off/notifications**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, notifications: [] }),
    }),
  );
  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  // Fleet endpoints
  await page.route("**/api/fleet/vehicle-types**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_VEHICLE_TYPES),
    }),
  );
  await page.route("**/api/fleet/taxi-companies**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ taxi_companies: [] }),
    }),
  );

  // GET /api/fleet/drivers — used for the drivers list and client-side check
  await page.route(
    (url) => url.pathname.startsWith("/api/fleet/drivers"),
    async (route) => {
      const method = route.request().method();

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ drivers: opts.driversToReturn }),
        });
        return;
      }

      if (method === "POST") {
        const postBody = route.request().postDataJSON() as unknown;
        const handler =
          opts.onPost ??
          (() => ({
            status: 409,
            body: { code: "DUPLICATE_PHONE", message: "A driver with this phone number already exists." },
          }));
        const result = handler(postBody);
        await route.fulfill({
          status: result.status,
          contentType: "application/json",
          body: JSON.stringify(result.body),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Suppress the unused-import lint warning: FAPI_HOST is imported for
// documentation purposes to make the test.use() fixture override more
// self-describing (readers can see which FAPI host is being bypassed).
void FAPI_HOST;

let seededDriverId: number;

test.describe("Fleet — Add Driver duplicate phone guard (DB-backed)", () => {
  test.beforeAll(async () => {
    const data = (await apiPost("/api/test/driver", {
      ownerEmail: OWNER_EMAIL,
      firstName: "Seed",
      lastName: "Driver",
      phone: SEED_PHONE,
      vehicleType: "Car",
    })) as { id: number };
    seededDriverId = data.id;
  });

  test.afterAll(async () => {
    if (seededDriverId !== undefined) {
      await apiDelete(`/api/test/driver/${seededDriverId}`).catch(() => {});
    }
  });

  test(
    "client-side guard: duplicate phone shows inline error without hitting the server",
    async ({ page }) => {
      await setupFleetPage(page, {
        seedDriverId: seededDriverId,
        // Return the seeded driver so the client-side existingDrivers check
        // catches the duplicate before any server call is made.
        driversToReturn: [seedDriverObject(seededDriverId)],
        // If POST is ever called it should NOT succeed.
        onPost: () => ({
          status: 500,
          body: { error: "POST should not be reached in client-side guard test" },
        }),
      });

      await page.goto("/fleet", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible({ timeout: 15_000 });

      // Confirm the page rendered the seeded driver from the mocked list.
      await expect(page.getByText("Seed Driver", { exact: false })).toBeVisible({
        timeout: 15_000,
      });

      // Open the Add Driver dialog.
      await page.getByRole("button", { name: /add driver/i }).first().click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Fill in a different name but the same phone number.
      await page.getByLabel(/first name/i).fill("Duplicate");
      await page.getByLabel(/last name/i).fill("User");

      // PhoneInput renders a plain <input> with class PhoneInputInput;
      // scoping to the dialog avoids any other phone inputs on the page.
      const phoneInput = dialog.locator(".PhoneInputInput");
      await phoneInput.fill("71900001");

      // Wait for the button to be enabled (first/last name filled).
      const addButton = dialog.getByRole("button", { name: /add driver/i });
      await expect(addButton).toBeEnabled({ timeout: 5_000 });
      await addButton.click();

      // The client-side guard should show the inline error immediately.
      const phoneError = page.getByTestId("phone-error");
      await expect(phoneError).toBeVisible({ timeout: 8_000 });
      await expect(phoneError).toHaveText(
        "A driver with this phone number already exists.",
      );

      // The dialog must remain open (not dismissed on error).
      await expect(dialog).toBeVisible();

      // DB must still have exactly one driver with this phone (no second one created).
      const count = await getDriverCount(SEED_PHONE);
      expect(count).toBe(1);
    },
  );

  test(
    "server-side guard: 409 DUPLICATE_PHONE response shows inline error and keeps dialog open",
    async ({ page }) => {
      await setupFleetPage(page, {
        seedDriverId: seededDriverId,
        // Empty driver list bypasses the client-side check so the form
        // actually calls POST, letting us exercise the 409 error path.
        driversToReturn: [],
        onPost: () => ({
          status: 409,
          body: { code: "DUPLICATE_PHONE", message: "A driver with this phone number already exists." },
        }),
      });

      await page.goto("/fleet", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Fleet" })).toBeVisible({ timeout: 15_000 });

      // Page loads with empty driver list — show the empty state text.
      await expect(page.getByText(/no drivers yet/i)).toBeVisible({
        timeout: 15_000,
      });

      // Open the Add Driver dialog.
      await page.getByRole("button", { name: /add driver/i }).first().click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      await page.getByLabel(/first name/i).fill("Duplicate");
      await page.getByLabel(/last name/i).fill("User");

      const phoneInput = dialog.locator(".PhoneInputInput");
      await phoneInput.fill("71900001");

      const addButton = dialog.getByRole("button", { name: /add driver/i });
      await expect(addButton).toBeEnabled({ timeout: 5_000 });
      await addButton.click();

      // The mocked POST returns 409; the onError handler should show the error.
      const phoneError = page.getByTestId("phone-error");
      await expect(phoneError).toBeVisible({ timeout: 8_000 });
      await expect(phoneError).toHaveText(
        "A driver with this phone number already exists.",
      );

      // Dialog must remain open.
      await expect(dialog).toBeVisible();

      // DB must still have exactly one driver with this phone.
      const count = await getDriverCount(SEED_PHONE);
      expect(count).toBe(1);
    },
  );
});
