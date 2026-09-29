import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  emptyPaymentLinksResponse,
  setupPaymentLinksCommonRoutes,
} from "./helpers/paymentLinksCommonRoutes";

function stripePaymentLinkResponse(publicUrl: string, checkoutUrl: string) {
  return {
    payment_link: {
      id: 101,
      workspace_owner_id: "owner_clerk_id",
      amount: 2500,
      currency: "USD",
      provider: "stripe",
      description: "Test item",
      status: "active",
      provider_link_id: "cs_test_abc123",
      provider_checkout_url: checkoutUrl,
      public_token: "deadbeefdeadbeef0123456789abcdef",
      public_url: publicUrl,
      created_at: new Date().toISOString(),
      paid_at: null,
    },
  };
}

function paypalPaymentLinkResponse(publicUrl: string, approvalUrl: string) {
  return {
    payment_link: {
      id: 202,
      workspace_owner_id: "owner_clerk_id",
      amount: 5000,
      currency: "USD",
      provider: "paypal",
      description: null,
      status: "active",
      provider_link_id: "ORDER-PAYPAL-9999",
      provider_checkout_url: approvalUrl,
      public_token: "aabbccdd11223344aabbccdd11223344",
      public_url: publicUrl,
      created_at: new Date().toISOString(),
      paid_at: null,
    },
  };
}


test.describe("Payment link creation flow", () => {
  test(
    "owner can create a Stripe payment link and receives a checkout URL",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      const STRIPE_CHECKOUT_URL = "https://checkout.stripe.com/pay/cs_test_abc123";
      const PUBLIC_URL = "https://example.replit.dev/pay/deadbeefdeadbeef0123456789abcdef";

      let createCallCount = 0;
      let capturedCreateBody: unknown = null;

      await setupPaymentLinksCommonRoutes(page);

      await page.route("**/api/payment-links", async (route) => {
        const method = route.request().method();

        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }

        if (method === "POST") {
          capturedCreateBody = JSON.parse(route.request().postData() ?? "{}");
          createCallCount++;
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify(stripePaymentLinkResponse(PUBLIC_URL, STRIPE_CHECKOUT_URL)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      // Open the create dialog
      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      // Fill in amount
      const amountInput = page.getByTestId("input-payment-amount");
      await expect(amountInput).toBeVisible({ timeout: 5_000 });
      await amountInput.fill("25.00");

      // Select a country (required before provider buttons unlock)
      const countryTrigger = page.getByTestId("select-country");
      await countryTrigger.click();
      await page.getByRole("option", { name: "UAE" }).click();

      // Stripe is the default provider — ensure it is selected
      const stripeProviderButton = page.getByTestId("button-provider-stripe");
      await stripeProviderButton.click();

      // Submit the form
      const submitButton = page.getByTestId("button-create-submit");
      await expect(submitButton).toBeEnabled();
      await submitButton.click();

      // Success dialog should appear
      const successDialog = page.getByTestId("dialog-payment-link-success");
      await expect(successDialog).toBeVisible({ timeout: 8_000 });

      // The public URL should be displayed
      const publicUrlEl = page.getByTestId("text-public-url");
      await expect(publicUrlEl).toBeVisible();
      await expect(publicUrlEl).toContainText(PUBLIC_URL);

      // The Stripe checkout URL must be rendered as a link so the owner can use it
      const checkoutLink = page.getByTestId("link-checkout-url");
      await expect(checkoutLink).toBeVisible();
      await expect(checkoutLink).toHaveAttribute("href", STRIPE_CHECKOUT_URL);
      await expect(checkoutLink).toContainText(STRIPE_CHECKOUT_URL);

      // Verify the API was called exactly once with the correct payload
      expect(createCallCount).toBe(1);
      expect(capturedCreateBody).toMatchObject({
        amount: 25,
        currency: "USD",
        provider: "stripe",
        country: "UAE",
      });
    },
  );

  test(
    "owner can create a PayPal payment link and receives an approval URL",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      const PAYPAL_APPROVAL_URL = "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-PAYPAL-9999";
      const PUBLIC_URL = "https://example.replit.dev/pay/aabbccdd11223344aabbccdd11223344";

      let createCallCount = 0;
      let capturedCreateBody: unknown = null;

      await setupPaymentLinksCommonRoutes(page);

      await page.route("**/api/payment-links", async (route) => {
        const method = route.request().method();

        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }

        if (method === "POST") {
          capturedCreateBody = JSON.parse(route.request().postData() ?? "{}");
          createCallCount++;
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify(paypalPaymentLinkResponse(PUBLIC_URL, PAYPAL_APPROVAL_URL)),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      // Open the create dialog
      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      // Fill in amount
      const amountInput = page.getByTestId("input-payment-amount");
      await expect(amountInput).toBeVisible({ timeout: 5_000 });
      await amountInput.fill("50.00");

      // Select a country (required before provider buttons unlock)
      const countryTrigger = page.getByTestId("select-country");
      await countryTrigger.click();
      await page.getByRole("option", { name: "UK" }).click();

      // Switch to PayPal provider
      const paypalProviderButton = page.getByTestId("button-provider-paypal");
      await paypalProviderButton.click();

      // Submit the form
      const submitButton = page.getByTestId("button-create-submit");
      await expect(submitButton).toBeEnabled();
      await submitButton.click();

      // Success dialog should appear
      const successDialog = page.getByTestId("dialog-payment-link-success");
      await expect(successDialog).toBeVisible({ timeout: 8_000 });

      // The public URL should be displayed
      const publicUrlEl = page.getByTestId("text-public-url");
      await expect(publicUrlEl).toBeVisible();
      await expect(publicUrlEl).toContainText(PUBLIC_URL);

      // The PayPal approval URL must be rendered as a link so the owner can use it
      const approvalLink = page.getByTestId("link-checkout-url");
      await expect(approvalLink).toBeVisible();
      await expect(approvalLink).toHaveAttribute("href", PAYPAL_APPROVAL_URL);
      await expect(approvalLink).toContainText(PAYPAL_APPROVAL_URL);

      // Verify the API was called once with paypal as the provider and the selected country
      expect(createCallCount).toBe(1);
      expect(capturedCreateBody).toMatchObject({
        amount: 50,
        currency: "USD",
        provider: "paypal",
        country: "UK",
      });
    },
  );
});

test.describe("Country / Destination field behaviour", () => {
  test(
    "country dropdown is visible in the create dialog and provider buttons are disabled without a selection",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupPaymentLinksCommonRoutes(page);

      await page.route("**/api/payment-links", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      // Country dropdown must be present
      const countryTrigger = page.getByTestId("select-country");
      await expect(countryTrigger).toBeVisible({ timeout: 5_000 });

      // Provider buttons must be disabled before a country is selected
      await expect(page.getByTestId("button-provider-stripe")).toBeDisabled();
      await expect(page.getByTestId("button-provider-paypal")).toBeDisabled();

      // Submit button must be disabled even with a valid amount but no country
      await page.getByTestId("input-payment-amount").fill("10.00");
      await expect(page.getByTestId("button-create-submit")).toBeDisabled();

      // After selecting a country all provider buttons become enabled
      await countryTrigger.click();
      await page.getByRole("option", { name: "USA" }).click();
      await expect(page.getByTestId("button-provider-stripe")).toBeEnabled();
      await expect(page.getByTestId("button-provider-paypal")).toBeEnabled();

      // And the submit button unlocks
      await expect(page.getByTestId("button-create-submit")).toBeEnabled();
    },
  );

  test(
    "selected country is sent to the API when the form is submitted",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      const STRIPE_CHECKOUT_URL = "https://checkout.stripe.com/pay/cs_test_country";
      const PUBLIC_URL = "https://example.replit.dev/pay/countrytoken0123456789";

      let capturedCreateBody: unknown = null;

      await setupPaymentLinksCommonRoutes(page);

      await page.route("**/api/payment-links", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }
        if (method === "POST") {
          capturedCreateBody = JSON.parse(route.request().postData() ?? "{}");
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify(stripePaymentLinkResponse(PUBLIC_URL, STRIPE_CHECKOUT_URL)),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      await page.getByTestId("input-payment-amount").fill("15.00");

      // Select country
      await page.getByTestId("select-country").click();
      await page.getByRole("option", { name: "USA" }).click();

      // Submit
      await page.getByTestId("button-create-submit").click();

      await expect(page.getByTestId("dialog-payment-link-success")).toBeVisible({ timeout: 8_000 });

      // Country must be present in the API payload
      expect(capturedCreateBody).toMatchObject({ country: "USA" });
    },
  );
});

test.describe("Country allowlist enforcement", () => {
  test(
    "country dropdown shows exactly the countries from workspace settings and no others",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      const ALLOWED_COUNTRIES = ["Atlantis", "Wakanda", "Narnia"];

      await setupPaymentLinksCommonRoutes(page, {
        getSettingsResponse: () => ({ available_countries: ALLOWED_COUNTRIES }),
      });

      await page.route("**/api/payment-links", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      // Open the country dropdown
      const countryTrigger = page.getByTestId("select-country");
      await expect(countryTrigger).toBeVisible({ timeout: 5_000 });
      await countryTrigger.click();

      // Each allowed country must appear as a selectable option
      for (const country of ALLOWED_COUNTRIES) {
        await expect(page.getByRole("option", { name: country })).toBeVisible();
      }

      // Countries NOT in the allowlist must not appear in the dropdown
      const disallowedCountries = ["UAE", "UK", "USA", "Lebanon", "United Arab Emirates"];
      for (const country of disallowedCountries) {
        await expect(page.getByRole("option", { name: country })).not.toBeVisible();
      }

      // Exactly the right number of options should be present
      const options = page.getByRole("option");
      await expect(options).toHaveCount(ALLOWED_COUNTRIES.length);
    },
  );

  test(
    "an invalid country rejected by the API surfaces a visible error in the UI",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      // The workspace settings expose only ["UAE", "UK", "USA"] in the UI
      // (via setupCommonRoutes). The API, however, is configured with a stricter
      // allowlist of ["Lebanon", "United Arab Emirates"]. This simulates a client
      // that bypasses the UI validation — e.g. a script or browser-console POST —
      // and submits a country that the server considers out-of-range.
      const WORKSPACE_API_ALLOWLIST = ["Lebanon", "United Arab Emirates"];
      const COUNTRY_ERROR = `country must be one of the accepted values: ${WORKSPACE_API_ALLOWLIST.join(", ")}`;

      let capturedRequestBody: Record<string, unknown> | null = null;

      await setupPaymentLinksCommonRoutes(page);

      await page.route("**/api/payment-links", async (route) => {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(emptyPaymentLinksResponse()),
          });
          return;
        }
        if (method === "POST") {
          // Capture the payload so the test can assert the country that was sent
          capturedRequestBody = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
          // The server rejects the submitted country as outside its allowlist
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: COUNTRY_ERROR }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/payment-links", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Payment Links" })).toBeVisible({ timeout: 15_000 });

      const createButton = page.getByTestId("button-create-payment-link");
      await expect(createButton).toBeVisible({ timeout: 12_000 });
      await createButton.click();

      await page.getByTestId("input-payment-amount").fill("20.00");

      // Select "UAE" — which is in the UI's settings mock but NOT in the API's
      // allowlist (WORKSPACE_API_ALLOWLIST), mimicking an out-of-range submission.
      await page.getByTestId("select-country").click();
      await page.getByRole("option", { name: "UAE" }).click();

      // Submit — the API will reject "UAE" as outside its allowlist
      await page.getByTestId("button-create-submit").click();

      // Verify the submitted country was included in the POST body
      expect(capturedRequestBody).toMatchObject({ country: "UAE" });
      // "UAE" must not be in the API-level allowlist for this test to be meaningful
      expect(WORKSPACE_API_ALLOWLIST).not.toContain(capturedRequestBody!.country);

      // A destructive toast describing the country error must be visible
      const errorText = page.getByText("country must be one of the accepted values");
      await expect(errorText).toBeVisible({ timeout: 8_000 });
    },
  );
});
