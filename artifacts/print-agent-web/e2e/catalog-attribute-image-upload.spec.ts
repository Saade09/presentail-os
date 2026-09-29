import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MOCK_USERS_RESPONSE = {
  members: [],
  me: {
    role: "owner",
    email: "e2e-tester@presentail.com",
    allowedPages: null,
    customRoleId: null,
  },
};

const MOCK_CATALOG_BRANDS_EMPTY = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

const MOCK_UPLOAD_URL_RESPONSE = {
  uploadURL: "https://mock-storage.example.com/upload/test-image.jpg",
  objectPath: "/objects/test-image-abc123.jpg",
  metadata: { name: "test-image.jpg", size: 1024, contentType: "image/jpeg" },
};

async function setupPage(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_USERS_RESPONSE),
    });
  });

  await page.route("**/api/catalog_brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CATALOG_BRANDS_EMPTY),
    });
  });
}

async function mockUploadRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/storage/uploads/request-url", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_UPLOAD_URL_RESPONSE),
    });
  });

  await page.route("**/mock-storage.example.com/**", async (route) => {
    await route.fulfill({ status: 200, body: "" });
  });
}

async function openNewBrandSheet(page: import("@playwright/test").Page) {
  await page.goto("/catalog-attributes/brands", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /new brand/i }).first().click();
  await expect(
    page.getByRole("heading", { name: /new brand/i }),
  ).toBeVisible({ timeout: 8_000 });
}

async function uploadValidImage(page: import("@playwright/test").Page) {
  const fileInput = page.locator('input[type="file"][accept*="image"]');
  await fileInput.setInputFiles({
    name: "test-image.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-image-data"),
  });

  // The "Replace" button appears once the image is set — this is the
  // reliable indicator that upload succeeded (the <img> itself hides
  // via onError since the mock URL returns no real image bytes).
  await expect(
    page.getByRole("button", { name: /replace/i }),
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Catalog attribute image upload", () => {
  test("shows Replace and Remove buttons after a successful upload", async ({
    page,
  }) => {
    await setupPage(page);
    await mockUploadRoutes(page);
    await openNewBrandSheet(page);
    await uploadValidImage(page);

    await expect(
      page.getByRole("button", { name: /replace/i }),
    ).toBeEnabled();

    await expect(
      page.getByRole("button", { name: /remove/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /remove/i }),
    ).toBeEnabled();

    await expect(page.getByText(/click to upload image/i)).not.toBeVisible();
  });

  test("removes the image and restores the dashed placeholder when Remove is clicked", async ({
    page,
  }) => {
    await setupPage(page);
    await mockUploadRoutes(page);
    await openNewBrandSheet(page);
    await uploadValidImage(page);

    await page.getByRole("button", { name: /remove/i }).click();

    await expect(
      page.getByRole("button", { name: /replace/i }),
    ).not.toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /remove/i }),
    ).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByText(/click to upload image/i)).toBeVisible({
      timeout: 5_000,
    });
  });

  test("shows an inline error for an unsupported file type", async ({
    page,
  }) => {
    await setupPage(page);
    await openNewBrandSheet(page);

    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "document.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("fake-pdf-data"),
    });

    await expect(
      page.getByText(/unsupported file type/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText(/click to upload image/i)).toBeVisible();
  });

  test("shows an inline error when the file exceeds the 5 MB limit", async ({
    page,
  }) => {
    await setupPage(page);
    await openNewBrandSheet(page);

    const OVER_5MB = Buffer.alloc(5 * 1024 * 1024 + 1, "x");

    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "huge.jpg",
      mimeType: "image/jpeg",
      buffer: OVER_5MB,
    });

    await expect(
      page.getByText(/file too large.*max 5 mb/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText(/click to upload image/i)).toBeVisible();
  });

  test("disables the Save button while an upload is in progress", async ({
    page,
  }) => {
    await setupPage(page);

    let resolveUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      resolveUpload = resolve;
    });

    let fulfillUpload!: () => void;
    const uploadCanProceed = new Promise<void>((resolve) => {
      fulfillUpload = resolve;
    });

    await page.route("**/api/storage/uploads/request-url", async (route) => {
      resolveUpload();
      await uploadCanProceed;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_UPLOAD_URL_RESPONSE),
      });
    });

    await page.route("**/mock-storage.example.com/**", async (route) => {
      await route.fulfill({ status: 200, body: "" });
    });

    await openNewBrandSheet(page);

    await page.getByLabel(/^name/i).fill("Test Brand");

    const saveButton = page.getByRole("button", { name: /create brand/i });
    await expect(saveButton).toBeEnabled({ timeout: 5_000 });

    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "test-image.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-image-data"),
    });

    await uploadStarted;

    await expect(saveButton).toBeDisabled({ timeout: 5_000 });

    fulfillUpload();

    await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  });
});
