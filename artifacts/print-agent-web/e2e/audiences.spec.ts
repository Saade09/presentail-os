import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";

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
    me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
  };
}

const FIELDS = {
  fields: [
    { key: "total_spent", label: "Total spent (USD)", group: "purchasing", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"] },
    { key: "gifts_sent_count", label: "Gifts sent", group: "purchasing", type: "number", operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"] },
    { key: "last_order_at", label: "Last order date", group: "purchasing", type: "date", operators: ["before", "after", "between", "within_last_days", "more_than_days_ago", "is_set", "is_missing"] },
    { key: "is_suppressed", label: "Globally suppressed", group: "channels", type: "boolean", operators: ["is_true", "is_false"] },
    { key: "valid_email", label: "Valid email", group: "data_quality", type: "boolean", operators: ["is_true", "is_false"] },
    { key: "valid_phone", label: "Valid phone", group: "data_quality", type: "boolean", operators: ["is_true", "is_false"] },
  ],
};

const METRICS = {
  matched: 42,
  emailReachable: 30,
  whatsappReachable: 25,
  bothReachable: 20,
  excluded: 3,
  avgLifetimeSpendUsd: 812.5,
};

const SAMPLE_CONTACT = {
  id: "c-1",
  displayName: "Layla Haddad",
  email: "layla@example.com",
  phone: "+96170000000",
  emailReachable: true,
  whatsappReachable: true,
  totalSpentUsd: 1200,
  evidence: [
    { path: "include.conditions[0]", field: "total_spent", operator: "gte", value: 500, actual: 1200, matched: true },
    { path: "include.conditions[1]", field: "gifts_sent_count", operator: "gte", value: 2, actual: 4, matched: true },
  ],
  nearMissExclusions: [],
};

function makeAudience(overrides: Record<string, unknown> = {}) {
  return {
    id: "aud-1",
    name: "Lapsed high-value gift senders",
    description: "",
    kind: "dynamic",
    status: "active",
    rules: {
      schemaVersion: 1,
      include: {
        logic: "ALL",
        conditions: [
          { field: "total_spent", operator: "gte", value: 500 },
          { field: "gifts_sent_count", operator: "gte", value: 2 },
          { field: "last_order_at", operator: "more_than_days_ago", value: 180 },
        ],
        groups: [],
      },
      exclude: { logic: "ALL", conditions: [{ field: "is_suppressed", operator: "is_true" }], groups: [] },
    },
    rules_summary: "Contacts where Total spent (USD) is at least $500…",
    cached_counts: METRICS,
    member_count: 42,
    last_evaluated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

type State = { audiences: ReturnType<typeof makeAudience>[] };

async function setupRoutes(page: Page, state: State) {
  await page.route("**/api/users/failed-access-requests**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ failedRequests: [] }) }),
  );
  await page.route("**/api/users**", async (r) => {
    if (r.request().method() === "GET") {
      await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ownerUsersResponse()) });
      return;
    }
    await r.continue();
  });
  await page.route("**/api/access-requests**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
  );

  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/audiences/fields**", (r) => r.fulfill(json(FIELDS)));
  await page.route("**/api/audiences/summary**", (r) =>
    r.fulfill(
      json({
        marketable_contacts: 1200,
        email_reachable: 800,
        whatsapp_reachable: 650,
        recipients_not_converted: 300,
      }),
    ),
  );
  await page.route("**/api/audiences/templates**", (r) =>
    r.fulfill(
      json({
        templates: [
          {
            key: "lapsed_gift_senders",
            name: "Lapsed high-value gift senders",
            description: "High spenders who send gifts but have gone quiet.",
            editableParams: [],
            rules: makeAudience().rules,
            rules_summary: "…",
            metrics: METRICS,
          },
        ],
      }),
    ),
  );
  await page.route("**/api/audiences/validate**", (r) =>
    r.fulfill(json({ valid: true, rule_errors: [] })),
  );
  // NOTE: Playwright gives precedence to the MOST RECENTLY registered route,
  // so generic patterns are registered before more specific ones.
  await page.route("**/api/audiences", async (r) => {
    const method = r.request().method();
    if (method === "GET") {
      return r.fulfill(
        json({ audiences: state.audiences, total: state.audiences.length, page: 1, limit: 25 }),
      );
    }
    if (method === "POST") {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      const created = makeAudience({ ...body, id: "aud-1" });
      state.audiences = [created, ...state.audiences.filter((a) => a.id !== "aud-1")];
      return r.fulfill(json({ audience: created }));
    }
    await r.continue();
  });
  await page.route("**/api/audiences?**", async (r) => {
    if (r.request().method() === "GET") {
      return r.fulfill(
        json({ audiences: state.audiences, total: state.audiences.length, page: 1, limit: 25 }),
      );
    }
    await r.continue();
  });
  await page.route("**/api/audiences/preview**", (r) =>
    r.fulfill(json({ metrics: METRICS, summary: "…" })),
  );
  await page.route("**/api/audiences/preview/contacts**", (r) =>
    r.fulfill(json({ contacts: [SAMPLE_CONTACT], total: 42, page: 1, limit: 5 })),
  );
  await page.route("**/api/audiences/aud-1**", async (r) => {
    const method = r.request().method();
    const existing = state.audiences.find((a) => a.id === "aud-1");
    if (method === "GET") return r.fulfill(json({ audience: existing ?? makeAudience() }));
    if (method === "PATCH" || method === "PUT") {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      state.audiences = state.audiences.map((a) => (a.id === "aud-1" ? { ...a, ...body } : a));
      return r.fulfill(json({ audience: state.audiences.find((a) => a.id === "aud-1") }));
    }
    await r.continue();
  });
  await page.route("**/api/audiences/aud-1/contacts**", (r) =>
    r.fulfill(json({ contacts: [SAMPLE_CONTACT], total: 1, page: 1, limit: 25 })),
  );
  await page.route("**/api/audiences/aud-1/archive**", (r) => {
    state.audiences = state.audiences.map((a) =>
      a.id === "aud-1" ? { ...a, status: "archived", archived_at: new Date().toISOString() } : a,
    );
    return r.fulfill(json({ audience: state.audiences.find((a) => a.id === "aud-1") }));
  });
}

test.describe("Audiences UI", () => {
  test("sidebar Contacts group navigates to Audiences and stays expanded", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    // On the Audiences route the Contacts parent group is auto-expanded and
    // Audiences is the active child.
    const group = page.getByTestId("nav-contacts-group");
    await expect(group).toBeVisible({ timeout: 15000 });
    await expect(group).toHaveAttribute("aria-expanded", "true");
    const allContactsLink = page.getByRole("link", { name: "All contacts" }).first();
    await expect(allContactsLink).toBeVisible();
    await expect(page.getByRole("link", { name: "Audiences" }).first()).toBeVisible();
    // CMC POS group unaffected.
    await expect(page.getByTestId("nav-cmc-pos")).toBeVisible();
    // Child navigation works and the group stays expanded.
    await allContactsLink.click();
    await expect(page).toHaveURL(/\/customers$/);
    await expect(group).toHaveAttribute("aria-expanded", "true");
  });

  test("index shows summary cards, opportunities, and empty state", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("card-marketable-contacts")).toContainText("1,200");
    await expect(page.getByTestId("card-email-reachable")).toContainText("800");
    await expect(page.getByTestId("card-whatsapp-reachable")).toContainText("650");
    await expect(page.getByTestId("card-recipients-not-converted")).toContainText("300");
    await expect(page.getByTestId("opportunity-lapsed_gift_senders")).toBeVisible();
    await expect(page.getByTestId("audiences-empty-state")).toContainText("Dynamic");
    await expect(page.getByTestId("audiences-empty-state")).toContainText("Static");
  });

  test("review opportunity opens builder prefilled; preview + why-included; save active", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    await page.getByTestId("button-review-lapsed_gift_senders").click();
    await expect(page.getByTestId("audience-builder")).toBeVisible();
    await expect(page.getByTestId("input-audience-name")).toHaveValue(
      "Lapsed high-value gift senders",
    );
    await expect(page.getByTestId("audience-builder").getByText("Updates automatically")).toBeVisible();
    // Plain-language summary reflects the prefilled rules.
    await expect(page.getByTestId("rule-summary")).toContainText("Total spent (USD) is at least $500");

    // Live preview and why-included expander.
    await expect(page.getByTestId("preview-matched")).toHaveText("42");
    await page.getByTestId("button-why-included-c-1").click();
    await expect(page.getByTestId("why-included-c-1")).toContainText("total spent");

    // Save active — nothing was created before this point.
    await page.getByTestId("button-save-audience").click();
    await expect(page.getByTestId("audience-builder")).not.toBeVisible();
    await expect(page.getByTestId("row-audience-aud-1")).toBeVisible();
  });

  test("save draft from a manually built audience", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    await page.getByTestId("button-new-dynamic-audience").click();
    await page.getByTestId("input-audience-name").fill("Draft audience");
    await page.getByTestId("button-add-condition-root").click();
    await page.getByLabel("Field").click();
    await page.getByRole("option", { name: "Total spent (USD)" }).click();
    await page.getByLabel("Value for Total spent (USD)").fill("500");
    await page.getByTestId("button-save-draft").click();
    await expect(page.getByTestId("audience-builder")).not.toBeVisible();
    await expect(page.getByTestId("row-audience-aud-1")).toBeVisible();
  });

  test("save & create campaign hands off into the plan dialog with the audience preselected", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await page.route("**/api/occasion-campaigns/plans**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plans: [] }) }),
    );
    await page.route("**/api/occasion-campaigns/occasions**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ occasions: [] }) }),
    );
    await page.route("**/api/occasion-campaigns/summary**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ summary: null }) }),
    );
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    await page.getByTestId("button-review-lapsed_gift_senders").click();
    await expect(page.getByTestId("preview-matched")).toHaveText("42");
    await page.getByTestId("button-save-create-campaign").click();

    await expect(page).toHaveURL(/occasion-campaigns\?tab=plans&create=1&audience_id=aud-1/);
    await expect(page.getByTestId("chip-plan-audience")).toContainText(
      "Lapsed high-value gift senders",
    );
  });

  test("edit rules and archive from the index; archived rows lose campaign action", async ({ page }) => {
    const state: State = { audiences: [makeAudience()] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences", { waitUntil: "domcontentloaded" });

    // Edit rules.
    await page.getByTestId("button-audience-actions-aud-1").click();
    await page.getByRole("menuitem", { name: "Edit rules" }).click();
    await expect(page.getByTestId("audience-builder")).toBeVisible();
    await expect(page.getByTestId("input-audience-name")).toHaveValue(
      "Lapsed high-value gift senders",
    );
    await page.keyboard.press("Escape");

    // Archive with confirmation.
    await page.getByTestId("button-audience-actions-aud-1").click();
    await page.getByTestId("action-archive-aud-1").click();
    await expect(page.getByText("Archive audience")).toBeVisible();
    await page.getByTestId("button-confirm-archive").click();
    await expect(page.getByText("Audience archived", { exact: true })).toBeVisible();

    // Archived audiences are not selectable for campaigns.
    await page.getByTestId("button-audience-actions-aud-1").click();
    await expect(page.getByTestId("action-create-campaign-aud-1")).not.toBeVisible();
    await expect(page.getByTestId("action-archive-aud-1")).not.toBeVisible();
  });

  test("audience detail shows overview, contacts with why-included, and rules tabs", async ({ page }) => {
    const state: State = { audiences: [makeAudience()] };
    await setupRoutes(page, state);
    await setupClerkTestingToken({ page });
    await page.goto("/audiences/aud-1", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("text-audience-name")).toHaveText(
      "Lapsed high-value gift senders",
    );
    await expect(page.getByTestId("text-detail-matched")).toHaveText("42");

    await page.getByTestId("tab-detail-contacts").click();
    await expect(page.getByText("Layla Haddad")).toBeVisible();
    await page.getByRole("button", { name: "Why included?" }).click();
    await expect(page.getByText("(actual: 1200)")).toBeVisible();

    await page.getByTestId("tab-detail-rules").click();
    await expect(page.getByTestId("text-detail-rule-summary")).toBeVisible();
    await page.getByTestId("tab-detail-campaigns").click();
    await expect(page.getByTestId("button-create-campaign").first()).toBeVisible();
  });

  test("Contacts page regression: VIP tab replaced by audience link, Duplicates stays", async ({ page }) => {
    const state: State = { audiences: [] };
    await setupRoutes(page, state);
    await page.route("**/api/contacts**", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contacts: [], total: 0, page: 1, limit: 25 }),
      }),
    );
    await setupClerkTestingToken({ page });
    await page.goto("/customers", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tab-contacts-all")).toBeVisible();
    await expect(page.getByTestId("tab-contacts-duplicates")).toBeVisible();
    await expect(page.getByTestId("tab-contacts-vip")).toHaveCount(0);
    await expect(page.getByTestId("link-vip-audience")).toBeVisible();

    // VIP link opens the builder prefilled (not saved).
    await page.getByTestId("link-vip-audience").click();
    await expect(page.getByTestId("audience-builder")).toBeVisible();
    await expect(page.getByTestId("input-audience-name")).toHaveValue("VIP customers");
  });
});
