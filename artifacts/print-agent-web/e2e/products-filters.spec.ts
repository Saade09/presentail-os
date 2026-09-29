import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupProductsCommonRoutes } from "./helpers/productsCommonRoutes";

const MOCK_BRANDS = [
  { id: 1, name: "BrandAlpha" },
  { id: 2, name: "BrandBeta" },
];

const MOCK_CATEGORIES = ["Packaging", "Stationery"];

const ALL_PRODUCTS = [
  {
    id: 1,
    workspace_owner_id: "user_1",
    name: "Alpha Box",
    price_usd: "10.00",
    price_aed: "36.72",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "available",
    brand: "BrandAlpha",
    tags: [],
    category: "Packaging",
    created_at: new Date().toISOString(),
  },
  {
    id: 2,
    workspace_owner_id: "user_1",
    name: "Beta Card",
    price_usd: "5.00",
    price_aed: "18.36",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "out_of_stock",
    brand: "BrandBeta",
    tags: [],
    category: "Stationery",
    created_at: new Date().toISOString(),
  },
  {
    id: 3,
    workspace_owner_id: "user_1",
    name: "Gamma Tag",
    price_usd: "2.50",
    price_aed: "9.18",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "available",
    brand: "BrandAlpha",
    tags: [],
    category: "Stationery",
    created_at: new Date().toISOString(),
  },
  {
    id: 4,
    workspace_owner_id: "user_1",
    name: "Delta Bag",
    price_usd: "8.00",
    price_aed: "29.38",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "not_available",
    brand: "BrandBeta",
    tags: [],
    category: "Packaging",
    created_at: new Date().toISOString(),
  },
];

function filterProducts(url: string) {
  const u = new URL(url);
  const q = u.searchParams.get("q") ?? "";
  const statuses = u.searchParams.getAll("status");
  const brands = u.searchParams.getAll("brand");
  const categories = u.searchParams.getAll("category");

  return ALL_PRODUCTS.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (statuses.length > 0 && !statuses.includes(p.status)) return false;
    if (brands.length > 0 && !brands.includes(p.brand ?? "")) return false;
    if (categories.length > 0 && !categories.includes(p.category ?? "")) return false;
    return true;
  });
}

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await setupProductsCommonRoutes(page);

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: MOCK_BRANDS }),
    });
  });

  await page.route("**/api/products**", async (route) => {
    const url = route.request().url();
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (url.includes("/categories")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: MOCK_CATEGORIES }),
      });
      return;
    }
    const products = filterProducts(url);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products }),
    });
  });
}

async function setupNavigationRoutes(page: import("@playwright/test").Page) {
  await setupCommonRoutes(page);

  const emptyResponses: Record<string, object> = {
    "**/api/devices**": { devices: [] },
    "**/api/api-keys**": { apiKeys: [] },
    "**/api/print-jobs**": { jobs: [] },
    "**/api/stickers**": { stickers: [] },
    "**/api/downloads/versions**": { versions: [] },
    "**/api/locations**": { locations: [] },
    "**/api/roles**": { roles: [] },
    "**/api/access-requests**": { requests: [] },
  };

  for (const [pattern, body] of Object.entries(emptyResponses)) {
    await page.route(pattern, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
  }
}

test.describe("Products search and filter UI", () => {
  test("typing in the search box debounces and updates the URL ?q= param", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByPlaceholder("Search products…");
    await expect(searchInput).toBeVisible({ timeout: 12_000 });

    await searchInput.fill("Alpha");

    await page.waitForURL(/[?&]q=Alpha/, { timeout: 5_000 });
    expect(page.url()).toContain("q=Alpha");

    await expect(page.getByText("Alpha Box")).toBeVisible();
    await expect(page.getByText("Beta Card")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
  });

  test("selecting a status from the dropdown filters the product list and updates the URL", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();

    const statusTrigger = page.getByRole("button", { name: /All statuses/i });
    await statusTrigger.click();

    const outOfStockOption = page.getByRole("option", {
      name: "Out of Stock",
    });
    await expect(outOfStockOption).toBeVisible({ timeout: 5_000 });
    await outOfStockOption.click();

    await page.waitForURL(/[?&]status=out_of_stock/, { timeout: 5_000 });
    expect(page.url()).toContain("status=out_of_stock");

    await expect(page.getByText("Beta Card")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Alpha Box")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
  });

  test("selecting a brand from the dropdown filters the product list and updates the URL", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const brandTrigger = page.getByRole("button", { name: /All brands/i });
    await brandTrigger.click();

    const brandOption = page.getByRole("option", { name: "BrandBeta" });
    await expect(brandOption).toBeVisible({ timeout: 5_000 });
    await brandOption.click();

    await page.waitForURL(/[?&]brand=BrandBeta/, { timeout: 5_000 });
    expect(page.url()).toContain("brand=BrandBeta");

    await expect(page.getByText("Beta Card")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Alpha Box")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
  });

  test("selecting a category filters the product list and updates the URL", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const categoryTrigger = page.getByRole("button", { name: /All categories/i });
    await categoryTrigger.click();

    const categoryOption = page.getByRole("option", { name: "Packaging" });
    await expect(categoryOption).toBeVisible({ timeout: 5_000 });
    await categoryOption.click();

    await page.waitForURL(/[?&]category=Packaging/, { timeout: 5_000 });
    expect(page.url()).toContain("category=Packaging");

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beta Card")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
  });

  test("selecting two statuses from the popover updates the URL with both params and shows matching products; unchecking one removes only that param", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();

    const statusTrigger = page.getByRole("button", { name: /All statuses/i });
    await statusTrigger.click();

    const availableOption = page.getByRole("option", { name: "Available", exact: true });
    await expect(availableOption).toBeVisible({ timeout: 5_000 });
    await availableOption.click();

    await page.waitForURL(/[?&]status=available/, { timeout: 5_000 });

    const outOfStockOption = page.getByRole("option", { name: "Out of Stock" });
    await expect(outOfStockOption).toBeVisible({ timeout: 5_000 });
    await outOfStockOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("status").includes("available") &&
        url.searchParams.getAll("status").includes("out_of_stock"),
      { timeout: 5_000 },
    );

    const finalUrl = new URL(page.url());
    const selectedStatuses = finalUrl.searchParams.getAll("status");
    expect(selectedStatuses).toContain("available");
    expect(selectedStatuses).toContain("out_of_stock");

    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /2 statuses/i })).toBeVisible({ timeout: 3_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).not.toBeVisible();

    const statusTrigger3 = page.getByRole("button", { name: /2 statuses/i });
    await statusTrigger3.click();

    const availableOptionAgain = page.getByRole("option", { name: "Available", exact: true });
    await expect(availableOptionAgain).toBeVisible({ timeout: 5_000 });
    await availableOptionAgain.click();

    await page.waitForURL(
      (url) =>
        !url.searchParams.getAll("status").includes("available") &&
        url.searchParams.getAll("status").includes("out_of_stock"),
      { timeout: 5_000 },
    );

    expect(page.url()).not.toMatch(/status=available(?!_)/);
    expect(page.url()).toContain("status=out_of_stock");

    await expect(page.getByText("Beta Card")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Alpha Box")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
    await expect(page.getByText("Delta Bag")).not.toBeVisible();
  });

  test("selecting two brands updates the URL with both brand params and shows matching products; unchecking one removes only that brand", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();

    const brandTrigger = page.getByRole("button", { name: /All brands/i });
    await brandTrigger.click();

    const brandAlphaOption = page.getByRole("option", { name: "BrandAlpha" });
    await expect(brandAlphaOption).toBeVisible({ timeout: 5_000 });
    await brandAlphaOption.click();

    await page.waitForURL(/[?&]brand=BrandAlpha/, { timeout: 5_000 });

    const brandBetaOption = page.getByRole("option", { name: "BrandBeta" });
    await expect(brandBetaOption).toBeVisible({ timeout: 5_000 });
    await brandBetaOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("brand").includes("BrandAlpha") &&
        url.searchParams.getAll("brand").includes("BrandBeta"),
      { timeout: 5_000 },
    );

    const afterTwoBrands = new URL(page.url());
    const selectedBrands = afterTwoBrands.searchParams.getAll("brand");
    expect(selectedBrands).toContain("BrandAlpha");
    expect(selectedBrands).toContain("BrandBeta");

    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /2 brands/i })).toBeVisible({ timeout: 3_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();

    const brandTrigger2 = page.getByRole("button", { name: /2 brands/i });
    await brandTrigger2.click();

    const brandAlphaAgain = page.getByRole("option", { name: "BrandAlpha" });
    await expect(brandAlphaAgain).toBeVisible({ timeout: 5_000 });
    await brandAlphaAgain.click();

    await page.waitForURL(
      (url) =>
        !url.searchParams.getAll("brand").includes("BrandAlpha") &&
        url.searchParams.getAll("brand").includes("BrandBeta"),
      { timeout: 5_000 },
    );

    expect(page.url()).not.toContain("brand=BrandAlpha");
    expect(page.url()).toContain("brand=BrandBeta");

    await expect(page.getByText("Beta Card")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Delta Bag")).toBeVisible();
    await expect(page.getByText("Alpha Box")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
  });

  test("selecting two categories updates the URL with both category params and shows matching products; unchecking one removes only that category", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();

    const categoryTrigger = page.getByRole("button", { name: /All categories/i });
    await categoryTrigger.click();

    const packagingOption = page.getByRole("option", { name: "Packaging" });
    await expect(packagingOption).toBeVisible({ timeout: 5_000 });
    await packagingOption.click();

    await page.waitForURL(/[?&]category=Packaging/, { timeout: 5_000 });

    const stationeryOption = page.getByRole("option", { name: "Stationery" });
    await expect(stationeryOption).toBeVisible({ timeout: 5_000 });
    await stationeryOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("category").includes("Packaging") &&
        url.searchParams.getAll("category").includes("Stationery"),
      { timeout: 5_000 },
    );

    const afterTwoCats = new URL(page.url());
    const selectedCats = afterTwoCats.searchParams.getAll("category");
    expect(selectedCats).toContain("Packaging");
    expect(selectedCats).toContain("Stationery");

    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /2 categories/i })).toBeVisible({ timeout: 3_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();

    const categoryTrigger2 = page.getByRole("button", { name: /2 categories/i });
    await categoryTrigger2.click();

    const packagingAgain = page.getByRole("option", { name: "Packaging" });
    await expect(packagingAgain).toBeVisible({ timeout: 5_000 });
    await packagingAgain.click();

    await page.waitForURL(
      (url) =>
        !url.searchParams.getAll("category").includes("Packaging") &&
        url.searchParams.getAll("category").includes("Stationery"),
      { timeout: 5_000 },
    );

    expect(page.url()).not.toContain("category=Packaging");
    expect(page.url()).toContain("category=Stationery");

    await expect(page.getByText("Beta Card")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Alpha Box")).not.toBeVisible();
    await expect(page.getByText("Delta Bag")).not.toBeVisible();
  });

  test("Clear button removes all query params from the URL and shows all products", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products?q=Alpha&status=available&brand=BrandAlpha", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText("Beta Card")).not.toBeVisible();
    await expect(page.getByText("Gamma Tag")).not.toBeVisible();
    await expect(page.getByText("Delta Bag")).not.toBeVisible();

    const clearButton = page.getByRole("button", { name: /Clear/i });
    await expect(clearButton).toBeVisible({ timeout: 5_000 });
    await clearButton.click();

    await page.waitForURL(
      (url) => !url.searchParams.has("q") && !url.searchParams.has("status") && !url.searchParams.has("brand"),
      { timeout: 5_000 },
    );

    expect(page.url()).not.toContain("q=");
    expect(page.url()).not.toContain("status=");
    expect(page.url()).not.toContain("brand=");

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Beta Card")).toBeVisible();
    await expect(page.getByText("Gamma Tag")).toBeVisible();
    await expect(page.getByText("Delta Bag")).toBeVisible();
  });
});

const MANY_PRODUCTS = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  workspace_owner_id: "user_1",
  name: `Product ${String(i + 1).padStart(2, "0")}`,
  price_usd: "1.00",
  price_aed: "3.67",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: i % 3 === 0 ? "available" : i % 3 === 1 ? "out_of_stock" : "not_available",
  brand: i % 2 === 0 ? "BrandAlpha" : "BrandBeta",
  tags: [],
  category: i % 2 === 0 ? "Packaging" : "Stationery",
  sku: null,
  created_at: new Date(2025, 0, 1, 0, 0, i).toISOString(),
}));

function paginatedProducts(url: string) {
  const u = new URL(url);
  const q = u.searchParams.get("q") ?? "";
  const statuses = u.searchParams.getAll("status");
  const brands = u.searchParams.getAll("brand");
  const categories = u.searchParams.getAll("category");
  const rawPage = parseInt(u.searchParams.get("page") ?? "1", 10);
  const rawPageSize = parseInt(u.searchParams.get("pageSize") ?? "25", 10);
  const pageSize = [10, 25, 50, 100].includes(rawPageSize) ? rawPageSize : 25;
  const requestedPage = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const filtered = MANY_PRODUCTS.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (statuses.length > 0 && !statuses.includes(p.status)) return false;
    if (brands.length > 0 && !brands.includes(p.brand ?? "")) return false;
    if (categories.length > 0 && !categories.includes(p.category ?? "")) return false;
    return true;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(requestedPage, totalPages);
  const offset = (safePage - 1) * pageSize;
  const products = filtered.slice(offset, offset + pageSize);

  return { products, total, page: safePage, pageSize, totalPages };
}

async function setupPaginatedRoutes(page: import("@playwright/test").Page) {
  await setupProductsCommonRoutes(page);

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: MOCK_BRANDS }),
    });
  });

  await page.route("**/api/products**", async (route) => {
    const url = route.request().url();
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (url.includes("/categories")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: MOCK_CATEGORIES }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(paginatedProducts(url)),
    });
  });
}

test.describe("Products pagination", () => {
  test("changing a filter resets the page to 1 (URL drops the page param)", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPaginatedRoutes(page);

    await page.goto("/products?page=2&pageSize=10", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Product 11")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Page 2 of 3/)).toBeVisible({ timeout: 5_000 });
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");

    const statusTrigger = page.getByRole("button", { name: /All statuses/i });
    await statusTrigger.click();

    const availableOption = page.getByRole("option", { name: "Available", exact: true });
    await expect(availableOption).toBeVisible({ timeout: 5_000 });
    await availableOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("status").includes("available") &&
        (!url.searchParams.has("page") || url.searchParams.get("page") === "1"),
      { timeout: 5_000 },
    );

    const finalUrl = new URL(page.url());
    expect(finalUrl.searchParams.getAll("status")).toContain("available");
    const pageParam = finalUrl.searchParams.get("page");
    expect(pageParam === null || pageParam === "1").toBe(true);
    expect(finalUrl.searchParams.get("pageSize")).toBe("10");

    await expect(page.getByText(/Page 1 of \d+/)).toBeVisible({ timeout: 5_000 });
  });

  test("page and pageSize survive a hard refresh", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupPaginatedRoutes(page);

    await page.goto("/products?page=2&pageSize=10", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Product 11")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Page 2 of 3/)).toBeVisible({ timeout: 5_000 });

    const beforeUrl = new URL(page.url());
    expect(beforeUrl.searchParams.get("page")).toBe("2");
    expect(beforeUrl.searchParams.get("pageSize")).toBe("10");

    await page.reload();

    await expect(page.getByText("Product 11")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Page 2 of 3/)).toBeVisible({ timeout: 5_000 });

    const afterUrl = new URL(page.url());
    expect(afterUrl.searchParams.get("page")).toBe("2");
    expect(afterUrl.searchParams.get("pageSize")).toBe("10");

    // Items from page 1 should not be on page 2
    await expect(page.getByText("Product 01", { exact: true })).not.toBeVisible();
    // Items from page 3 should not be on page 2
    await expect(page.getByText("Product 21", { exact: true })).not.toBeVisible();
  });

  test("Previous is disabled on page 1 and Next is disabled on the last page", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPaginatedRoutes(page);

    // First page: Previous disabled, Next enabled
    await page.goto("/products?pageSize=10", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Product 01")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Page 1 of 3/)).toBeVisible({ timeout: 5_000 });

    const prevButton = page.getByRole("button", { name: /Previous page/i });
    const nextButton = page.getByRole("button", { name: /Next page/i });

    await expect(prevButton).toBeDisabled();
    await expect(nextButton).toBeEnabled();

    // Last page: Next disabled, Previous enabled
    await page.goto("/products?page=3&pageSize=10", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Product 21")).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(/Page 3 of 3/)).toBeVisible({ timeout: 5_000 });

    const prevButtonLast = page.getByRole("button", { name: /Previous page/i });
    const nextButtonLast = page.getByRole("button", { name: /Next page/i });

    await expect(nextButtonLast).toBeDisabled();
    await expect(prevButtonLast).toBeEnabled();
  });
});

test.describe("Products multi-value filter session storage persistence", () => {
  test("two selected brands are restored from session storage after navigating away and back", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupNavigationRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const brandTrigger = page.getByRole("button", { name: /All brands/i });
    await brandTrigger.click();

    const brandAlphaOption = page.getByRole("option", { name: "BrandAlpha" });
    await expect(brandAlphaOption).toBeVisible({ timeout: 5_000 });
    await brandAlphaOption.click();

    await page.waitForURL(/[?&]brand=BrandAlpha/, { timeout: 5_000 });

    const brandBetaOption = page.getByRole("option", { name: "BrandBeta" });
    await expect(brandBetaOption).toBeVisible({ timeout: 5_000 });
    await brandBetaOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("brand").includes("BrandAlpha") &&
        url.searchParams.getAll("brand").includes("BrandBeta"),
      { timeout: 5_000 },
    );

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /2 brands/i })).toBeVisible({ timeout: 3_000 });

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("brand").includes("BrandAlpha") &&
        url.searchParams.getAll("brand").includes("BrandBeta"),
      { timeout: 10_000 },
    );

    const restoredUrl = new URL(page.url());
    const restoredBrands = restoredUrl.searchParams.getAll("brand");
    expect(restoredBrands).toContain("BrandAlpha");
    expect(restoredBrands).toContain("BrandBeta");
  });

  test("two selected categories are restored from session storage after navigating away and back", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupNavigationRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const categoryTrigger = page.getByRole("button", { name: /All categories/i });
    await categoryTrigger.click();

    const packagingOption = page.getByRole("option", { name: "Packaging" });
    await expect(packagingOption).toBeVisible({ timeout: 5_000 });
    await packagingOption.click();

    await page.waitForURL(/[?&]category=Packaging/, { timeout: 5_000 });

    const stationeryOption = page.getByRole("option", { name: "Stationery" });
    await expect(stationeryOption).toBeVisible({ timeout: 5_000 });
    await stationeryOption.click();

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("category").includes("Packaging") &&
        url.searchParams.getAll("category").includes("Stationery"),
      { timeout: 5_000 },
    );

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /2 categories/i })).toBeVisible({ timeout: 3_000 });

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("category").includes("Packaging") &&
        url.searchParams.getAll("category").includes("Stationery"),
      { timeout: 10_000 },
    );

    const restoredUrl = new URL(page.url());
    const restoredCategories = restoredUrl.searchParams.getAll("category");
    expect(restoredCategories).toContain("Packaging");
    expect(restoredCategories).toContain("Stationery");
  });

  test("selected status filter is restored from session storage after navigating away and back", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupNavigationRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const statusTrigger = page.getByRole("button", { name: /All statuses/i });
    await statusTrigger.click();

    const availableOption = page.getByRole("option", { name: "Available", exact: true });
    await expect(availableOption).toBeVisible({ timeout: 5_000 });
    await availableOption.click();

    await page.waitForURL(/[?&]status=available/, { timeout: 5_000 });
    expect(page.url()).toContain("status=available");

    await page.keyboard.press("Escape");

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await page.waitForURL(
      (url) => url.searchParams.getAll("status").includes("available"),
      { timeout: 10_000 },
    );

    const restoredUrl = new URL(page.url());
    expect(restoredUrl.searchParams.getAll("status")).toContain("available");
  });

  test("search query is restored from session storage after navigating away and back", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupNavigationRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const searchInput = page.getByPlaceholder("Search products…");
    await expect(searchInput).toBeVisible({ timeout: 12_000 });

    await searchInput.fill("Alpha");

    await page.waitForURL(/[?&]q=Alpha/, { timeout: 5_000 });
    expect(page.url()).toContain("q=Alpha");

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await page.waitForURL(
      (url) => url.searchParams.get("q") === "Alpha",
      { timeout: 10_000 },
    );

    const restoredUrl = new URL(page.url());
    expect(restoredUrl.searchParams.get("q")).toBe("Alpha");
  });

  test("clicking Clear immediately empties the sessionStorage filter state without requiring navigation", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);

    await page.goto("/products?q=Alpha&status=available&brand=BrandAlpha", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    await page.evaluate(() => {
      sessionStorage.setItem(
        "products_filter_state",
        JSON.stringify({ q: "Alpha", status: ["available"], brand: ["BrandAlpha"], category: [] }),
      );
    });

    const keyBefore = await page.evaluate(() =>
      sessionStorage.getItem("products_filter_state"),
    );
    expect(keyBefore).not.toBeNull();
    const parsedBefore = JSON.parse(keyBefore!);
    expect(parsedBefore.q).toBe("Alpha");
    expect(parsedBefore.status).toContain("available");
    expect(parsedBefore.brand).toContain("BrandAlpha");

    const clearButton = page.getByRole("button", { name: /Clear/i });
    await expect(clearButton).toBeVisible({ timeout: 5_000 });
    await clearButton.click();

    const keyAfter = await page.evaluate(() =>
      sessionStorage.getItem("products_filter_state"),
    );
    expect(keyAfter).toBeNull();
  });

  test("clicking Clear wipes saved filter state so filters are not restored on the next visit", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupNavigationRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const statusTrigger = page.getByRole("button", { name: /All statuses/i });
    await statusTrigger.click();

    const availableOption = page.getByRole("option", { name: "Available", exact: true });
    await expect(availableOption).toBeVisible({ timeout: 5_000 });
    await availableOption.click();

    await page.waitForURL(/[?&]status=available/, { timeout: 5_000 });
    await page.keyboard.press("Escape");

    const searchInput = page.getByPlaceholder("Search products…");
    await searchInput.fill("Alpha");
    await page.waitForURL(/[?&]q=Alpha/, { timeout: 5_000 });

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await page.waitForURL(
      (url) =>
        url.searchParams.getAll("status").includes("available") &&
        url.searchParams.get("q") === "Alpha",
      { timeout: 10_000 },
    );

    const clearButton = page.getByRole("button", { name: /Clear/i });
    await expect(clearButton).toBeVisible({ timeout: 5_000 });
    await clearButton.click();

    await page.waitForURL(
      (url) =>
        !url.searchParams.has("q") &&
        !url.searchParams.has("status") &&
        !url.searchParams.has("brand") &&
        !url.searchParams.has("category"),
      { timeout: 5_000 },
    );

    await page.goto("/users", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

    const finalUrl = new URL(page.url());
    expect(finalUrl.searchParams.has("q")).toBe(false);
    expect(finalUrl.searchParams.has("status")).toBe(false);
    expect(finalUrl.searchParams.has("brand")).toBe(false);
    expect(finalUrl.searchParams.has("category")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page-jump input — direct navigation to a specific page number
// ---------------------------------------------------------------------------

const PAGINATION_TOTAL = 200;
const PAGINATION_DEFAULT_PAGE_SIZE = 25;

function generatePaginatedProducts(page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, PAGINATION_TOTAL);
  const items = [];
  for (let i = start; i < end; i++) {
    items.push({
      id: i + 1,
      workspace_owner_id: "user_1",
      name: `Product ${i + 1}`,
      price_usd: "1.00",
      price_aed: "3.67",
      main_image_url: null,
      additional_image_urls: [],
      description: null,
      status: "available",
      brand: "BrandAlpha",
      tags: [],
      category: "Packaging",
      created_at: new Date().toISOString(),
    });
  }
  return items;
}

async function setupPageJumpRoutes(page: import("@playwright/test").Page) {
  await setupProductsCommonRoutes(page);

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: MOCK_BRANDS }),
    });
  });

  await page.route("**/api/products**", async (route) => {
    const url = route.request().url();
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    if (url.includes("/categories")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: MOCK_CATEGORIES }),
      });
      return;
    }
    const u = new URL(url);
    const pageNum = Number(u.searchParams.get("page") ?? "1") || 1;
    const pageSize = Number(u.searchParams.get("pageSize") ?? String(PAGINATION_DEFAULT_PAGE_SIZE)) || PAGINATION_DEFAULT_PAGE_SIZE;
    const products = generatePaginatedProducts(pageNum, pageSize);
    const totalPages = Math.max(1, Math.ceil(PAGINATION_TOTAL / pageSize));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        products,
        total: PAGINATION_TOTAL,
        page: pageNum,
        pageSize,
        totalPages,
      }),
    });
  });
}

test.describe("Products page-jump input", () => {
  test("renders the page-jump input pre-filled with the current page and the total page count", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });
    await expect(pageInput).toHaveValue("1");
    // 200 items / 25 per page = 8 pages
    await expect(page.getByText("of 8")).toBeVisible();
  });

  test("typing a page number and pressing Enter navigates to that page", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });

    await pageInput.fill("5");
    await pageInput.press("Enter");

    await page.waitForURL(/[?&]page=5(&|$)/, { timeout: 5_000 });
    await expect(pageInput).toHaveValue("5");
    await expect(page.getByText("Product 101", { exact: true })).toBeVisible();
  });

  test("typing a page number and tabbing away navigates to that page", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });

    await pageInput.fill("3");
    await pageInput.blur();

    await page.waitForURL(/[?&]page=3(&|$)/, { timeout: 5_000 });
    await expect(pageInput).toHaveValue("3");
  });

  test("clamps a page number above the maximum to the last page", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });

    await pageInput.fill("999");
    await pageInput.press("Enter");

    // 200 items / 25 per page = 8 pages, so 999 clamps to 8
    await page.waitForURL(/[?&]page=8(&|$)/, { timeout: 5_000 });
    await expect(pageInput).toHaveValue("8");
  });

  test("clamps a page number below 1 to page 1", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products?page=4", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });
    await expect(pageInput).toHaveValue("4");

    await pageInput.fill("0");
    await pageInput.press("Enter");

    await expect(pageInput).toHaveValue("1");
  });

  test("clears non-numeric input back to the current page on commit", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupPageJumpRoutes(page);

    await page.goto("/products?page=2", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });

    const pageInput = page.getByTestId("input-page-jump");
    await expect(pageInput).toBeVisible({ timeout: 12_000 });
    await expect(pageInput).toHaveValue("2");

    await pageInput.fill("abc");
    await pageInput.press("Enter");

    await expect(pageInput).toHaveValue("2");
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");
  });
});
