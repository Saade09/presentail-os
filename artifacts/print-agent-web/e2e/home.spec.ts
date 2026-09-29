import { test, expect } from "./fixtures";

test.describe("Homepage", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.use({ skipFapiMock: true });

  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: /Your entire operation,\s*under control/i })).toBeVisible({ timeout: 15_000 });
  });

  test("renders the hero badge and headline", async ({ page }) => {
    const heroBadge = page.getByTestId("text-hero-badge");
    await expect(heroBadge).toBeVisible();
    await expect(heroBadge).toHaveText(/All-in-one operations platform/i);

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Your entire operation,\s*under control/i,
      }),
    ).toBeVisible();

    await expect(
      page.getByText(
        /Presentail OS brings your brands, products, stickers, locations/i,
      ),
    ).toBeVisible();
  });

  test("sign-in CTA buttons are present and link to /sign-in", async ({
    page,
  }) => {
    const headerSignIn = page.getByTestId("link-sign-in");
    await expect(headerSignIn).toBeVisible();
    await expect(headerSignIn).toHaveAttribute("href", "/sign-in");

    const heroSignIn = page.getByTestId("link-sign-in-hero");
    await expect(heroSignIn).toBeVisible();
    await expect(heroSignIn).toHaveAttribute("href", "/sign-in");
  });

  test("clicking the header sign-in button navigates to /sign-in", async ({
    page,
  }) => {
    await page.getByTestId("link-sign-in").click();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("clicking the hero sign-in button navigates to /sign-in", async ({
    page,
  }) => {
    await page.getByTestId("link-sign-in-hero").click();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("download CTA buttons are present and link to the agent download endpoints", async ({
    page,
  }) => {
    const macButtons = page.getByTestId("button-download-mac");
    await expect(macButtons.first()).toBeVisible();
    await expect(macButtons.first()).toHaveAttribute(
      "href",
      "/api/download/mac",
    );

    const windowsButton = page.getByTestId("button-download-windows");
    await expect(windowsButton).toBeVisible();
    await expect(windowsButton).toHaveAttribute("href", "/api/download/windows");
  });

  test("trust bar renders all trust points", async ({ page }) => {
    const trustLabels = [
      "Brand management",
      "Real-time operations",
      "Multi-location ready",
      "Team-ready",
      "Role-based access",
      "Product control",
    ];

    for (const label of trustLabels) {
      await expect(page.getByText(label)).toBeVisible();
    }
  });

  test("feature cards render all feature titles", async ({ page }) => {
    const featureTitles = [
      "Analytics & Operational Insights",
      "Device & Agent Monitoring",
      "Brand & Product Management",
      "Team Roles & Permissions",
      "History & Audit Log",
      "Multi-Location Management",
    ];

    for (const title of featureTitles) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
  });

  test("clicking the footer sign-in link navigates to /sign-in", async ({
    page,
  }) => {
    await page.getByTestId("link-sign-in-footer").click();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("clicking the closing CTA sign-in button navigates to /sign-in", async ({
    page,
  }) => {
    await page.getByTestId("link-sign-in-cta").click();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("footer renders with branding and navigation links", async ({
    page,
  }) => {
    const footer = page.locator("footer");
    await expect(footer).toBeVisible();

    await expect(footer.getByText("Presentail OS")).toBeVisible();

    const presentailLink = footer.getByRole("link", {
      name: "presentail.com",
    });
    await expect(presentailLink).toBeVisible();
    await expect(presentailLink).toHaveAttribute(
      "href",
      "https://presentail.com",
    );

    const signInLink = footer.getByRole("link", { name: "Sign in" });
    await expect(signInLink).toBeVisible();
    await expect(signInLink).toHaveAttribute("href", "/sign-in");
  });
});
