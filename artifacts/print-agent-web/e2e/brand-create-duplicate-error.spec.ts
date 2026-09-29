import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import path from "path";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const SEED_BRAND_NAME = `E2E Dup Brand ${Date.now()}`;

const API_BASE = process.env.API_SERVER_URL ?? "http://localhost:8080";

// presentail-logo.png is 1200x1200 — square and well above the 200x200 client/server
// minimum, so the LogoPicker passes its dimension validation and Create stays enabled.
const LOGO_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../public/presentail-logo.png",
);

let seededBrandId: number;

async function apiPost(p: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${p} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function apiDelete(p: string): Promise<void> {
  const res = await fetch(`${API_BASE}${p}`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`DELETE ${p} failed (${res.status}): ${await res.text()}`);
  }
}

test.describe("Brands list — create duplicate-name inline error (DB-backed)", () => {
  test.beforeAll(async () => {
    const data = (await apiPost("/api/test/brand", {
      ownerEmail: OWNER_EMAIL,
      name: SEED_BRAND_NAME,
    })) as { id: number };
    seededBrandId = data.id;
  });

  test.afterAll(async () => {
    // Defensive: also remove any brand the test itself accidentally created
    // (should never happen because the POST is expected to 409, but in case
    // of partial runs we don't want to leak rows). We do this by name, owner-scoped,
    // via the same seed endpoint's idempotent cleanup followed by deletion.
    if (seededBrandId !== undefined) {
      await apiDelete(`/api/test/brand/${seededBrandId}`).catch(() => {});
    }
  });

  test(
    "submitting a duplicate brand name shows the inline 409 error and preserves dialog state",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });

      // Wait for the seeded brand to render so we know the brands list loaded.
      await expect(page.getByText(SEED_BRAND_NAME)).toBeVisible({ timeout: 15_000 });

      // Open the create dialog.
      await page.getByRole("button", { name: /new brand/i }).first().click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Fill the name with the seeded duplicate name.
      const nameInput = page.getByLabel(/brand name/i);
      await expect(nameInput).toBeVisible();
      await nameInput.fill(SEED_BRAND_NAME);

      // Attach a real square PNG so the client-side validator passes and Create enables.
      const fileInput = page.locator('input[type="file"][accept*="image"]');
      await fileInput.setInputFiles(LOGO_FIXTURE_PATH);

      // Wait for the LogoPicker to mark the image valid ("Image looks good").
      await expect(dialog.getByText(/image looks good/i)).toBeVisible({
        timeout: 8_000,
      });

      const createButton = page.getByRole("button", { name: /^Create$/ });
      await expect(createButton).toBeEnabled({ timeout: 5_000 });
      await createButton.click();

      // The 409 from POST /api/brands should produce the inline duplicate error.
      const duplicateError = page.getByTestId("name-error-duplicate");
      await expect(duplicateError).toBeVisible({ timeout: 8_000 });
      await expect(duplicateError).toHaveText("A brand with this name already exists");

      // Dialog stays open and the typed name is preserved.
      await expect(dialog).toBeVisible();
      await expect(nameInput).toBeVisible();
      await expect(nameInput).toHaveValue(SEED_BRAND_NAME);
    },
  );
});
