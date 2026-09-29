import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const MOCK_STICKER_ID = 42;
const MOCK_STICKER_NAME = "Holiday Special";

const MOCK_DEVICE_ID = 7;
const MOCK_DEVICE_NAME = "Office Mac";
const MOCK_PRINTER_NAME = "Brother QL-820NWB";

const MOCK_BRANDS = { brands: [] };

const MOCK_STICKERS = {
  stickers: [
    {
      id: MOCK_STICKER_ID,
      name: MOCK_STICKER_NAME,
      file_name: "holiday-special.pdf",
      created_at: new Date().toISOString(),
      brand_id: null,
      brand_name: null,
    },
  ],
};

const MOCK_DEVICES = {
  devices: [
    {
      id: MOCK_DEVICE_ID,
      name: MOCK_DEVICE_NAME,
      machine_id: "abc-123",
      printers: [MOCK_PRINTER_NAME, "HP LaserJet Pro"],
    },
  ],
};

function usersResponse(role: "owner" | "member") {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role,
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
    me: {
      role,
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupStickersPage(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse("owner")),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BRANDS),
    });
  });

  await page.route(
    (url) => url.pathname === "/api/stickers",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_STICKERS),
      });
    },
  );

  await page.route("**/api/stickers/*/thumbnail**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.goto("/stickers", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Stickers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(MOCK_STICKER_NAME)).toBeVisible({ timeout: 12_000 });
}

test.describe("Sticker print dialog", () => {
  test(
    "clicking Print on a sticker card opens the print dialog",
    async ({ page }) => {
      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DEVICES),
        });
      });

      await setupStickersPage(page);

      await page.getByRole("button", { name: "Print" }).first().click();

      const dialog = page.getByTestId("dialog-print-sticker");
      await expect(dialog).toBeVisible({ timeout: 8_000 });
      await expect(dialog.getByText(`Print "${MOCK_STICKER_NAME}"`)).toBeVisible();
    },
  );

  test(
    "selecting a device populates the printer dropdown",
    async ({ page }) => {
      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DEVICES),
        });
      });

      await setupStickersPage(page);

      await page.getByRole("button", { name: "Print" }).first().click();

      const dialog = page.getByTestId("dialog-print-sticker");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      const computerTrigger = dialog.getByTestId("select-computer");
      await computerTrigger.click();
      await page.getByRole("option", { name: MOCK_DEVICE_NAME }).click();

      const printerTrigger = dialog.getByTestId("select-printer");
      await expect(printerTrigger).not.toBeDisabled({ timeout: 4_000 });

      await printerTrigger.click();
      await expect(page.getByRole("option", { name: MOCK_PRINTER_NAME })).toBeVisible({
        timeout: 4_000,
      });
    },
  );

  test(
    "clicking Print with valid selections triggers POST /api/print-jobs and shows a success toast",
    async ({ page }) => {
      let printJobPostCalled = false;
      let capturedBody: unknown = null;

      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DEVICES),
        });
      });

      await page.route("**/api/print-jobs**", async (route) => {
        if (route.request().method() === "POST") {
          printJobPostCalled = true;
          capturedBody = JSON.parse(route.request().postData() ?? "{}");
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ jobs: [] }),
          });
        }
      });

      await setupStickersPage(page);

      await page.getByRole("button", { name: "Print" }).first().click();

      const dialog = page.getByTestId("dialog-print-sticker");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      const computerTrigger = dialog.getByTestId("select-computer");
      await computerTrigger.click();
      await page.getByRole("option", { name: MOCK_DEVICE_NAME }).click();

      const printerTrigger = dialog.getByTestId("select-printer");
      await expect(printerTrigger).not.toBeDisabled({ timeout: 4_000 });
      await printerTrigger.click();
      await page.getByRole("option", { name: MOCK_PRINTER_NAME }).click();

      const printButton = dialog.getByTestId("button-confirm-print");
      await expect(printButton).not.toBeDisabled({ timeout: 4_000 });
      await printButton.click();

      await expect(page.getByText("Print job sent", { exact: true })).toBeVisible({ timeout: 8_000 });

      expect(printJobPostCalled).toBe(true);
      expect((capturedBody as Record<string, unknown>).device_id).toBe(MOCK_DEVICE_ID);
      expect((capturedBody as Record<string, unknown>).printer_name).toBe(MOCK_PRINTER_NAME);
    },
  );

  test(
    "when no devices are connected the Computer dropdown shows 'No devices' and Print stays disabled",
    async ({ page }) => {
      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ devices: [] }),
        });
      });

      await setupStickersPage(page);

      await page.getByRole("button", { name: "Print" }).first().click();

      const dialog = page.getByTestId("dialog-print-sticker");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      const computerTrigger = dialog.getByTestId("select-computer");
      await expect(computerTrigger).toContainText("No devices", { timeout: 4_000 });

      const printButton = dialog.getByTestId("button-confirm-print");
      await expect(printButton).toBeDisabled();
    },
  );

  test(
    "the print dialog closes after a successful print job",
    async ({ page }) => {
      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_DEVICES),
        });
      });

      await page.route("**/api/print-jobs**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ jobs: [] }),
          });
        }
      });

      await setupStickersPage(page);

      await page.getByRole("button", { name: "Print" }).first().click();

      const dialog = page.getByTestId("dialog-print-sticker");
      await expect(dialog).toBeVisible({ timeout: 8_000 });

      const computerTrigger = dialog.getByTestId("select-computer");
      await computerTrigger.click();
      await page.getByRole("option", { name: MOCK_DEVICE_NAME }).click();

      const printerTrigger = dialog.getByTestId("select-printer");
      await expect(printerTrigger).not.toBeDisabled({ timeout: 4_000 });
      await printerTrigger.click();
      await page.getByRole("option", { name: MOCK_PRINTER_NAME }).click();

      await dialog.getByTestId("button-confirm-print").click();

      await expect(dialog).not.toBeVisible({ timeout: 8_000 });
    },
  );
});
