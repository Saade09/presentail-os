import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MOCK_USERS = {
  members: [
    {
      id: "test-user",
      email: "e2e-tester@presentail.com",
      role: "owner",
    },
  ],
  me: { role: "owner", email: "e2e-tester@presentail.com" },
};

const INITIAL_PROFILE = { phone: null, job_title: null, birthday: null, gender: null };


test.describe("Profile save flow - validation and contact", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });

    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_USERS),
      });
    });
  });

  test("shows an error when saving with a blank first name", async ({
    page,
  }) => {
    await page.route("**/api/profile**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(INITIAL_PROFILE),
      });
    });

    await page.goto("/profile?tab=personal", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    const firstNameInput = page.getByTestId("input-first-name");
    await expect(firstNameInput).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      const win = window as unknown as {
        Clerk?: { user?: { update?: (...args: unknown[]) => Promise<unknown> } };
        __nameUpdateCalled?: boolean;
      };
      if (win.Clerk?.user) {
        const orig = win.Clerk.user.update;
        win.Clerk.user.update = async (...args: unknown[]) => {
          win.__nameUpdateCalled = true;
          return orig?.apply(win.Clerk!.user, args as [unknown]);
        };
      }
    });

    await firstNameInput.fill("");

    await page.getByTestId("save-name-button").click();

    await expect(
      page.getByText("First name cannot be blank."),
    ).toBeVisible();

    const updateCalled = await page.evaluate(
      () => !!(window as unknown as { __nameUpdateCalled?: boolean }).__nameUpdateCalled,
    );
    expect(updateCalled).toBe(false);
  });

  test("saves phone and job title then persists both after page refresh", async ({
    page,
  }) => {
    const savedProfile = {
      phone: "+12025550123",
      job_title: "Print Manager",
    };

    let capturedPatchBody: { phone?: string | null; job_title?: string | null } | null = null;

    // Mock IP geolocation so PhoneInput always starts with US (+1) country code
    await page.route("**/ipapi.co/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ country_code: "US" }),
      });
    });

    await page.route("**/api/profile**", async (route) => {
      if (route.request().method() === "PATCH") {
        capturedPatchBody = JSON.parse(route.request().postData() ?? "{}") as {
          phone?: string | null;
          job_title?: string | null;
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(savedProfile),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            capturedPatchBody !== null ? savedProfile : INITIAL_PROFILE,
          ),
        });
      }
    });

    await page.goto("/profile?tab=personal", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    const jobTitleInput = page.getByTestId("input-job-title");
    await expect(jobTitleInput).toBeVisible({ timeout: 10_000 });

    // Wait for US country code to be applied (ipapi.co mock ensures +1 prefix)
    const phoneInput = page.getByTestId("input-phone");
    await expect(phoneInput).toHaveValue(/^\+1/, { timeout: 5_000 });

    // Type the national number after the +1 country code
    await phoneInput.click();
    await phoneInput.press("End");
    await phoneInput.pressSequentially("2025550123", { delay: 30 });

    await jobTitleInput.fill("Print Manager");

    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/profile") && r.request().method() === "PATCH",
      ),
      page.getByTestId("save-profile-button").click(),
    ]);

    expect(patchResponse.status()).toBe(200);
    const responseBody = (await patchResponse.json()) as {
      phone?: string;
      job_title?: string;
    };
    expect(responseBody.job_title).toBe("Print Manager");
    expect(responseBody.phone).toBe("+12025550123");

    await expect(
      page.getByText("Profile saved").first(),
    ).toBeVisible({ timeout: 10_000 });

    expect(capturedPatchBody).not.toBeNull();
    expect(capturedPatchBody!.job_title).toBe("Print Manager");
    expect(capturedPatchBody!.phone).toBe("+12025550123");

    await page.reload();

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("input-job-title")).toHaveValue(
      "Print Manager",
      { timeout: 10_000 },
    );

    await expect(phoneInput).toHaveValue("+1 202 555 0123", {
      timeout: 10_000,
    });
  });

  test("saves birthday and gender then persists both after page reload", async ({
    page,
  }) => {
    const savedProfile = {
      phone: null,
      job_title: null,
      birthday: "1990-06-15",
      gender: "female",
    };

    let capturedPatchBody: {
      birthday?: string | null;
      gender?: string | null;
    } | null = null;

    await page.route("**/api/profile**", async (route) => {
      if (route.request().method() === "PATCH") {
        capturedPatchBody = JSON.parse(route.request().postData() ?? "{}") as {
          birthday?: string | null;
          gender?: string | null;
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(savedProfile),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            capturedPatchBody !== null ? savedProfile : INITIAL_PROFILE,
          ),
        });
      }
    });

    await page.goto("/profile?tab=personal", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    const birthdayTrigger = page.getByTestId("input-birthday");
    await expect(birthdayTrigger).toBeVisible({ timeout: 10_000 });

    // Open the birthday calendar picker
    await birthdayTrigger.click();

    // Wait for the calendar to appear
    const calendar = page.locator('[data-slot="calendar"]');
    await expect(calendar).toBeVisible({ timeout: 5_000 });

    // Navigate to year 1990 using the year dropdown (options are 4-digit years)
    const yearSelect = calendar.locator("select").filter({
      has: page.locator('option[value="1990"]'),
    });
    await yearSelect.selectOption("1990");

    // Navigate to June using the month dropdown (0-indexed: June = 5)
    const monthSelect = calendar.locator("select").filter({
      has: page.locator('option[value="5"]'),
    });
    await monthSelect.selectOption("5");

    // Click day 15 (match by text content, not aria-label which includes full date)
    await calendar.locator("button").filter({ hasText: /^15$/ }).first().click();

    // Verify the trigger shows the selected date in dd/mm/yyyy format
    await expect(birthdayTrigger).toContainText("15/06/1990", { timeout: 5_000 });

    const genderSelect = page.getByTestId("select-gender");
    await genderSelect.selectOption("female");

    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/profile") && r.request().method() === "PATCH",
      ),
      page.getByTestId("save-profile-button").click(),
    ]);

    expect(patchResponse.status()).toBe(200);
    const responseBody = (await patchResponse.json()) as {
      birthday?: string | null;
      gender?: string | null;
    };
    expect(responseBody.birthday).toBe("1990-06-15");
    expect(responseBody.gender).toBe("female");

    await expect(page.getByText("Profile saved").first()).toBeVisible({
      timeout: 10_000,
    });

    expect(capturedPatchBody).not.toBeNull();
    expect(capturedPatchBody!.birthday).toBe("1990-06-15");
    expect(capturedPatchBody!.gender).toBe("female");

    await page.reload();

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    // After reload the picker trigger should display the persisted date
    await expect(page.getByTestId("input-birthday")).toContainText("15/06/1990", {
      timeout: 10_000,
    });

    await expect(page.getByTestId("select-gender")).toHaveValue("female", {
      timeout: 10_000,
    });
  });
});

test.describe("Profile save flow - name save", () => {
  test("saves name with valid first and last name and shows success toast", async ({
    page,
  }) => {
    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_USERS),
      });
    });

    await page.route("**/api/profile**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(INITIAL_PROFILE),
      });
    });

    await setupClerkTestingToken({ page });
    await page.goto("/profile?tab=personal", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    const firstNameInput = page.getByTestId("input-first-name");
    await expect(firstNameInput).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      const win = window as unknown as {
        Clerk?: { user?: { update?: (...args: unknown[]) => Promise<unknown> } };
        __clerkUpdateArgs?: Record<string, unknown>;
      };
      if (win.Clerk?.user) {
        const origUser = win.Clerk.user;
        win.Clerk.user.update = async (...args: unknown[]) => {
          win.__clerkUpdateArgs = args[0] as Record<string, unknown>;
          return Promise.resolve(origUser);
        };
      }
    });

    await firstNameInput.fill("Jane");
    await page.getByTestId("input-last-name").fill("Doe");

    await page.getByTestId("save-name-button").click();

    await expect(page.getByText("Name updated").first()).toBeVisible({
      timeout: 10_000,
    });

    const updateArgs = await page.evaluate(
      () =>
        (
          window as unknown as {
            __clerkUpdateArgs?: Record<string, unknown>;
          }
        ).__clerkUpdateArgs,
    );
    expect(updateArgs?.firstName).toBe("Jane");
    expect(updateArgs?.lastName).toBe("Doe");
  });
});
