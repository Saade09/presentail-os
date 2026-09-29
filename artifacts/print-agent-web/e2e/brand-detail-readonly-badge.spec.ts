import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  DEFAULT_OWNER_EMAIL,
  ownerUsersResponse,
  setupBrandsCommonRoutes,
  setupBrandDetailSubRoutes,
} from "./helpers/brandsCommonRoutes";

const MOCK_BRAND = {
  brand: {
    id: 1,
    name: "Acme Brand",
    description: null,
    target_cogs: null,
    created_at: new Date().toISOString(),
    sticker_count: "3",
    has_logo: false,
    has_card_message: false,
  },
};

const MOCK_BRAND_2 = {
  brand: {
    id: 2,
    name: "Beta Brand",
    description: null,
    target_cogs: null,
    created_at: new Date().toISOString(),
    sticker_count: "0",
    has_logo: false,
    has_card_message: false,
  },
};

const MOCK_BRANDS_LIST = {
  brands: [
    {
      id: 1,
      name: "Acme Brand",
      description: null,
      target_cogs: null,
      created_at: new Date().toISOString(),
      sticker_count: "3",
      product_count: "0",
      has_logo: false,
    },
    {
      id: 2,
      name: "Beta Brand",
      description: null,
      target_cogs: null,
      created_at: new Date().toISOString(),
      sticker_count: "0",
      product_count: "0",
      has_logo: false,
    },
  ],
  workspaceJobCount: 0,
};

function memberWithPages(allowedPages: string[]) {
  return {
    members: [
      {
        id: 2,
        email: "viewer@example.com",
        role: "member",
        custom_role_id: 20,
        role_name: "Viewer",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: DEFAULT_OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: "viewer@example.com",
      allowedPages,
      customRoleId: 20,
    },
  };
}

function designerUsersResponse() {
  return {
    members: [
      {
        id: 3,
        email: "designer@example.com",
        role: "designer",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: DEFAULT_OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "designer",
      email: "designer@example.com",
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function mockBrandDetailRoutes(
  page: import("@playwright/test").Page,
  brandId: number = 1,
) {
  const mockBrand = brandId === 2 ? MOCK_BRAND_2 : MOCK_BRAND;

  await page.route(`**/api/brands/${brandId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockBrand),
    });
  });

  await setupBrandDetailSubRoutes(page, { brandId });
}

async function setupPage(
  page: import("@playwright/test").Page,
  usersResponse: object,
) {
  await setupClerkTestingToken({ page });

  await setupBrandsCommonRoutes(page, { getUsersResponse: () => usersResponse });

  await mockBrandDetailRoutes(page);
  await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
}

test.describe("BrandDetail read-only badge", () => {
  test(
    "shows 'Read only' badge for a custom-role user without brands.manage",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands"]));

      const badge = page.getByText("Read only").first();
      await expect(badge).toBeVisible({ timeout: 12_000 });

      await badge.hover();
      await expect(
        page.getByText("Your role does not have brand management permissions"),
      ).toBeVisible({ timeout: 4_000 });
    },
  );

  test(
    "does not show 'Read only' badge for an owner",
    async ({ page }) => {
      await setupPage(page, ownerUsersResponse());
      await expect(page.getByText("Read only")).not.toBeVisible();
    },
  );

  test(
    "does not show 'Read only' badge for a designer",
    async ({ page }) => {
      await setupPage(page, designerUsersResponse());
      await expect(page.getByText("Read only")).not.toBeVisible();
    },
  );

  test.describe("Logos section badge", () => {
    test(
      "shows Read-only badge on Logos section when brands.manage-logos is absent",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        const logosHeadingRow = page.locator("h2", { hasText: "Logos" }).locator("..");
        const badge = logosHeadingRow.getByText("Read only");
        await expect(badge).toBeVisible({ timeout: 8_000 });

        await badge.hover();
        await expect(
          page.getByText("Your role does not have permission to manage logos"),
        ).toBeVisible({ timeout: 4_000 });
      },
    );

    test(
      "badge absent on Logos section when brands.manage-logos is present",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-logos"]));

        const logosHeadingRow = page.locator("h2", { hasText: "Logos" }).locator("..");
        await expect(logosHeadingRow.getByText("Read only")).not.toBeVisible();
      },
    );
  });

  test.describe("Stickers section badge", () => {
    test(
      "shows Read-only badge on Stickers section when user lacks brands.manage",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        const stickersHeadingRow = page.locator("h2").filter({ hasText: /^Stickers$/ }).locator("..");
        const badge = stickersHeadingRow.getByText("Read only");
        await expect(badge).toBeVisible({ timeout: 8_000 });

        await badge.hover();
        await expect(
          page.getByText("Your role does not have permission to manage stickers"),
        ).toBeVisible({ timeout: 4_000 });
      },
    );

    test(
      "badge absent on Stickers section when user has brands.manage",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands.manage"]));

        const stickersHeadingRow = page.locator("h2").filter({ hasText: /^Stickers$/ }).locator("..");
        await expect(stickersHeadingRow.getByText("Read only")).not.toBeVisible();
      },
    );
  });

  test.describe("Cover Photos section badge", () => {
    test(
      "shows Read-only badge on Cover Photos section when brands.manage-cover-photos is absent",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        const coverPhotosHeadingRow = page.locator("h2").filter({ hasText: /Cover Photos/i }).locator("..");
        const badge = coverPhotosHeadingRow.getByText("Read only");
        await expect(badge).toBeVisible({ timeout: 8_000 });

        await badge.hover();
        await expect(
          page.getByText("Your role does not have permission to manage cover photos"),
        ).toBeVisible({ timeout: 4_000 });
      },
    );

    test(
      "badge absent on Cover Photos section when brands.manage-cover-photos is present",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-cover-photos"]));

        const coverPhotosHeadingRow = page.locator("h2").filter({ hasText: /Cover Photos/i }).locator("..");
        await expect(coverPhotosHeadingRow.getByText("Read only")).not.toBeVisible();
      },
    );
  });

  test.describe("Card Message section badge", () => {
    test(
      "shows Read-only badge on Card Message section when brands.manage-card-message is absent",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        const cardMessageHeadingRow = page.locator("h2").filter({ hasText: /Card Message/i }).locator("..");
        const badge = cardMessageHeadingRow.getByText("Read only");
        await expect(badge).toBeVisible({ timeout: 8_000 });

        await badge.hover();
        await expect(
          page.getByText("Your role does not have permission to manage the card message"),
        ).toBeVisible({ timeout: 4_000 });
      },
    );

    test(
      "badge absent on Card Message section when brands.manage-card-message is present",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-card-message"]));

        const cardMessageHeadingRow = page.locator("h2").filter({ hasText: /Card Message/i }).locator("..");
        await expect(cardMessageHeadingRow.getByText("Read only")).not.toBeVisible();
      },
    );
  });

  test.describe("member with brands.manage bypasses all section badges", () => {
    test(
      "no section Read-only badges when user has brands.manage",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands.manage"]));

        await expect(page.getByText("Read only")).not.toBeVisible();
      },
    );
  });
});

test.describe("BrandDetail action button visibility for read-only users", () => {
  test.describe("Logos section action button", () => {
    test(
      "hides 'Add logo' button when user lacks brands.manage-logos",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        await expect(page.getByRole("button", { name: "Add logo" })).not.toBeVisible();
      },
    );

    test(
      "shows 'Add logo' button when user has brands.manage-logos",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-logos"]));

        await expect(page.getByRole("button", { name: "Add logo" }).first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Stickers section action button", () => {
    test(
      "hides 'Add Sticker' button when user lacks brands.manage",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        await expect(page.getByRole("button", { name: "Add Sticker" })).not.toBeVisible();
      },
    );

    test(
      "shows 'Add Sticker' button when user has brands.manage",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands.manage"]));

        await expect(page.getByRole("button", { name: "Add Sticker" }).first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Cover Photos section action button", () => {
    test(
      "hides 'Add Cover Photo' button when user lacks brands.manage-cover-photos",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        await expect(page.getByRole("button", { name: "Add Cover Photo" })).not.toBeVisible();
      },
    );

    test(
      "shows 'Add Cover Photo' button when user has brands.manage-cover-photos",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-cover-photos"]));

        await expect(page.getByRole("button", { name: "Add Cover Photo" }).first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Card Message section action button", () => {
    test(
      "hides 'Upload Image' button when user lacks brands.manage-card-message",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        await expect(page.getByRole("button", { name: "Upload Image" })).not.toBeVisible();
      },
    );

    test(
      "shows 'Upload Image' button when user has brands.manage-card-message",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.manage-card-message"]));

        await expect(page.getByRole("button", { name: "Upload Image" }).first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Rename brand button", () => {
    test(
      "hides 'Rename brand' button when user lacks both brands.manage and brands.edit",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands"]));

        await expect(page.locator('button[title="Rename brand"]')).not.toBeAttached();
      },
    );

    test(
      "shows 'Rename brand' button when user has brands.edit",
      async ({ page }) => {
        await setupPage(page, memberWithPages(["brands", "brands.edit"]));

        await page.hover("h1");
        await expect(page.locator('button[title="Rename brand"]')).toBeAttached({ timeout: 8_000 });
      },
    );
  });
});

// ─── Mock data sets that include at least one item per section ─────────────────

const MOCK_LOGOS_WITH_DATA = {
  logos: [
    {
      id: 30,
      brand_id: 1,
      label: "Primary",
      logo_mime: "image/png",
      sort_order: 0,
      created_at: new Date().toISOString(),
    },
    {
      id: 31,
      brand_id: 1,
      label: "Dark",
      logo_mime: "image/png",
      sort_order: 1,
      created_at: new Date().toISOString(),
    },
  ],
};

const MOCK_STICKERS_WITH_DATA = {
  stickers: [
    {
      id: 10,
      name: "Sticker One",
      file_name: "sticker.pdf",
      created_at: new Date().toISOString(),
      brand_id: 1,
    },
  ],
};

const MOCK_COVER_PHOTOS_WITH_DATA = {
  coverPhotos: [
    {
      id: 20,
      brand_id: 1,
      label: "All Year",
      photo_mime: "image/jpeg",
      created_at: new Date().toISOString(),
    },
  ],
};

const MOCK_BRAND_WITH_CARD_MSG = {
  brand: {
    id: 1,
    name: "Acme Brand",
    description: null,
    target_cogs: null,
    created_at: new Date().toISOString(),
    sticker_count: "1",
    has_logo: false,
    has_card_message: true,
  },
};

async function setupPageWithData(
  page: import("@playwright/test").Page,
  usersResponse: object,
  overrides: {
    logos?: object;
    stickers?: object;
    coverPhotos?: object;
    brand?: object;
  } = {},
) {
  await setupClerkTestingToken({ page });

  await setupBrandsCommonRoutes(page, { getUsersResponse: () => usersResponse });

  await page.route("**/api/brands/1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.brand ?? MOCK_BRAND),
    });
  });

  await setupBrandDetailSubRoutes(page, {
    brandId: 1,
    stickers: overrides.stickers,
    coverPhotos: overrides.coverPhotos,
    logos: overrides.logos,
  });

  await page.route("**/api/brands/1/logos/*/image", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: "" });
  });

  await page.route("**/api/brands/1/cover-photos/*/image", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
  });

  await page.route("**/api/brands/1/card-message**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/jpeg", body: "" });
  });

  await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
}

test.describe("BrandDetail destructive button visibility for read-only users", () => {
  test.describe("Logo remove button", () => {
    test(
      "hides Remove logo button when user lacks brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          logos: MOCK_LOGOS_WITH_DATA,
        });

        const logosSection = page
          .locator("div.space-y-4")
          .filter({ has: page.locator("h2", { hasText: /^Logos$/ }) });

        await expect(logosSection.locator("button.text-destructive")).not.toBeAttached();
      },
    );

    test(
      "shows Remove logo button when user has brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(
          page,
          memberWithPages(["brands", "brands.manage-logos"]),
          { logos: MOCK_LOGOS_WITH_DATA },
        );

        const logosSection = page
          .locator("div.space-y-4")
          .filter({ has: page.locator("h2", { hasText: /^Logos$/ }) });

        await expect(logosSection.locator("button.text-destructive").first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Sticker delete button", () => {
    test(
      "hides Delete sticker button when user lacks brands.manage",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          stickers: MOCK_STICKERS_WITH_DATA,
        });

        await expect(page.getByRole("button", { name: "Delete" })).not.toBeAttached();
      },
    );

    test(
      "shows Delete sticker button when user has brands.manage",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands.manage"]), {
          stickers: MOCK_STICKERS_WITH_DATA,
        });

        await expect(page.getByRole("button", { name: "Delete" }).first()).toBeVisible({
          timeout: 8_000,
        });
      },
    );
  });

  test.describe("Cover photo delete button", () => {
    test(
      "hides Delete cover photo button when user lacks brands.manage-cover-photos",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          coverPhotos: MOCK_COVER_PHOTOS_WITH_DATA,
        });

        const coverSection = page
          .locator("div.space-y-4")
          .filter({ has: page.locator("h2", { hasText: /Cover Photos/i }) });

        await expect(coverSection.getByTitle("Delete")).not.toBeAttached();
      },
    );

    test(
      "shows Delete cover photo button when user has brands.manage-cover-photos",
      async ({ page }) => {
        await setupPageWithData(
          page,
          memberWithPages(["brands", "brands.manage-cover-photos"]),
          { coverPhotos: MOCK_COVER_PHOTOS_WITH_DATA },
        );

        const coverSection = page
          .locator("div.space-y-4")
          .filter({ has: page.locator("h2", { hasText: /Cover Photos/i }) });

        await expect(coverSection.getByTitle("Delete").first()).toBeAttached();
      },
    );
  });

  test.describe("Card message remove button", () => {
    test(
      "hides Remove card message button when user lacks brands.manage-card-message",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          brand: MOCK_BRAND_WITH_CARD_MSG,
        });

        await expect(page.getByRole("button", { name: "Remove" })).not.toBeAttached();
      },
    );

    test(
      "shows Remove card message button when user has brands.manage-card-message",
      async ({ page }) => {
        await setupPageWithData(
          page,
          memberWithPages(["brands", "brands.manage-card-message"]),
          { brand: MOCK_BRAND_WITH_CARD_MSG },
        );

        await expect(page.getByRole("button", { name: "Remove" }).first()).toBeVisible({
          timeout: 8_000,
        });
      },
    );
  });
});

test.describe("Read-only state consistency when navigating between brands", () => {
  async function setupBrandNavTest(
    page: import("@playwright/test").Page,
    usersResponse: object,
  ) {
    await setupClerkTestingToken({ page });

    await setupBrandsCommonRoutes(page, { getUsersResponse: () => usersResponse });

    await page.route("**/api/brands", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_BRANDS_LIST),
        });
      } else {
        await route.continue();
      }
    });

    await mockBrandDetailRoutes(page, 1);
    await mockBrandDetailRoutes(page, 2);
  }

  test(
    "read-only badges remain visible on second brand after navigating from first brand",
    async ({ page }) => {
      await setupBrandNavTest(page, memberWithPages(["brands"]));

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.getByText("Acme Brand").click();
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("Read only").first()).toBeVisible({ timeout: 12_000 });

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });

      await page.getByText("Beta Brand").click();
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("Read only").first()).toBeVisible({ timeout: 12_000 });
    },
  );

  test(
    "no read-only badges on second brand after navigating from first brand as owner",
    async ({ page }) => {
      await setupBrandNavTest(page, ownerUsersResponse());

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.getByText("Acme Brand").click();
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("Read only")).not.toBeVisible();

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });

      await page.getByText("Beta Brand").click();
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("Read only")).not.toBeVisible();
    },
  );

  test(
    "action buttons consistently hidden on both brands for read-only user",
    async ({ page }) => {
      await setupBrandNavTest(page, memberWithPages(["brands"]));

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add logo" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Sticker" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Cover Photo" })).not.toBeVisible();

      await page.goto("/brands/2", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Beta Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add logo" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Sticker" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Cover Photo" })).not.toBeVisible();
    },
  );

  test(
    "action buttons consistently visible on both brands for user with brands.manage",
    async ({ page }) => {
      await setupBrandNavTest(page, memberWithPages(["brands.manage"]));

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add Sticker" }).first()).toBeVisible({ timeout: 8_000 });
      await expect(page.getByText("Read only")).not.toBeVisible();

      await page.goto("/brands/2", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Beta Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add Sticker" }).first()).toBeVisible({ timeout: 8_000 });
      await expect(page.getByText("Read only")).not.toBeVisible();
    },
  );

  test(
    "action buttons hidden via list-click navigation to both brands for read-only user",
    async ({ page }) => {
      await setupBrandNavTest(page, memberWithPages(["brands"]));

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await page.getByText("Acme Brand").click();
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add logo" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Sticker" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Cover Photo" })).not.toBeVisible();

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await page.getByText("Beta Brand").click();
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByRole("button", { name: "Add logo" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Sticker" })).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Add Cover Photo" })).not.toBeVisible();
    },
  );

  test(
    "per-section badges reflect mixed permissions consistently on both brands (logos allowed, cover photos not)",
    async ({ page }) => {
      await setupBrandNavTest(page, memberWithPages(["brands", "brands.manage-logos"]));

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      const logosHeadingRow1 = page.locator("h2", { hasText: "Logos" }).locator("..");
      await expect(logosHeadingRow1.getByText("Read only")).not.toBeVisible();

      const coverPhotosHeadingRow1 = page.locator("h2").filter({ hasText: /Cover Photos/i }).locator("..");
      await expect(coverPhotosHeadingRow1.getByText("Read only")).toBeVisible({ timeout: 8_000 });

      await page.goto("/brands/2", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Beta Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Beta Brand")).toBeVisible({ timeout: 12_000 });

      const logosHeadingRow2 = page.locator("h2", { hasText: "Logos" }).locator("..");
      await expect(logosHeadingRow2.getByText("Read only")).not.toBeVisible();

      const coverPhotosHeadingRow2 = page.locator("h2").filter({ hasText: /Cover Photos/i }).locator("..");
      await expect(coverPhotosHeadingRow2.getByText("Read only")).toBeVisible({ timeout: 8_000 });
    },
  );
});

test.describe("BrandDetail edit/rename control visibility for read-only users", () => {
  test.describe("Logo label edit button (Pencil icon)", () => {
    test(
      "hides logo label edit button when user lacks brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          logos: MOCK_LOGOS_WITH_DATA,
        });

        await expect(page.locator("button[title='Edit label']")).not.toBeAttached();
      },
    );

    test(
      "shows logo label edit button when user has brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(
          page,
          memberWithPages(["brands", "brands.manage-logos"]),
          { logos: MOCK_LOGOS_WITH_DATA },
        );

        await expect(page.locator("button[title='Edit label']").first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Logo drag-to-reorder handle (GripVertical icon)", () => {
    test(
      "hides drag-to-reorder handle when user lacks brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          logos: MOCK_LOGOS_WITH_DATA,
        });

        await expect(page.locator("button[title='Drag to reorder']")).not.toBeAttached();
      },
    );

    test(
      "shows drag-to-reorder handle when user has brands.manage-logos",
      async ({ page }) => {
        await setupPageWithData(
          page,
          memberWithPages(["brands", "brands.manage-logos"]),
          { logos: MOCK_LOGOS_WITH_DATA },
        );

        await expect(page.locator("button[title='Drag to reorder']").first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });

  test.describe("Sticker rename button", () => {
    test(
      "hides Rename button when user lacks brands.manage",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands"]), {
          stickers: MOCK_STICKERS_WITH_DATA,
        });

        await expect(page.getByRole("button", { name: "Rename" })).not.toBeAttached();
      },
    );

    test(
      "shows Rename button when user has brands.manage",
      async ({ page }) => {
        await setupPageWithData(page, memberWithPages(["brands.manage"]), {
          stickers: MOCK_STICKERS_WITH_DATA,
        });

        await expect(page.getByRole("button", { name: "Rename" }).first()).toBeVisible({ timeout: 8_000 });
      },
    );
  });
});

test.describe("BrandDetail inline edit controls hidden for restricted users", () => {
  test(
    "brand name h1 has no cursor-pointer class and no rename button for restricted user",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands"]));

      const nameHeading = page.locator("h1").filter({ hasText: "Acme Brand" });
      await expect(nameHeading).not.toHaveClass(/cursor-pointer/);

      await expect(page.locator('button[title="Rename brand"]')).not.toBeAttached();
    },
  );

  test(
    "description and COGS edit button is not in the DOM for restricted user",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands"]));

      await expect(page.getByRole("button", { name: /Add description/i })).not.toBeAttached();
      await expect(page.getByRole("button", { name: /Edit description/i })).not.toBeAttached();
    },
  );

  test(
    "inline name edit input and its Save/Cancel buttons are never attached for restricted user",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands"]));

      // The inline name edit form (input + Save/Cancel) is gated on editingName which requires canEditBrand
      await expect(page.locator("input.text-2xl")).not.toBeAttached();
      // Save and Cancel from the name edit form are rendered only when editingName is true
      // Scope to the brand name area by looking inside the h1's ancestor container
      const brandHeaderSection = page.locator("h1").filter({ hasText: "Acme Brand" }).locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).not.toBeAttached();
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).not.toBeAttached();
    },
  );

  test(
    "inline meta edit controls (Textarea, COGS input, Save/Cancel) are never attached for restricted user",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands"]));

      // The meta edit form (description Textarea + COGS number input + Save/Cancel) requires canEditBrand
      await expect(page.locator("textarea")).not.toBeAttached();
      // Target COGS inline input uses placeholder "e.g. 28" — unique to this inline form on the page
      await expect(page.locator('input[placeholder="e.g. 28"]')).not.toBeAttached();
      // Save and Cancel from the meta edit form only render when editingMeta is true
      const brandHeaderSection = page.locator("h1").filter({ hasText: "Acme Brand" }).locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).not.toBeAttached();
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).not.toBeAttached();
    },
  );

  test(
    "brand name h1 is clickable and rename button is present for an owner",
    async ({ page }) => {
      await setupPage(page, ownerUsersResponse());

      const nameHeading = page.locator("h1").filter({ hasText: "Acme Brand" });
      await expect(nameHeading).toHaveClass(/cursor-pointer/);

      await expect(page.locator('button[title="Rename brand"]')).toBeAttached();

      await expect(page.getByRole("button", { name: /Add description/i })).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "brand name h1 is clickable and rename button is present for user with brands.edit",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands", "brands.edit"]));

      const nameHeading = page.locator("h1").filter({ hasText: "Acme Brand" });
      await expect(nameHeading).toHaveClass(/cursor-pointer/);

      await expect(page.locator('button[title="Rename brand"]')).toBeAttached();

      await expect(page.getByRole("button", { name: /Add description/i })).toBeVisible({ timeout: 8_000 });
    },
  );
});

test.describe("BrandDetail inline editor opens for authorized users", () => {
  test(
    "clicking the brand name h1 reveals the inline name input and Save/Cancel buttons for an owner",
    async ({ page }) => {
      await setupPage(page, ownerUsersResponse());

      const nameHeading = page.locator("h1").filter({ hasText: "Acme Brand" });
      await nameHeading.click();

      await expect(page.locator("input.text-2xl")).toBeVisible({ timeout: 8_000 });

      const brandHeaderSection = page
        .locator("input.text-2xl")
        .locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 8_000 });
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "clicking the Pencil rename button reveals the inline name input and Save/Cancel buttons for an owner",
    async ({ page }) => {
      await setupPage(page, ownerUsersResponse());

      await page.hover("h1");
      const renameBtn = page.locator('button[title="Rename brand"]');
      await expect(renameBtn).toBeAttached({ timeout: 8_000 });
      await renameBtn.click();

      await expect(page.locator("input.text-2xl")).toBeVisible({ timeout: 8_000 });

      const brandHeaderSection = page
        .locator("input.text-2xl")
        .locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 8_000 });
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "clicking the h1 reveals the inline name input for a user with brands.edit",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands", "brands.edit"]));

      const nameHeading = page.locator("h1").filter({ hasText: "Acme Brand" });
      await nameHeading.click();

      await expect(page.locator("input.text-2xl")).toBeVisible({ timeout: 8_000 });

      const brandHeaderSection = page
        .locator("input.text-2xl")
        .locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 8_000 });
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "clicking Add description & COGS reveals the description Textarea for an owner",
    async ({ page }) => {
      await setupPage(page, ownerUsersResponse());

      const addDescBtn = page.getByRole("button", { name: /Add description/i });
      await expect(addDescBtn).toBeVisible({ timeout: 8_000 });
      await addDescBtn.click();

      await expect(page.locator("textarea")).toBeVisible({ timeout: 8_000 });

      const brandHeaderSection = page
        .locator("textarea")
        .locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 8_000 });
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "clicking Add description & COGS reveals the description Textarea for a user with brands.edit",
    async ({ page }) => {
      await setupPage(page, memberWithPages(["brands", "brands.edit"]));

      const addDescBtn = page.getByRole("button", { name: /Add description/i });
      await expect(addDescBtn).toBeVisible({ timeout: 8_000 });
      await addDescBtn.click();

      await expect(page.locator("textarea")).toBeVisible({ timeout: 8_000 });

      const brandHeaderSection = page
        .locator("textarea")
        .locator("xpath=ancestor::div[contains(@class,'flex-1')]");
      await expect(brandHeaderSection.getByRole("button", { name: /^Save$/ })).toBeVisible({ timeout: 8_000 });
      await expect(brandHeaderSection.getByRole("button", { name: /^Cancel$/ })).toBeVisible({ timeout: 8_000 });
    },
  );
});
