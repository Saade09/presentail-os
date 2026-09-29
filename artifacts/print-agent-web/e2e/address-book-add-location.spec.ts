import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Every app endpoint used by this spec is mocked, so use the static Clerk
// session fixture rather than requiring a live FAPI session to be minted.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const GOOGLE_PLACE_ID = "ChIJ-e2e-google-campus";
const GOOGLE_DUPLICATE_PLACE_ID = "ChIJ-e2e-existing-campus";
const SEARCH_INPUT_LABEL = "Search by landmark, building or address";

const GOOGLE_DETAILS = {
  placeId: GOOGLE_PLACE_ID,
  displayName: "Beirut Souks",
  formattedAddress: "Beirut Souks, Beirut, Lebanon",
  addressComponents: [
    { longText: "Beirut", shortText: "Beirut", types: ["locality"] },
    { longText: "Lebanon", shortText: "LB", types: ["country"] },
  ],
  location: { latitude: 33.8969, longitude: 35.5045 },
  types: ["establishment"],
  primaryType: "establishment",
};

const GOOGLE_FOREIGN_DETAILS = {
  ...GOOGLE_DETAILS,
  placeId: "ChIJ-e2e-foreign-campus",
  displayName: "Dubai Campus",
  formattedAddress: "1 Example Avenue, Dubai, United Arab Emirates",
  addressComponents: [
    { longText: "Dubai", shortText: "Dubai", types: ["locality"] },
    { longText: "United Arab Emirates", shortText: "AE", types: ["country"] },
  ],
  location: { latitude: 25.2048, longitude: 55.2708 },
};

const GOOGLE_COUNTRYLESS_DETAILS = {
  ...GOOGLE_DETAILS,
  placeId: "ChIJ-e2e-countryless-campus",
  displayName: "Countryless Campus",
  formattedAddress: "Unverified address",
  addressComponents: [
    { longText: "Unknown locality", shortText: "Unknown", types: ["locality"] },
  ],
};

const GOOGLE_DUPLICATE_DETAILS = {
  ...GOOGLE_DETAILS,
  placeId: GOOGLE_DUPLICATE_PLACE_ID,
  displayName: "Existing Google Campus",
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
        invited_at: null,
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

function emptyPlacesResponse() {
  return {
    success: true,
    places: [],
    total: 0,
    summary: {
      verified_count: 0,
      needs_review_count: 0,
      linked_deliveries_count: 0,
      possible_duplicates_count: 0,
      missing_coordinates_count: 0,
    },
  };
}

type SetupOptions = {
  suggestion: {
    placeId: string;
    displayName: string;
    formattedAddress: string;
    types: string[];
  } | null;
  details: typeof GOOGLE_DETAILS;
  preCheckMatches: Array<{
    id: string;
    canonical_name: string;
    verification_state: string;
    delivery_count: number;
    match_type: "exact_google_id" | "exact_name" | "alias_match" | "nearby_coordinate";
  }>;
};

async function setupAddressBookRoutes(page: Page, options: SetupOptions) {
  await setupClerkTestingToken({ page });

  const autocompleteQueries: string[] = [];
  const autocompleteCountryCodes: Array<string | null> = [];
  const detailsRequests: string[] = [];
  const preCheckBodies: Record<string, unknown>[] = [];
  const creationBodies: Record<string, unknown>[] = [];

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  // The dashboard shell starts several unrelated queries. Keep this focused
  // route-mocked spec independent from the API server, while later handlers
  // provide the concrete payloads exercised by the Add Location flow.
  await page.route("**/api/**", (route) => route.fulfill(json({})));

  await page.route("**/api/users", (route) =>
    route.fulfill(json(ownerUsersResponse())),
  );
  await page.route("**/api/roles", (route) =>
    route.fulfill(json({ roles: [] })),
  );
  await page.route("**/api/access-requests**", (route) =>
    route.fulfill(json({ requests: [] })),
  );
  await page.route("**/api/access-requests/events", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );

  await page.route(
    (url) => url.pathname === "/api/address-book/places",
    (route) => {
      if (route.request().method() === "POST") {
        creationBodies.push(route.request().postDataJSON() as Record<string, unknown>);
        return route.fulfill(json({ place: { id: "place-created" } }, 201));
      }
      return route.fulfill(json(emptyPlacesResponse()));
    },
  );
  await page.route("**/api/address-book/areas", (route) =>
    route.fulfill(json({ success: true, areas: [] })),
  );
  await page.route("**/api/cities", (route) =>
    route.fulfill(
      json({
        cities: [
          {
            id: 42,
            name: "Beirut",
            country_code: "LB",
            country: "Lebanon",
            is_active: true,
          },
          {
            id: 43,
            name: "Dubai",
            country_code: "AE",
            country: "United Arab Emirates",
            is_active: true,
          },
          {
            id: 44,
            name: "Tripoli",
            country_code: "LB",
            country: "Lebanon",
            is_active: false,
          },
        ],
        countries: ["Lebanon", "United Arab Emirates"],
      }),
    ),
  );

  await page.route(
    (url) => url.pathname === "/api/address-book/places/google-autocomplete",
    (route) => {
      const query = new URL(route.request().url()).searchParams.get("q");
      const countryCode = new URL(route.request().url()).searchParams.get("countryCode");
      if (query) autocompleteQueries.push(query);
      autocompleteCountryCodes.push(countryCode);
      return route.fulfill(
        json({
          suggestions: options.suggestion ? [options.suggestion] : [],
        }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/api/address-book/places/google-details",
    (route) => {
      const placeId = new URL(route.request().url()).searchParams.get("placeId");
      if (placeId) detailsRequests.push(placeId);
      return route.fulfill(json(options.details));
    },
  );
  await page.route(
    (url) => url.pathname === "/api/address-book/places/pre-check",
    (route) => {
      preCheckBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill(json({ matches: options.preCheckMatches }));
    },
  );

  // The Add Location form should exercise the real map component without
  // depending on Google's network or a browser-key quota.
  await page.route("https://maps.googleapis.com/maps/api/js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: `
        window.google = {
          maps: {
            Map: class {
              constructor() {}
              setCenter() {}
              addListener() { return { remove() {} }; }
            },
            Marker: class {
              constructor() {}
              setPosition() {}
              setMap() {}
              addListener() { return { remove() {} }; }
              getPosition() { return null; }
            }
          }
        };
        window.__presentailGoogleMapsReady();
      `,
    }),
  );

  await page.goto("/address-book", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Address Book" }),
  ).toBeVisible({ timeout: 15_000 });

  return {
    autocompleteQueries,
    autocompleteCountryCodes,
    detailsRequests,
    preCheckBodies,
    creationBodies,
  };
}

async function openGoogleSuggestion(
  page: Page,
  query: string,
  suggestionName: string,
) {
  await page.getByRole("button", { name: "Add location", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(SEARCH_INPUT_LABEL).fill(query);

  const suggestion = dialog.getByRole("option", { name: new RegExp(suggestionName) });
  await expect(suggestion).toBeVisible({ timeout: 8_000 });
  await suggestion.click();

  return dialog;
}

test.describe("Address Book – Add location from Google", () => {
  test("adds a Lebanese Google result with an active Lebanese district", async ({
    page,
  }) => {
    const query = "new Google campus";
    const requests = await setupAddressBookRoutes(page, {
      suggestion: {
        placeId: GOOGLE_PLACE_ID,
        displayName: "Beirut Souks",
        formattedAddress: GOOGLE_DETAILS.formattedAddress,
        types: GOOGLE_DETAILS.types,
      },
      details: GOOGLE_DETAILS,
      preCheckMatches: [],
    });

    const dialog = await openGoogleSuggestion(page, query, "Beirut Souks");

    await expect(
      dialog.getByText("Address Book locations can only be added in Lebanon."),
    ).toBeVisible();
    await expect(dialog.getByText("From Google", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog.getByText("Beirut Souks", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(GOOGLE_DETAILS.formattedAddress, { exact: true }),
    ).toBeVisible();

    await expect(
      dialog.getByRole("combobox", { name: "Select district" }),
    ).toBeVisible();
    await expect(
      dialog.locator('[aria-label="Select place type"]'),
    ).toBeVisible();
    await expect(
      dialog.getByLabel("Type an alias and press Enter or comma to add"),
    ).toBeVisible();
    await expect(dialog.getByText("Map pin", { exact: true })).toBeVisible();
    await expect(
      dialog.locator('[data-testid="google-map"], [data-testid="google-map-fallback"]'),
    ).toBeVisible({ timeout: 8_000 });

    expect(requests.autocompleteQueries).toContain(query);
    expect(requests.autocompleteCountryCodes).toContain("LB");
    expect(requests.detailsRequests).toEqual([GOOGLE_PLACE_ID]);
    expect(requests.preCheckBodies).toHaveLength(1);
    expect(requests.preCheckBodies[0]).toMatchObject({
      google_place_id: GOOGLE_PLACE_ID,
      name: GOOGLE_DETAILS.displayName,
      lat: GOOGLE_DETAILS.location.latitude,
      lng: GOOGLE_DETAILS.location.longitude,
    });

    await dialog.getByRole("combobox", { name: "Select district" }).click();
    await expect(page.getByRole("option", { name: "Beirut", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Dubai", exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Tripoli", exact: true })).toHaveCount(0);
    await page.getByRole("option", { name: "Beirut", exact: true }).click();
    await dialog.getByRole("button", { name: "Add location", exact: true }).click();

    await expect.poll(() => requests.creationBodies.length).toBe(1);
    expect(requests.creationBodies[0]).toMatchObject({
      canonical_name: "Beirut Souks",
      city_id: 42,
      google_place_id: GOOGLE_PLACE_ID,
      google_country: "LB",
    });
  });

  test("blocks creation when the Google suggestion is an exact duplicate", async ({
    page,
  }) => {
    const query = "existing Google campus";
    const requests = await setupAddressBookRoutes(page, {
      suggestion: {
        placeId: GOOGLE_DUPLICATE_PLACE_ID,
        displayName: "Existing Google Campus",
        formattedAddress: GOOGLE_DUPLICATE_DETAILS.formattedAddress,
        types: GOOGLE_DUPLICATE_DETAILS.types,
      },
      details: GOOGLE_DUPLICATE_DETAILS,
      preCheckMatches: [
        {
          id: "place-existing-campus",
          canonical_name: "Existing Google Campus",
          verification_state: "staff_verified",
          delivery_count: 3,
          match_type: "exact_google_id",
        },
      ],
    });

    const dialog = await openGoogleSuggestion(
      page,
      query,
      "Existing Google Campus",
    );

    await expect(
      dialog.getByText(/already in Presentail OS/i),
    ).toBeVisible({ timeout: 8_000 });
    await expect(
      dialog.getByRole("button", {
        name: "Add delivery point",
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog.getByText("Delivery details", { exact: true })).toHaveCount(
      0,
    );

    expect(requests.autocompleteQueries).toContain(query);
    expect(requests.detailsRequests).toEqual([GOOGLE_DUPLICATE_PLACE_ID]);
    expect(requests.preCheckBodies).toHaveLength(1);
    expect(requests.preCheckBodies[0]).toMatchObject({
      google_place_id: GOOGLE_DUPLICATE_PLACE_ID,
      name: GOOGLE_DUPLICATE_DETAILS.displayName,
    });
  });

  test("blocks a Google result outside Lebanon before duplicate checks", async ({
    page,
  }) => {
    const requests = await setupAddressBookRoutes(page, {
      suggestion: {
        placeId: GOOGLE_FOREIGN_DETAILS.placeId,
        displayName: GOOGLE_FOREIGN_DETAILS.displayName,
        formattedAddress: GOOGLE_FOREIGN_DETAILS.formattedAddress,
        types: GOOGLE_FOREIGN_DETAILS.types,
      },
      details: GOOGLE_FOREIGN_DETAILS,
      preCheckMatches: [],
    });

    const dialog = await openGoogleSuggestion(page, "Dubai campus", "Dubai Campus");

    await expect(dialog.getByRole("alert")).toContainText(
      "Only locations in Lebanon can be added",
    );
    await expect(dialog.getByText("Delivery details", { exact: true })).toHaveCount(0);
    expect(requests.detailsRequests).toEqual([GOOGLE_FOREIGN_DETAILS.placeId]);
    expect(requests.preCheckBodies).toHaveLength(0);
    expect(requests.creationBodies).toHaveLength(0);
  });

  test("blocks a Google result when its country cannot be verified", async ({
    page,
  }) => {
    const requests = await setupAddressBookRoutes(page, {
      suggestion: {
        placeId: GOOGLE_COUNTRYLESS_DETAILS.placeId,
        displayName: GOOGLE_COUNTRYLESS_DETAILS.displayName,
        formattedAddress: GOOGLE_COUNTRYLESS_DETAILS.formattedAddress,
        types: GOOGLE_COUNTRYLESS_DETAILS.types,
      },
      details: GOOGLE_COUNTRYLESS_DETAILS,
      preCheckMatches: [],
    });

    const dialog = await openGoogleSuggestion(
      page,
      "Countryless campus",
      "Countryless Campus",
    );

    await expect(dialog.getByRole("alert")).toContainText(
      "Google could not verify this location’s country",
    );
    await expect(dialog.getByText("Delivery details", { exact: true })).toHaveCount(0);
    expect(requests.preCheckBodies).toHaveLength(0);
    expect(requests.creationBodies).toHaveLength(0);
  });

  test("manual entry offers only active Lebanese districts", async ({ page }) => {
    await setupAddressBookRoutes(page, {
      suggestion: null,
      details: GOOGLE_DETAILS,
      preCheckMatches: [],
    });

    await page.getByRole("button", { name: "Add location", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(SEARCH_INPUT_LABEL).fill("Manual Beirut address");
    await dialog.getByRole("option", { name: /Enter address manually/i }).click();

    await dialog.getByRole("combobox", { name: "Select district" }).click();
    await expect(page.getByRole("option", { name: "Beirut", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Dubai", exact: true })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Tripoli", exact: true })).toHaveCount(0);
  });
});