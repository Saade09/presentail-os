# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: artifacts/print-agent-web/e2e/purchase-order-receive-flow.spec.ts >> Purchase Order receive flow — header progress bar >> header progress bar is absent for a confirmed PO with zero receipts
- Location: artifacts/print-agent-web/e2e/purchase-order-receive-flow.spec.ts:442:3

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/purchase-orders/150", waiting until "domcontentloaded"

```

# Test source

```ts
  426 |     });
  427 | 
  428 |     // Status badge must show "Received" — target the badge span directly to
  429 |     // avoid strict-mode collisions with "Received Items" and "items received".
  430 |     await expect(page.locator("span.bg-green-100").first()).toBeVisible({ timeout: 8_000 });
  431 | 
  432 |     // The header still renders the progress section for "received" status
  433 |     // (condition: status === "partial" || status === "received")
  434 |     // All 2 items received → text reads "2 / 2 items received"
  435 |     await expect(page.getByText("2 / 2 items received")).toBeVisible({ timeout: 8_000 });
  436 | 
  437 |     // Bar fill must be green (received_items_count >= line_items_count)
  438 |     const greenFill = page.locator(".bg-green-500").first();
  439 |     await expect(greenFill).toBeVisible({ timeout: 8_000 });
  440 |   });
  441 | 
  442 |   test("header progress bar is absent for a confirmed PO with zero receipts", async ({ page }) => {
  443 |     // Mount the PO in "confirmed" status with no received items
  444 |     await page.route("**/api/**", (route) =>
  445 |       route.fulfill({
  446 |         status: 200,
  447 |         contentType: "application/json",
  448 |         body: JSON.stringify({}),
  449 |       }),
  450 |     );
  451 | 
  452 |     await page.route("**/api/users/failed-access-requests**", (route) =>
  453 |       route.fulfill({
  454 |         status: 200,
  455 |         contentType: "application/json",
  456 |         body: JSON.stringify({ failedRequests: [] }),
  457 |       }),
  458 |     );
  459 | 
  460 |     await page.route("**/api/users**", async (route) => {
  461 |       if (route.request().method() === "GET") {
  462 |         return route.fulfill({
  463 |           status: 200,
  464 |           contentType: "application/json",
  465 |           body: JSON.stringify(ownerUsersResponse()),
  466 |         });
  467 |       }
  468 |       await route.continue();
  469 |     });
  470 | 
  471 |     await page.route("**/api/access-requests**", (route) =>
  472 |       route.fulfill({
  473 |         status: 200,
  474 |         contentType: "application/json",
  475 |         body: JSON.stringify({ requests: [] }),
  476 |       }),
  477 |     );
  478 | 
  479 |     await page.route(/\/api\/purchase-orders\/150\/line-items(\?.*)?$/, async (route) => {
  480 |       if (route.request().method() === "GET") {
  481 |         return route.fulfill({
  482 |           status: 200,
  483 |           contentType: "application/json",
  484 |           body: JSON.stringify({
  485 |             line_items: [LINE_ITEM_PENDING, LINE_ITEM_DONE],
  486 |             calculated_total: "400.00",
  487 |           }),
  488 |         });
  489 |       }
  490 |       await route.continue();
  491 |     });
  492 | 
  493 |     await page.route(/\/api\/suppliers\/\d+\/invoices(\?.*)?$/, async (route) => {
  494 |       if (route.request().method() === "GET") {
  495 |         return route.fulfill({
  496 |           status: 200,
  497 |           contentType: "application/json",
  498 |           body: JSON.stringify({ invoices: [] }),
  499 |         });
  500 |       }
  501 |       await route.continue();
  502 |     });
  503 | 
  504 |     await page.route(/\/api\/base-items(\?.*)?$/, async (route) => {
  505 |       if (route.request().method() === "GET") {
  506 |         return route.fulfill({
  507 |           status: 200,
  508 |           contentType: "application/json",
  509 |           body: JSON.stringify({ base_items: [] }),
  510 |         });
  511 |       }
  512 |       await route.continue();
  513 |     });
  514 | 
  515 |     await page.route(/\/api\/purchase-orders\/150(\?.*)?$/, async (route) => {
  516 |       if (route.request().method() === "GET") {
  517 |         return route.fulfill({
  518 |           status: 200,
  519 |           contentType: "application/json",
  520 |           body: JSON.stringify({ purchase_order: CONFIRMED_PO }),
  521 |         });
  522 |       }
  523 |       await route.continue();
  524 |     });
  525 | 
> 526 |     await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
      |                ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  527 |     await expect(page.getByRole("heading", { name: "PO-2026-150" })).toBeVisible({
  528 |       timeout: 15_000,
  529 |     });
  530 | 
  531 |     // Status badge must show "Confirmed"
  532 |     await expect(page.getByText("Confirmed").first()).toBeVisible({ timeout: 8_000 });
  533 | 
  534 |     // The progress bar and item count must NOT be present for "confirmed" status
  535 |     await expect(page.getByText(/\d+ \/ \d+ items received/)).toHaveCount(0, { timeout: 8_000 });
  536 |     await expect(page.locator(".bg-yellow-400")).toHaveCount(0, { timeout: 8_000 });
  537 |     await expect(page.locator(".bg-green-500")).toHaveCount(0, { timeout: 8_000 });
  538 | 
  539 |     // The "Receive stock" button should still be visible so owners can start receiving
  540 |     await expect(page.getByRole("button", { name: /receive stock/i })).toBeVisible({ timeout: 8_000 });
  541 |   });
  542 | });
  543 | 
```