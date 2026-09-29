import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester@presentail.com";
const SUPPLIER_ID = 1;

const BASE_SUPPLIER = {
  id: SUPPLIER_ID,
  workspace_owner_id: "user_owner",
  name: "Alpha Supplies LLC",
  display_name: "Alpha Supplies",
  contact_name: "Jane Doe",
  contact_email: "jane@alphasupplies.com",
  contact_phone: null,
  country: "United Arab Emirates",
  tax_number: "100123456789003",
  supplier_code: null,
  payment_terms: null,
  currency_pref: "AED",
  lead_time_days: null,
  min_order_value: null,
  notes: null,
  is_archived: false,
  item_count: 0,
  invoice_count: 0,
  spend_ytd: "0.00",
  spend_ytd_currency: "AED",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

type StatementRecord = {
  id: string;
  supplier_id: number;
  workspace_owner_id: string;
  statement_month: number;
  statement_year: number;
  statement_date: string | null;
  currency: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  file_url: string;
  original_file_name: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  notes: string | null;
  status: string;
  uploaded_by_member_id: number | null;
  uploaded_by_email: string | null;
  created_at: string;
  updated_at: string;
};

function ownerUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
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
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

// Extract a simple text field value from a raw multipart/form-data body.
function multipartField(body: string, field: string): string | null {
  const re = new RegExp(`name="${field}"\\r?\\n\\r?\\n([^\\r\\n]*)`);
  const m = body.match(re);
  return m ? m[1] : null;
}

// Extract the uploaded file's filename from a raw multipart/form-data body.
function multipartFileName(body: string): string | null {
  const m = body.match(/filename="([^"]+)"/);
  return m ? m[1] : null;
}

async function setupCommonRoutes(
  page: import("@playwright/test").Page,
  statements: StatementRecord[],
) {
  let nextId = 1000;

  // Catch-all registered first so the specific routes below take precedence
  // (Playwright matches the most-recently-registered handler first).
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  // Statement collection: list (GET) + upload (POST), stateful.
  await page.route(
    /\/api\/suppliers\/1\/statements(\?.*)?$/,
    async (route) => {
      const method = route.request().method();
      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ statements }),
        });
        return;
      }
      if (method === "POST") {
        const url = new URL(route.request().url());
        const force = url.searchParams.get("force") === "true";
        const body = route.request().postData() ?? "";
        const month = Number(multipartField(body, "statement_month") ?? "0");
        const year = Number(multipartField(body, "statement_year") ?? "0");
        const currency = multipartField(body, "currency");
        const closing = multipartField(body, "closing_balance");
        const fileName = multipartFileName(body) ?? "statement.pdf";

        const duplicate = statements.some(
          (s) => s.statement_month === month && s.statement_year === year,
        );
        if (duplicate && !force) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error: "A statement already exists for this period.",
            }),
          });
          return;
        }

        const record: StatementRecord = {
          id: String(nextId++),
          supplier_id: SUPPLIER_ID,
          workspace_owner_id: "user_owner",
          statement_month: month,
          statement_year: year,
          statement_date: null,
          currency: currency || null,
          opening_balance: null,
          closing_balance: closing || null,
          file_url: `/objects/${fileName}`,
          original_file_name: fileName,
          mime_type: "application/pdf",
          file_size_bytes: 1024,
          notes: null,
          status: "uploaded",
          uploaded_by_member_id: 1,
          uploaded_by_email: OWNER_EMAIL,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        statements.push(record);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ statement: record }),
        });
        return;
      }
      await route.continue();
    },
  );

  // Single statement: delete, stateful.
  await page.route(
    /\/api\/suppliers\/1\/statements\/[^/?]+(\?.*)?$/,
    async (route) => {
      if (route.request().method() === "DELETE") {
        const url = new URL(route.request().url());
        const id = url.pathname.split("/").pop()!;
        const idx = statements.findIndex((s) => s.id === id);
        if (idx >= 0) statements.splice(idx, 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }
      await route.continue();
    },
  );

  await page.route(/\/api\/suppliers\/1(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ supplier: BASE_SUPPLIER }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ suppliers: [BASE_SUPPLIER] }),
      });
      return;
    }
    await route.continue();
  });
}

async function fillStatementForm(
  page: import("@playwright/test").Page,
  opts: { closing: string; fileName: string },
) {
  const dialog = page.getByRole("alertdialog");
  await expect(
    dialog.getByText("Upload Statement of Account"),
  ).toBeVisible({ timeout: 8_000 });

  // Month select (first select in the dialog) -> March
  await dialog.locator("select").first().selectOption({ label: "March" });
  // Year input -> 2025
  await dialog.locator('input[type="number"]').first().fill("2025");
  // Currency select (second select) -> USD
  await dialog.locator("select").nth(1).selectOption("USD");
  // Number inputs in dialog order: Year (0), Opening Balance (1), Closing Balance (2)
  await dialog.locator('input[type="number"]').nth(2).fill(opts.closing);
  // Attach the file
  await dialog.locator('input[type="file"]').setInputFiles({
    name: opts.fileName,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fake statement content"),
  });
}

async function setupCollectionWorkspaceRoutes(
  page: import("@playwright/test").Page,
  source: "manual" | "scheduled" = "scheduled",
  recipientSnapshot: unknown = [{ id: 21, name: "Jane Finance", email: "jane@alphasupplies.com" }],
  requestStatus = "open",
  includeCommunicationEvent = true,
) {
  await setupCommonRoutes(page, []);

  let requestExists = true;
  const request = {
    id: "request-2026-09",
    supplier_id: SUPPLIER_ID,
    finance_entity_id: 8,
    supplier_name: "Alpha Supplies",
    finance_entity_name: "Presentail UAE",
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    period_label: "September 2026",
    cadence: "monthly",
    source,
    status: requestStatus,
    timezone: "Asia/Beirut",
    next_action: "prepare",
    next_action_at: "2026-10-01T06:30:00.000Z",
    next_recurring_cycle_at: "2026-11-01T06:30:00.000Z",
    journey_version_id: 41,
    journey_snapshot: {
      version: 2,
      steps: [
        { order: 1, channel: "email", delay_minutes: 0, subject: "Statement request", message: "Please send the September statement." },
        { order: 2, channel: "whatsapp", delay_minutes: 60, subject: null, message: "Following up on the statement." },
      ],
    },
    recipients_snapshot: recipientSnapshot,
    first_email_due_at: "2026-10-01T06:30:00.000Z" as string | undefined,
    follow_up_due_at: "2026-10-01T07:30:00.000Z" as string | undefined,
  };
  const schedules = [{
    id: 31,
    supplier_id: SUPPLIER_ID,
    finance_entity_id: 8,
    cadence: "monthly",
    local_day: 1,
    local_time: "09:30",
    timezone: "Asia/Beirut",
    first_run_date: "2026-10-01",
    journey_id: 4,
    is_active: false,
    readiness: "Ready",
    next_run_at: "2026-11-01T07:30:00.000Z",
  }];
  const contacts = [{
    id: 21,
    supplier_id: SUPPLIER_ID,
    name: "Jane Finance",
    role: "Accounts payable",
    department: "Finance",
    email: "jane@alphasupplies.com",
    phone: null,
    whatsapp_phone: "+971501234567",
    is_active: true,
    is_approved: true,
    is_selected: true,
  }, {
    id: 22,
    supplier_id: SUPPLIER_ID,
    name: "Rami Finance",
    role: "Accounts payable",
    department: "Finance",
    email: "rami@alphasupplies.com",
    phone: null,
    whatsapp_phone: "+971501111111",
    is_active: true,
    is_approved: true,
    is_selected: false,
  }];
  const journeys = [{
    id: 4,
    supplier_id: SUPPLIER_ID,
    name: "Monthly collection",
    description: "Email then WhatsApp follow-up",
    current_version: 2,
  }];
  const entities = [{ id: 8, legal_name: "Presentail UAE", display_name: "Presentail UAE", code: "UAE" }];
  let nextContactId = 23;

  await page.route("**/api/finance/entities**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entities }) }),
  );
  await page.route("**/api/supplier-statement-readiness**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ readiness: { email: { configured: true }, whatsapp: { configured: true } } }) }),
  );
  await page.route("**/api/supplier-statement-requests/counts**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ counts: { open: requestExists && request.status === "open" ? 1 : 0, needs_setup: requestExists && request.status === "needs_setup" ? 1 : 0, received: requestExists && request.status === "received" ? 1 : 0, reconciled: requestExists && request.status === "reconciled" ? 1 : 0, total: requestExists ? 1 : 0 } }),
    }),
  );
  await page.route("**/api/supplier-statement-requests/*", async (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/");
    const id = parts[parts.length - 1];
    if (route.request().method() === "GET" && id === "counts") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ counts: { open: requestExists && request.status === "open" ? 1 : 0, needs_setup: requestExists && request.status === "needs_setup" ? 1 : 0, received: requestExists && request.status === "received" ? 1 : 0, reconciled: requestExists && request.status === "reconciled" ? 1 : 0, total: requestExists ? 1 : 0 } }),
      });
      return;
    }
    if (route.request().method() === "DELETE" && id === request.id) {
      requestExists = false;
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (route.request().method() === "GET" && id === request.id) {
      if (!requestExists) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Request not found" }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          request,
          steps: request.journey_snapshot.steps.map((step, index) => ({
            ...step,
            id: index + 1,
            step_order: step.order,
            status: "pending",
            scheduled_at: index === 0 ? request.first_email_due_at ?? "2026-10-01T06:30:00.000Z" : request.follow_up_due_at ?? "2026-10-01T07:30:00.000Z",
          })),
          events: includeCommunicationEvent ? [{ type: "request_created", created_at: "2026-09-01T08:00:00.000Z" }] : [],
          audit_events: [],
          inbound_messages: [],
        }),
      });
      return;
    }
    if (route.request().method() === "PATCH" && id === request.id) {
      const body = route.request().postDataJSON() as { recipient_contact_ids?: number[]; email_due_at?: string };
      if (body.recipient_contact_ids) {
        request.recipients_snapshot = contacts.filter((contact) => body.recipient_contact_ids?.includes(contact.id));
      }
      if (body.email_due_at) {
        request.first_email_due_at = body.email_due_at;
        request.follow_up_due_at = new Date(new Date(body.email_due_at).getTime() + 60 * 60_000).toISOString();
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request }) });
      return;
    }
    if (route.request().method() === "POST") {
      if (parts.at(-1) === "pause") request.status = "paused";
      if (parts.at(-1) === "resume") request.status = "open";
      if (parts.at(-1) === "cancel") request.status = "cancelled";
      if (parts.at(-1) === "receipt") request.status = "received";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ request }) });
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/supplier-statement-requests(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      const status = new URL(route.request().url()).searchParams.get("status");
      const matches = !status
        || (status === "awaiting_reply" && request.status === "open")
        || request.status === status;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requests: requestExists && matches ? [request] : [] }),
      });
      return;
    }
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ request, reused: true }),
      });
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/supplier-statement-requests\/[^/]+\/(pause|resume|cancel|receipt)$/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "pause") request.status = "paused";
    if (action === "resume") request.status = "open";
    if (action === "cancel") request.status = "cancelled";
    if (action === "receipt") request.status = "received";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ request }),
    });
  });
  await page.route("**/api/supplier-statement-schedules", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedules }) });
      return;
    }
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      schedules.push({ ...body, id: 32, readiness: "Ready" });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ schedule: schedules.at(-1) }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/supplier-statement-schedules/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (route.request().method() === "PATCH") {
      const scheduleId = Number(action);
      const schedule = schedules.find((item) => item.id === scheduleId);
      if (!schedule) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Schedule not found" }) });
        return;
      }
      Object.assign(schedule, JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedule }) });
      return;
    }
    if (route.request().method() === "POST" && (action === "pause" || action === "resume")) {
      schedules[0].is_active = action === "resume";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedule: schedules[0] }) });
      return;
    }
    await route.continue();
  });
  await page.route(/\/api\/supplier-statement-schedules\/\d+\/(pause|resume)$/, async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    schedules[0].is_active = action === "resume";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ schedule: schedules[0] }),
    });
  });
  await page.route("**/api/supplier-statement-contacts", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contacts }) });
      return;
    }
    if (route.request().method() === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const contact = { ...body, id: nextContactId++, is_active: true };
      contacts.push(contact);
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ contact }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/supplier-statement-contacts/*", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.continue();
      return;
    }
    const contactId = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    const contact = contacts.find((item) => item.id === contactId);
    if (!contact) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Contact not found" }),
      });
      return;
    }
    Object.assign(contact, JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contact }),
    });
  });
  await page.route("**/api/supplier-statement-journeys", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ journeys }) }),
  );
}

test.describe("Supplier detail — statements end-to-end", () => {
  test("upload, duplicate warning, and delete a statement", async ({ page }) => {
    const statements: StatementRecord[] = [];
    await setupCommonRoutes(page, statements);

    await page.goto(`/suppliers/${SUPPLIER_ID}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(
      page.getByRole("heading", { name: "Alpha Supplies" }),
    ).toBeVisible({ timeout: 15_000 });

    // Switch to the Statements tab
    await page.getByRole("button", { name: "Statements" }).click();
    await expect(page.getByText("No statements uploaded yet")).toBeVisible({
      timeout: 8_000,
    });

    // --- Upload the first statement ---
    await page.getByRole("button", { name: /Upload Statement/i }).click();
    await fillStatementForm(page, {
      closing: "1500.5",
      fileName: "march-2025-statement.pdf",
    });
    await page.getByRole("button", { name: "Upload Statement" }).click();

    // The new row should appear with the correct period, currency, and closing balance
    const firstRow = page
      .getByRole("row")
      .filter({ hasText: "march-2025-statement.pdf" });
    await expect(firstRow).toBeVisible({ timeout: 8_000 });
    await expect(firstRow).toContainText("March 2025");
    await expect(firstRow).toContainText("USD");
    await expect(firstRow).toContainText("USD 1,500.50");

    // --- Re-upload the same supplier + month + year -> duplicate warning ---
    await page.getByRole("button", { name: /Upload Statement/i }).click();
    await fillStatementForm(page, {
      closing: "2000",
      fileName: "march-2025-revised.pdf",
    });
    await page.getByRole("button", { name: "Upload Statement" }).click();

    // The duplicate warning should surface and the action becomes "Upload Anyway"
    await expect(
      page.getByText(/A statement already exists for this supplier/i),
    ).toBeVisible({ timeout: 8_000 });
    const uploadAnyway = page.getByRole("button", { name: "Upload Anyway" });
    await expect(uploadAnyway).toBeVisible();

    // Confirming uploads anyway and succeeds
    await uploadAnyway.click();
    const secondRow = page
      .getByRole("row")
      .filter({ hasText: "march-2025-revised.pdf" });
    await expect(secondRow).toBeVisible({ timeout: 8_000 });
    await expect(secondRow).toContainText("USD 2,000.00");
    // The original statement is still listed
    await expect(firstRow).toBeVisible();

    // --- Delete the revised statement ---
    await secondRow.getByTitle("Delete").click();
    const deleteDialog = page.getByRole("alertdialog");
    await expect(
      deleteDialog.getByText("Delete statement?"),
    ).toBeVisible({ timeout: 8_000 });
    await deleteDialog.getByRole("button", { name: "Delete" }).click();

    // The deleted row is gone; the original remains
    await expect(
      page.getByText("march-2025-revised.pdf"),
    ).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByText("march-2025-statement.pdf")).toBeVisible();
  });
});

test.describe("Supplier statement collection workspace", () => {
  for (const source of ["manual", "scheduled"] as const) {
    test(`edits only the current ${source} request delivery`, async ({ page }) => {
      await setupCollectionWorkspaceRoutes(page, source);
      await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("row-request-request-2026-09").click();

      const detail = page.getByTestId("panel-request-detail");
      await expect(detail.getByTestId("request-delivery-controls")).toBeVisible();
      await expect(detail).toContainText("Jane Finance");
      await expect(detail.getByTestId("journey-step-0")).toContainText("(Asia/Beirut)");
      await expect(detail.getByTestId("journey-step-1")).toContainText("(Asia/Beirut)");
      await expect(detail.getByTestId("input-request-email-due")).toHaveValue("2026-10-01T09:30");
      await expect(detail.getByText("Future recurring cycles continue to use the schedule settings.")).toBeVisible();

      await detail.getByTestId("checkbox-request-delivery-contact-22").check();
      await detail.getByTestId("input-request-email-due").fill("2026-10-02T10:15");
      await detail.getByTestId("button-save-request-delivery").click();
      await expect(page.getByText("Request delivery updated", { exact: true })).toBeVisible();
      await expect(detail).toContainText("Rami Finance");
      await expect(detail.getByTestId("journey-step-0")).toContainText("Oct 2");
      await expect(detail.getByTestId("journey-step-0")).toContainText("10:15 AM");
      await expect(detail.getByTestId("journey-step-1")).toContainText("11:15 AM");
      await expect(detail.getByTestId("journey-step-1")).toContainText("(Asia/Beirut)");
    });
  }

  test("filters requests, opens detail, records receipt, and preserves the journey snapshot", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("heading-supplier-statements")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("metric-open-work")).toContainText("1");
    await expect(page.getByTestId("row-request-request-2026-09")).toContainText("September 2026");

    await page.getByTestId("select-request-channel-filter").selectOption("whatsapp");
    await expect(page.getByTestId("row-request-request-2026-09")).toBeVisible();
    await page.getByTestId("select-request-state").selectOption("received");
    await expect(page.getByTestId("requests-list")).toContainText("Showing 0–0 of 0");
    await page.getByTestId("select-request-state").selectOption("all");

    const requestListUrl = page.url();
    const documentTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    const mainFrameNavigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) mainFrameNavigations.push(frame.url());
    });
    await page.getByTestId("row-request-request-2026-09").click();
    await expect(page.getByTestId("panel-request-detail")).toBeVisible();
    await expect(page.getByTestId("panel-request-detail")).toContainText("v2");
    await expect(page.getByTestId("journey-step-1")).toContainText("+60m");
    expect(page.url()).toBe(requestListUrl);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentTimeOrigin);
    expect(mainFrameNavigations).toEqual([]);

    await page.getByTestId("button-pause-request").click();
    await expect(page.getByText("Request paused", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("button-resume-request")).toBeVisible();
    await page.getByTestId("button-resume-request").click();
    await expect(page.getByText("Request resumed", { exact: true })).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("input-receipt-statement-id").fill("statement-900");
    await page.getByTestId("input-receipt-date").fill("2026-10-05");
    await page.getByTestId("button-record-receipt").click();
    await expect(page.getByText("Receipt recorded", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("panel-request-detail").getByTestId("status-request-received")).toBeVisible();
  });

  test("opens request detail when a legacy recipient snapshot is an object", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page, "scheduled", {});
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("row-request-request-2026-09").click();

    const detail = page.getByTestId("panel-request-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("No active approved recipient is saved on this request");
    await expect(detail.getByTestId("journey-step-0")).toBeVisible();
  });

  test("explains when an exact-period request reuses and opens an existing request", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("button-new-request").click();
    await page.getByTestId("select-request-supplier").selectOption(String(SUPPLIER_ID));
    await page.getByTestId("select-request-entity").selectOption("8");
    await page.getByTestId("input-request-period-start").fill("2026-09-01");
    await page.getByTestId("input-request-period-end").fill("2026-09-30");
    await page.getByTestId("button-submit-request").click();

    await expect(page.getByText("An open request already exists for this period", { exact: true })).toBeVisible();
    await expect(page.getByTestId("dialog-create-request")).not.toBeVisible();
    await expect(page.getByTestId("row-request-request-2026-09")).toBeVisible();
    await expect(page.getByTestId("panel-request-detail")).toContainText("September 2026");
  });

  test("deletes an unused cancelled request after confirmation", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page, "manual", undefined, "cancelled", false);
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("row-request-request-2026-09").click();

    await expect(page.getByTestId("button-delete-request")).toBeEnabled();
    await page.getByTestId("button-delete-request").click();
    await expect(page.getByTestId("dialog-delete-request")).toBeVisible();
    await expect(page.getByTestId("dialog-delete-request")).toContainText("This cannot be undone.");
    await page.getByTestId("button-confirm-delete-request").click();

    await expect(page.getByText("Request deleted", { exact: true })).toBeVisible();
    await expect(page.getByTestId("panel-request-detail")).toHaveCount(0);
    await expect(page.getByTestId("row-request-request-2026-09")).toHaveCount(0);
    await expect(page.getByTestId("empty-state")).toContainText("No collection requests");
  });

  test("pauses/resumes schedules, previews quarterly periods, and adds an approved recipient", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("tab-schedules").click();
    await expect(page.getByTestId("row-schedule-31")).toContainText("Paused");
    await page.getByTestId("button-resume-schedule-31").click();
    await expect(page.getByText("Schedule resumed", { exact: true })).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("button-refresh-statements").click();
    await expect(page.getByTestId("row-schedule-31")).toContainText("Active");

    await page.getByTestId("button-new-schedule").click();
    await page.getByTestId("select-schedule-supplier").selectOption(String(SUPPLIER_ID));
    const journeySelect = page.getByTestId("select-schedule-journey");
    await expect(journeySelect.locator('option[value="4"]')).toBeEnabled();
    await journeySelect.selectOption("4");
    await page.getByTestId("select-schedule-entity").selectOption("8");
    await page.getByTestId("select-schedule-cadence").selectOption("quarterly");
    await page.getByTestId("input-schedule-first-run").fill("2026-10-01");
    await expect(page.getByTestId("schedule-preview")).toContainText("preceding calendar quarter");
    await expect(page.getByTestId("schedule-recipient-list")).toContainText("Jane Finance");
    await page.getByTestId("checkbox-schedule-contact-21").check();
    await page.getByTestId("button-save-schedule").click();
    await expect(page.getByText("Schedule created", { exact: true })).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("tab-contacts").click();
    await expect(page.getByTestId("row-contact-21")).toContainText("Approved");
    await page.getByTestId("button-edit-contact-21").click();
    const phoneCountries = page.getByRole("combobox", { name: "Phone number country" });
    await phoneCountries.nth(0).selectOption("AE");
    await page.getByTestId("input-contact-phone").fill("501234568");
    const contactUpdateRequest = page.waitForRequest((request) =>
      request.url().endsWith("/api/supplier-statement-contacts/21") && request.method() === "PATCH",
    );
    await page.getByTestId("button-save-contact").click();
    expect((await contactUpdateRequest).postDataJSON()).toMatchObject({
      phone: "+971501234568",
      whatsapp_phone: "+971501234567",
    });
    await expect(page.getByText("Contact updated", { exact: true })).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("button-new-contact").click();
    await page.getByTestId("select-contact-supplier").selectOption(String(SUPPLIER_ID));
    await page.getByTestId("input-contact-name").fill("New Supplier Controller");
    await page.getByTestId("input-contact-email").fill("controller@alphasupplies.com");
    await phoneCountries.nth(0).selectOption("AE");
    await page.getByTestId("input-contact-phone").fill("501234567");
    await phoneCountries.nth(1).selectOption("AE");
    await page.getByTestId("input-contact-whatsapp").fill("559876543");
    await page.getByTestId("checkbox-contact-approved").check();
    await page.getByTestId("checkbox-contact-selected").check();
    const contactCreateRequest = page.waitForRequest((request) =>
      request.url().includes("/api/supplier-statement-contacts") && request.method() === "POST",
    );
    await page.getByTestId("button-save-contact").click();
    expect((await contactCreateRequest).postDataJSON()).toMatchObject({
      phone: "+971501234567",
      whatsapp_phone: "+971559876543",
    });
    await expect(page.getByText("Contact added", { exact: true })).toBeVisible({ timeout: 8_000 });
  });

  test("edits an existing schedule without navigating or reloading the workspace", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("tab-schedules").click();
    await expect(page.getByTestId("row-schedule-31")).toBeVisible();

    let documentNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) documentNavigations += 1;
    });

    await page.getByTestId("button-edit-schedule-31").click();
    const editor = page.getByTestId("panel-schedule-editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId("select-schedule-supplier")).toHaveValue(String(SUPPLIER_ID));
    await expect(editor.getByTestId("select-schedule-journey")).toHaveValue("4");
    await expect(editor.getByTestId("select-schedule-entity")).toHaveValue("8");
    await expect(editor.getByTestId("select-schedule-cadence")).toHaveValue("monthly");
    await expect(editor.getByTestId("input-schedule-day")).toHaveValue("1");
    await expect(editor.getByTestId("input-schedule-time")).toHaveValue("09:30");
    await expect(editor.getByTestId("input-schedule-timezone")).toHaveValue("Asia/Beirut");
    await expect(editor.getByTestId("input-schedule-first-run")).toHaveValue("2026-10-01");
    expect(documentNavigations).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/supplier-statements");

    await editor.getByTestId("input-schedule-day").fill("5");
    await editor.getByTestId("input-schedule-time").fill("10:45");
    await editor.getByTestId("input-schedule-first-run").fill("2026-10-05");
    await editor.getByTestId("button-save-schedule").click();

    await expect(page.getByText("Schedule updated", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("panel-schedule-editor")).toHaveCount(0);
    const scheduleRow = page.getByTestId("row-schedule-31");
    await expect(scheduleRow).toContainText("day 5 at 10:45");
    await expect(scheduleRow).toContainText("Asia/Beirut");
    expect(documentNavigations).toBe(0);
    expect(new URL(page.url()).pathname).toBe("/supplier-statements");
    await expect(page.getByTestId("tab-schedules")).toHaveClass(/bg-\[#e8f1ed\]/);
  });

  test("explains when a saved journey is scoped to a different supplier", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.route("**/api/supplier-statement-journeys", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          journeys: [{ id: 99, supplier_id: 2, name: "Other supplier journey" }],
        }),
      }),
    );
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("tab-schedules").click();
    await page.getByTestId("button-new-schedule").click();
    await page.getByTestId("select-schedule-supplier").selectOption(String(SUPPLIER_ID));

    const journeySelect = page.getByTestId("select-schedule-journey");
    await expect(journeySelect.locator('option[value="99"]')).toBeDisabled();
    await expect(journeySelect.locator('option[value="99"]')).toContainText("for Supplier 2");
    await expect(page.getByTestId("schedule-journey-guidance")).toContainText(
      "No journey is configured for Alpha Supplies",
    );
  });

  test("shows a retry action when journeys fail to load", async ({ page }) => {
    await setupCollectionWorkspaceRoutes(page);
    await page.route("**/api/supplier-statement-journeys", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }),
    );
    await page.goto("/supplier-statements", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Supplier statements" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("tab-schedules").click();
    await page.getByTestId("button-new-schedule").click();

    await expect(page.getByTestId("schedule-journey-guidance")).toContainText(
      "Could not load saved journeys",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("button-retry-journeys")).toBeVisible();
  });
});
