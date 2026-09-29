import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const API_BASE = process.env.API_SERVER_URL ?? "http://localhost:8080";

async function apiPut(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
  }
}

async function apiDelete(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
}

test.describe("Available Countries — DB-backed integration", () => {
  test.afterAll(async () => {
    await apiDelete("/api/test/countries", {
      ownerEmail: OWNER_EMAIL,
    }).catch(() => {});
  });

  test(
    "owner selects countries, saves them, and location form only shows the saved countries",
    async ({ page }) => {
      // --- Setup: seed a known starting state so this test is self-contained
      // and retry-safe regardless of prior state.
      await apiPut("/api/test/countries", {
        ownerEmail: OWNER_EMAIL,
        countries: ["France", "Germany"],
      });

      await setupClerkTestingToken({ page });

      // --- Step 1: Verify Settings page reflects the seeded countries ---
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const checklist = page.getByTestId("country-checklist");
      await expect(checklist).toBeVisible({ timeout: 15_000 });

      const franceCheckbox = page.getByTestId("country-checkbox-France");
      const germanyCheckbox = page.getByTestId("country-checkbox-Germany");

      await expect(franceCheckbox).toBeChecked({ timeout: 8_000 });
      await expect(germanyCheckbox).toBeChecked({ timeout: 8_000 });

      // Israel must never appear as a selectable country in the checklist.
      await expect(page.getByTestId("country-checkbox-Israel")).toHaveCount(0);

      // --- Step 2: Update the selection — remove Germany, add Lebanon ---
      await germanyCheckbox.click();
      await expect(germanyCheckbox).not.toBeChecked();

      const searchInput = page.getByTestId("country-search-input");
      await searchInput.fill("Lebanon");

      const lebanonCheckbox = page.getByTestId("country-checkbox-Lebanon");
      await expect(lebanonCheckbox).toBeVisible({ timeout: 5_000 });
      await expect(lebanonCheckbox).not.toBeChecked();
      await lebanonCheckbox.click();
      await expect(lebanonCheckbox).toBeChecked();

      await searchInput.clear();

      // --- Step 3: Save the updated selection ---
      const saveButton = page.getByTestId("save-countries-button");
      await saveButton.click();

      await expect(page.getByText(/countries saved/i)).toBeVisible({
        timeout: 8_000,
      });

      // --- Step 4: Navigate to Locations and verify the create dialog
      //             dropdown only shows the saved countries ---
      await page.goto("/locations", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible({ timeout: 15_000 });

      const newLocationButton = page.getByTestId("button-new-location");
      await expect(newLocationButton).toBeVisible({ timeout: 15_000 });
      await newLocationButton.click();

      const countryTrigger = page.getByTestId("select-location-country");
      await expect(countryTrigger).toBeVisible({ timeout: 8_000 });
      await expect(countryTrigger).not.toBeDisabled();

      await countryTrigger.click();

      await expect(
        page.getByRole("option", { name: "France" }),
      ).toBeVisible({ timeout: 5_000 });
      await expect(
        page.getByRole("option", { name: "Lebanon" }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("option", { name: "Germany" }),
      ).not.toBeVisible();
      await expect(
        page.getByRole("option", { name: "United Arab Emirates" }),
      ).not.toBeVisible();

      // --- Step 5: Confirm the selection persists after a page reload ---
      await page.keyboard.press("Escape");
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 15_000 });

      const checklistAfter = page.getByTestId("country-checklist");
      await expect(checklistAfter).toBeVisible({ timeout: 15_000 });

      const franceAfter = page.getByTestId("country-checkbox-France");
      const germanyAfter = page.getByTestId("country-checkbox-Germany");

      await expect(franceAfter).toBeChecked({ timeout: 8_000 });
      await expect(germanyAfter).not.toBeChecked({ timeout: 8_000 });

      const searchAfter = page.getByTestId("country-search-input");
      await searchAfter.fill("Lebanon");

      const lebanonAfter = page.getByTestId("country-checkbox-Lebanon");
      await expect(lebanonAfter).toBeVisible({ timeout: 5_000 });
      await expect(lebanonAfter).toBeChecked();
    },
  );
});
