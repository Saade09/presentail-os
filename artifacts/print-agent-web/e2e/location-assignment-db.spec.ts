import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const TEST_MEMBER_EMAIL = "e2e-loc-db-member@example.com";
const TEST_LOCATION_NAME = "E2E DB Test Location";

const API_BASE = process.env.API_SERVER_URL ?? "http://localhost:8080";

let testMemberId: number;
let testLocationId: number;

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
}

test.describe("Member location assignment — DB-backed integration", () => {
  test.beforeAll(async () => {
    const memberData = (await apiPost("/api/test/member", {
      ownerEmail: OWNER_EMAIL,
      memberEmail: TEST_MEMBER_EMAIL,
    })) as { id: number };
    testMemberId = memberData.id;

    const locationData = (await apiPost("/api/test/location", {
      ownerEmail: OWNER_EMAIL,
      name: TEST_LOCATION_NAME,
    })) as { id: number };
    testLocationId = locationData.id;
  });

  test.afterAll(async () => {
    await apiDelete(`/api/test/location/${testLocationId}`).catch(() => {});
    await apiDelete(`/api/test/member/${testMemberId}`).catch(() => {});
  });

  test(
    "assign a seeded location to a seeded member and verify it persists in the database",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${testMemberId}`);
      await expect(memberRow).toBeVisible({ timeout: 15_000 });

      const changeLocationsButton = page.getByTestId(
        `button-change-locations-${testMemberId}`,
      );
      await expect(changeLocationsButton).toBeVisible({ timeout: 8_000 });
      await expect(changeLocationsButton).toContainText("Assign locations");

      await changeLocationsButton.click();

      const dialog = page.getByTestId("dialog-change-locations");
      await expect(dialog).toBeVisible({ timeout: 8_000 });
      await expect(dialog).toContainText(TEST_MEMBER_EMAIL);
      await expect(dialog).toContainText(TEST_LOCATION_NAME);

      const locationCheckbox = page.getByTestId(
        `checkbox-location-${testLocationId}`,
      );
      await expect(locationCheckbox).not.toBeChecked();
      await locationCheckbox.click();
      await expect(locationCheckbox).toBeChecked();

      const saveButton = page.getByTestId("button-confirm-location-change");
      await saveButton.click();

      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      // UI should reflect the assignment immediately (sourced from real API re-fetch)
      const locationsDisplay = page.getByTestId(
        `locations-display-${testMemberId}`,
      );
      await expect(locationsDisplay).toBeVisible({ timeout: 10_000 });
      await expect(locationsDisplay).toContainText(TEST_LOCATION_NAME);
      await expect(changeLocationsButton).toContainText("1 location");

      // Verify the assignment persisted in the database by querying the real
      // API endpoint (page.request shares the authenticated browser session).
      const apiResponse = await page.request.get(
        `/api/users/${testMemberId}/locations`,
      );
      expect(apiResponse.ok()).toBe(true);

      const body = (await apiResponse.json()) as {
        locations: { id: number; name: string }[];
      };
      const assignedIds = body.locations.map((l) => l.id);
      expect(assignedIds).toContain(testLocationId);
    },
  );

  test(
    "clear a persisted location assignment and verify the database reflects the empty state",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.goto("/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({ timeout: 15_000 });

      const memberRow = page.getByTestId(`member-${testMemberId}`);
      await expect(memberRow).toBeVisible({ timeout: 15_000 });

      const changeLocationsButton = page.getByTestId(
        `button-change-locations-${testMemberId}`,
      );
      await expect(changeLocationsButton).toBeVisible({ timeout: 8_000 });

      // Ensure the location is assigned first (handles the case where this
      // test runs independently or after cleanup).
      const locationsDisplay = page.getByTestId(
        `locations-display-${testMemberId}`,
      );
      const alreadyAssigned = await locationsDisplay.isVisible().catch(() => false);

      if (!alreadyAssigned) {
        // Assign via the UI so we have something to clear.
        await changeLocationsButton.click();
        const assignDialog = page.getByTestId("dialog-change-locations");
        await expect(assignDialog).toBeVisible({ timeout: 8_000 });

        const locationCheckbox = page.getByTestId(
          `checkbox-location-${testLocationId}`,
        );
        await expect(locationCheckbox).not.toBeChecked();
        await locationCheckbox.click();

        const saveButton = page.getByTestId("button-confirm-location-change");
        await saveButton.click();
        await expect(assignDialog).not.toBeVisible({ timeout: 10_000 });
        await expect(locationsDisplay).toBeVisible({ timeout: 10_000 });
      }

      // Now clear the assignment
      await expect(changeLocationsButton).toContainText("1 location");
      await changeLocationsButton.click();

      const dialog = page.getByTestId("dialog-change-locations");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      const locationCheckbox = page.getByTestId(
        `checkbox-location-${testLocationId}`,
      );
      await expect(locationCheckbox).toBeChecked();
      await locationCheckbox.click();
      await expect(locationCheckbox).not.toBeChecked();

      const saveButton = page.getByTestId("button-confirm-location-change");
      await saveButton.click();

      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      await expect(locationsDisplay).not.toBeVisible({ timeout: 10_000 });
      await expect(changeLocationsButton).toContainText("Assign locations");

      // Verify the database now reflects an empty assignment list.
      const apiResponse = await page.request.get(
        `/api/users/${testMemberId}/locations`,
      );
      expect(apiResponse.ok()).toBe(true);

      const body = (await apiResponse.json()) as {
        locations: { id: number; name: string }[];
      };
      expect(body.locations).toHaveLength(0);
    },
  );
});
