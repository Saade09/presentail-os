import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "../../locales/en.json";
import ar from "../../locales/ar.json";
import {
  NAV,
  NAV_SECTIONS,
  isNavItemActive,
  isNavVisible,
  hasChannelsAccess,
  hasFloristOrdersAccess,
} from "./nav";

const labels = (items: typeof NAV) => items.map((entry) => en.nav[entry.labelKey.slice(4) as keyof typeof en.nav]);
const allDestinations = [...NAV, ...NAV_SECTIONS.flatMap((section) => section.children)];

describe("canonical sidebar tree", () => {
  it("has exactly 6 pinned destinations and 14 ordered sections", () => {
    expect(labels(NAV)).toEqual([
      "Orders",
      "Payment Links",
      "Customers & Recipients",
      "Dashboard",
      "Ops Dashboard",
      "Project Dashboard",
    ]);
    expect(NAV_SECTIONS.map((section) => en.nav[section.labelKey.slice(4) as keyof typeof en.nav])).toEqual([
      "Orders & Delivery", "Branches", "Cash Desk", "Our Brands", "Catalog",
      "Purchasing", "Marketing", "Website & SEO", "Analytics", "Finance",
      "Team", "Me", "Developer", "Settings",
    ]);
  });

  it("has 20 top-level entries, 114 total rows, and 100 destinations", () => {
    const destinations = NAV.length + NAV_SECTIONS.reduce((sum, section) => sum + section.children.length, 0);
    expect(NAV.length + NAV_SECTIONS.length).toBe(20);
    expect(destinations + NAV_SECTIONS.length).toBe(114);
    expect(destinations).toBe(100);
  });

  it("matches the exact destination order and labels in every section", () => {
    expect(NAV_SECTIONS.map((section) => labels(section.children))).toEqual([
      ["Florist Orders", "Card Messages", "Print History", "Fleet", "Delivery Cities", "Address Book", "Address Collector"],
      ["All Branches", "Branch Overview", "New Delivery Order", "Order History", "Stock Replacements", "Stock Requests", "Commission Statements"],
      ["Cash Sessions", "Cash Drawers", "Cash Transfers", "Counter Invoices", "Cash Approvals"],
      ["All Brands", "Sticker Sheets"],
      ["All Products", "Events", "Product Recipes", "Recipe Benchmarks", "AI Product Generator", "Base Items", "Base Item Categories", "Product Categories", "Occasions", "Recipient Types", "Partner Brands"],
      ["Reorder Needed", "Suppliers", "Supplier Statements", "Purchase Orders", "Supplier Bills", "Invoice Scanners"],
      ["Audiences", "Occasion Campaigns", "Coupons", "Upsell", "Budget Planner", "Google Business Posts", "Review Rewards"],
      ["Homepage Banners", "Publish to Website", "Publishing Channels", "Sales Channels", "Backlinks Overview", "Link Opportunities", "Competitors", "Backlink Campaigns", "Link Monitor"],
      ["Overview", "Sales & Checkout", "Customer Analytics", "Marketing & SEO", "Operations & Delivery", "Inventory & COGS", "Channels"],
      ["Monthly Closing", "Customer Invoices", "Cash Ledger", "Journal Entries", "Reconciliation", "Chart of Accounts", "Tax Rules", "Financial Reports"],
      ["People Directory", "Roles", "Invites & Access", "Team Attendance", "Approvals", "Attendance Corrections", "Work Schedules", "Leave Policies", "Public Holidays", "Blackout Dates"],
      ["My Attendance", "My Time Off", "Team Calendar", "Profile"],
      ["API Keys", "Webhook Endpoints", "API Docs", "Smoke Tests"],
      ["General", "Devices", "Printer Drivers", "Automations", "Messaging Channels", "Attendance Settings", "Audit Log"],
    ]);
  });

  it("accounts for all 109 mappings through destinations or documented merge targets", () => {
    const mergedPaths = allDestinations.flatMap((entry) => entry.mergedPaths ?? []);
    expect(allDestinations).toHaveLength(100);
    expect(mergedPaths).toHaveLength(9);
    expect(allDestinations.length + mergedPaths.length).toBe(109);
    expect(
      allDestinations
        .filter((entry) => entry.mergedPaths)
        .map(({ path, mergedPaths }) => [path, mergedPaths]),
    ).toEqual([
      ["/cash-drawers", ["/cmc-pos/cash-drawer"]],
      ["/backlink-engine", ["/backlink-engine/reports", "/backlink-engine/settings"]],
      ["/store-analytics", ["/cart-checkout-analytics"]],
      ["/marketing-analytics", ["/seo-analytics", "/search-discovery-analytics"]],
      ["/operations-analytics", ["/delivery-analytics"]],
      ["/marketplace-analytics", ["/omnichannel/analytics"]],
      ["/api-docs", ["/developer"]],
    ]);
  });

  it("keeps every destination, merge source, and no-row route live in App.tsx", () => {
    const appSource = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
    const routes = new Set(
      [...appSource.matchAll(/<Route path="([^"]+)"/g)].map((match) => match[1]),
    );
    const mappedPaths = allDestinations.flatMap((entry) => [
      entry.path,
      ...(entry.mergedPaths ?? []),
    ]);
    for (const path of [
      ...mappedPaths,
      "/omnichannel/inbox",
      "/omnichannel/contacts",
      "/cmc-pos/sale",
      "/cmc-pos/request",
      "/cmc-pos/delivery",
      "/admin/people/team-members",
    ]) {
      expect(routes, `missing live route ${path}`).toContain(path);
    }
  });

  it("contains the six audited destinations and excludes transaction-only routes", () => {
    const paths = [...NAV, ...NAV_SECTIONS.flatMap((section) => section.children)].map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining([
      "/ops-dashboard", "/project-manager-dashboard", "/audiences", "/cash-approvals",
      "/tax-rules", "/admin/attendance/requests",
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      "/omnichannel/inbox", "/omnichannel/contacts",
      "/cmc-pos/sale", "/cmc-pos/request", "/cmc-pos/delivery", "/admin/people/team-members",
    ]));
  });

  it("keeps access metadata out of the navigation model", () => {
    for (const entry of [...NAV, ...NAV_SECTIONS, ...NAV_SECTIONS.flatMap((section) => section.children)]) {
      expect(entry).not.toHaveProperty("pageKey");
      expect(entry).not.toHaveProperty("ownerOnly");
      expect(entry).not.toHaveProperty("role");
    }
  });

  it("has no bare Brands, Contacts, or Recipients destination label", () => {
    const destinationLabels = labels([
      ...NAV,
      ...NAV_SECTIONS.flatMap((section) => section.children),
    ]);
    expect(destinationLabels).not.toEqual(expect.arrayContaining(["Brands", "Contacts", "Recipients"]));
  });

  it("provides every canonical key in both English and Arabic", () => {
    for (const entry of [...NAV, ...NAV_SECTIONS, ...NAV_SECTIONS.flatMap((section) => section.children)]) {
      const key = entry.labelKey.slice(4) as keyof typeof en.nav;
      expect(en.nav[key]).toBeTruthy();
      expect(ar.nav[key as keyof typeof ar.nav]).toBeTruthy();
    }
  });
});

describe("permission compatibility helpers", () => {
  it("preserves special channels and florist access", () => {
    expect(hasChannelsAccess(["channels.manage"])).toBe(true);
    expect(hasFloristOrdersAccess(["orders"])).toBe(true);
    const florist = NAV_SECTIONS[0].children[0];
    expect(isNavVisible(florist, false, false, ["orders"])).toBe(true);
  });

  it("keeps owner-only Roles outside role previews", () => {
    const roles = NAV_SECTIONS.find((section) => section.id === "team")!.children[1];
    expect(isNavVisible(roles, true, true, null)).toBe(true);
    expect(isNavVisible(roles, false, true, ["roles"])).toBe(false);
  });

  it("keeps Invoice Scanners independent from the broader Devices permission", () => {
    const scanners = NAV_SECTIONS.find((section) => section.id === "purchasing")!
      .children.find((child) => child.path === "/settings/devices/scanners")!;

    expect(isNavVisible(scanners, false, false, ["invoice-scanners"])).toBe(true);
    expect(isNavVisible(scanners, false, false, ["devices"])).toBe(false);
    expect(isNavVisible(scanners, false, false, [])).toBe(false);
    expect(isNavVisible(scanners, true, true, null)).toBe(true);
  });
});

describe("merged route active matching", () => {
  const allItems = [...NAV, ...NAV_SECTIONS.flatMap((section) => section.children)];
  const cases = [
    ["/cash-drawers", "/cmc-pos/cash-drawer"],
    ["/backlink-engine", "/backlink-engine/reports"],
    ["/backlink-engine", "/backlink-engine/settings"],
    ["/store-analytics", "/cart-checkout-analytics"],
    ["/marketing-analytics", "/seo-analytics"],
    ["/marketing-analytics", "/search-discovery-analytics"],
    ["/operations-analytics", "/delivery-analytics"],
    ["/marketplace-analytics", "/omnichannel/analytics"],
    ["/api-docs", "/developer"],
  ] as const;

  it.each(cases)("%s represents merged URL %s", (destination, source) => {
    const entry = allItems.find((item) => item.path === destination)!;
    expect(isNavItemActive(entry, source)).toBe(true);
    expect(isNavItemActive(entry, `${source}/nested`)).toBe(true);
  });
});