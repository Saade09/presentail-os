import {
  AlertTriangle, ArrowLeftRight, BarChart2, BookMarked, BookOpen, Boxes,
  CalendarClock, CalendarDays, CalendarOff, CalendarRange, ClipboardCheck,
  CreditCard, Download, FileBarChart, FileClock, FileText, FlaskConical,
  Flower2, HeartHandshake, History, ImageIcon, Key, Layers, LayoutDashboard,
  LayoutGrid, LineChart, Link2, MailOpen, MapPin, MapPinned, Megaphone,
  Package, PartyPopper, PieChart, PlugZap, Printer, Receipt,
  RotateCcw, Rss, ScanBarcode, ScrollText, Settings, Shield, ShieldCheck,
  ShoppingBag, ShoppingCart, Smartphone, Sparkles, Star, Store, Tag, Terminal,
  Ticket, TrendingUp, Truck, Tv2, UserCheck, UserCircle, Users, Users2,
  Wallet, Webhook, Zap,
} from "lucide-react";

export type NavItem = {
  path: string;
  labelKey: string;
  icon: React.ElementType;
  /** Existing routes represented by this destination after a documented sidebar merge. */
  mergedPaths?: readonly string[];
};

export type NavGroup = {
  id: string;
  labelKey: string;
  icon: React.ElementType;
  children: NavItem[];
  parentPath?: string;
  defaultPath?: string;
};

const item = (
  path: string,
  labelKey: string,
  icon: React.ElementType,
  mergedPaths?: readonly string[],
): NavItem => ({
  path, labelKey, icon, ...(mergedPaths ? { mergedPaths } : {}),
});

export const PINNED_NAV: NavItem[] = [
  item("/orders", "nav.orders", ShoppingCart),
  item("/payment-links", "nav.paymentLinks", CreditCard),
  item("/customers", "nav.customersRecipients", Users),
  item("/dashboard", "nav.dashboard", LayoutDashboard),
  item("/ops-dashboard", "nav.opsDashboard", ClipboardCheck),
  item("/project-manager-dashboard", "nav.projectDashboard", LayoutDashboard),
];

export const NAV_SECTIONS: NavGroup[] = [
  { id: "orders-delivery", labelKey: "nav.ordersDelivery", icon: Truck, children: [
    item("/florist-orders", "nav.floristOrders", Flower2),
    item("/card-message", "nav.cardMessages", Printer),
    item("/print-history", "nav.printHistory", FileClock),
    item("/fleet", "nav.fleet", Truck),
    item("/cities", "nav.cities", MapPin),
    item("/address-book", "nav.addressBook", MapPinned),
    item("/address-collector", "nav.addressCollector", MapPin),
  ]},
  { id: "branches", labelKey: "nav.branches", icon: MapPin, children: [
    item("/locations", "nav.allBranches", MapPin),
    item("/cmc-pos", "nav.branchOverview", HeartHandshake),
    item("/cmc-pos/new-order", "nav.newDeliveryOrder", ShoppingBag),
    item("/cmc-pos/sales", "nav.orderHistory", History),
    item("/cmc-pos/returns", "nav.stockReplacements", RotateCcw),
    item("/cmc-pos/location-requests", "nav.stockRequests", MapPin),
    item("/cmc-pos/monthly-sales", "nav.commissionStatements", TrendingUp),
  ]},
  { id: "cash-desk", labelKey: "nav.cashDesk", icon: Receipt, children: [
    item("/cash-sessions", "nav.cashSessions", Receipt),
    item("/cash-drawers", "nav.cashDrawers", CreditCard, ["/cmc-pos/cash-drawer"]),
    item("/cash-transfers", "nav.cashTransfers", ArrowLeftRight),
    item("/cash-bills", "nav.counterInvoices", FileText),
    item("/cash-approvals", "nav.cashApprovals", ClipboardCheck),
  ]},
  { id: "our-brands", labelKey: "nav.ourBrands", icon: Layers, children: [
    item("/brands", "nav.allBrands", Layers),
    item("/stickers", "nav.stickerSheets", Tag),
  ]},
  { id: "catalog", labelKey: "nav.catalog", icon: ShoppingBag, children: [
    item("/products", "nav.allProducts", ShoppingBag),
    item("/events", "nav.events", CalendarDays),
    item("/recipe-review", "nav.productRecipes", FlaskConical),
    item("/recipe-benchmarks", "nav.recipeBenchmarks", FileBarChart),
    item("/bloomprint", "nav.aiProductGenerator", Sparkles),
    item("/base-items", "nav.baseItems", FlaskConical),
    item("/base-item-categories", "nav.baseItemCategories", FlaskConical),
    item("/catalog-attributes/categories", "nav.productCategories", LayoutGrid),
    item("/catalog-attributes/occasions", "nav.occasions", PartyPopper),
    item("/catalog-attributes/recipients", "nav.recipientTypes", HeartHandshake),
    item("/catalog-attributes/brands", "nav.partnerBrands", Sparkles),
  ]},
  { id: "purchasing", labelKey: "nav.purchasing", icon: Package, children: [
    item("/suppliers/reorder", "nav.reorderNeeded", AlertTriangle),
    item("/suppliers", "nav.suppliers", Store),
    item("/supplier-statements", "nav.supplierStatements", FileClock),
    item("/purchase-orders", "nav.purchaseOrders", ClipboardCheck),
    item("/ai-invoice-import", "nav.supplierBills", Receipt),
    item("/settings/devices/scanners", "nav.invoiceScanners", ScanBarcode),
  ]},
  { id: "marketing", labelKey: "nav.marketing", icon: Megaphone, children: [
    item("/audiences", "nav.audiences", Users),
    item("/occasion-campaigns", "nav.occasionCampaigns", CalendarDays),
    item("/coupons", "nav.coupons", Ticket),
    item("/upsell", "nav.upsell", Sparkles),
    item("/marketing-budget-planner", "nav.budgetPlanner", PieChart),
    item("/google-product-post", "nav.googleBusinessPosts", MapPinned),
    item("/review-rewards", "nav.reviewRewards", Star),
  ]},
  { id: "website-seo", labelKey: "nav.websiteSeo", icon: Link2, children: [
    item("/admin/homepage-banners", "nav.homepageBanners", ImageIcon),
    item("/publish", "nav.publishSnapshot", Rss),
    item("/publishing-channels", "nav.publishingChannels", Rss),
    item("/channels", "nav.salesChannels", Tv2),
    item("/backlink-engine", "nav.backlinksOverview", BarChart2, [
      "/backlink-engine/reports",
      "/backlink-engine/settings",
    ]),
    item("/backlink-engine/opportunities", "nav.linkOpportunities", Link2),
    item("/backlink-engine/competitors", "nav.competitors", Users2),
    item("/backlink-engine/campaigns", "nav.backlinkCampaigns", Megaphone),
    item("/backlink-engine/monitor", "nav.linkMonitor", LineChart),
  ]},
  { id: "analytics", labelKey: "nav.analyticsGroup", icon: BarChart2, children: [
    item("/analytics", "nav.overview", BarChart2),
    item("/store-analytics", "nav.salesCheckout", LineChart, ["/cart-checkout-analytics"]),
    item("/customer-analytics", "nav.customerAnalytics", Users),
    item("/marketing-analytics", "nav.marketingSeo", Megaphone, [
      "/seo-analytics",
      "/search-discovery-analytics",
    ]),
    item("/operations-analytics", "nav.operationsDelivery", Truck, ["/delivery-analytics"]),
    item("/inventory-cogs-analytics", "nav.inventoryCogsAnalytics", Boxes),
    item("/marketplace-analytics", "nav.analyticsChannels", Store, ["/omnichannel/analytics"]),
  ]},
  { id: "finance", labelKey: "nav.finance", icon: BookMarked, children: [
    item("/finance/accounting/monthly-closing", "nav.monthlyClosing", TrendingUp),
    item("/invoices", "nav.customerInvoices", FileText),
    item("/finance/accounting/cash-activity", "nav.cashLedger", Wallet),
    item("/finance/accounting/journal-entries", "nav.journalEntries", FileText),
    item("/finance/accounting/reconciliation", "nav.reconciliation", ArrowLeftRight),
    item("/finance/accounting/chart-of-accounts", "nav.chartOfAccounts", LayoutGrid),
    item("/tax-rules", "nav.taxRules", Receipt),
    item("/finance/accounting/reports", "nav.financialReports", FileBarChart),
  ]},
  { id: "team", labelKey: "nav.team", icon: Users2, children: [
    item("/people", "nav.peopleDirectory", Users2),
    item("/roles", "nav.roles", ShieldCheck),
    item("/people/access", "nav.invitesAccess", MailOpen),
    item("/admin/attendance", "nav.attendance", UserCheck),
    item("/time-off/approvals", "nav.timeOffApprovals", ClipboardCheck),
    item("/admin/attendance/requests", "nav.attendanceCorrections", ClipboardCheck),
    item("/admin/people/work-schedules", "nav.workSchedules", CalendarClock),
    item("/admin/time-off/policies", "nav.timeOffPolicies", Shield),
    item("/admin/public-holidays", "nav.publicHolidays", Star),
    item("/admin/time-off/blackout-dates", "nav.blackoutDates", CalendarOff),
  ]},
  { id: "me", labelKey: "nav.me", icon: UserCircle, children: [
    item("/attendance/my", "nav.myAttendance", UserCheck),
    item("/time-off/my", "nav.myTimeOff", CalendarDays),
    item("/time-off/calendar", "nav.timeOffCalendar", CalendarRange),
    item("/profile", "nav.profile", UserCircle),
  ]},
  { id: "developer", labelKey: "nav.developer", icon: Terminal, children: [
    item("/api-keys", "nav.apiKeys", Key),
    item("/webhook-endpoints", "nav.webhookEndpoints", Webhook),
    item("/api-docs", "nav.apiDocs", BookOpen, ["/developer"]),
    item("/smoke-tests", "nav.smokeTests", FlaskConical),
  ]},
  { id: "settings", labelKey: "nav.settings", icon: Settings, children: [
    item("/settings", "nav.general", Settings),
    item("/devices", "nav.devices", Smartphone),
    item("/downloads", "nav.printerDrivers", Download),
    item("/omnichannel/automations", "nav.automations", Zap),
    item("/settings/channels", "nav.messagingChannels", PlugZap),
    item("/admin/people/attendance-settings", "nav.attendanceSettings", MapPin),
    item("/omnichannel/audit-log", "nav.auditLog", ScrollText),
  ]},
];

const section = (id: string): NavGroup => NAV_SECTIONS.find((group) => group.id === id)!;

// Compatibility aliases for consumers that previously imported independently
// assembled groups. Every alias points into the canonical ordered tree above.
export const ANALYTICS_GROUP = section("analytics");
export const CATALOG_ATTRIBUTES_GROUP = section("catalog");
export const PRODUCTS_GROUP = section("catalog");
export const BASE_ITEMS_GROUP = section("catalog");
export const PROCUREMENT_GROUP = section("purchasing");
export const CASH_DESK_GROUP = section("cash-desk");
export const DEVELOPER_TOOLS_GROUP = section("developer");
export const PUBLISHING_GROUP = section("website-seo");
export const MARKETING_GROUP = section("marketing");
export const BACKLINK_ENGINE_GROUP = section("website-seo");
export const PEOPLE_TIME_OFF_GROUP = section("team");
export const PEOPLE_ACCESS_GROUP = section("team");
export const FINANCE_ACCOUNTING_GROUP = section("finance");
export const CONTACTS_GROUP = section("marketing");
export const ADDRESSES_GROUP = section("orders-delivery");
export const CMC_POS_GROUP = section("branches");

/** Compatibility name for callers; the canonical pinned block is PINNED_NAV. */
export const NAV = PINNED_NAV;

export function isNavItemActive(item: NavItem, currentPath: string): boolean {
  return [item.path, ...(item.mergedPaths ?? [])].some(
    (path) => currentPath === path || currentPath.startsWith(`${path}/`),
  );
}

type AccessRule = { pageKey: string | null; ownerOnly?: boolean; alwaysVisible?: boolean; altPageKey?: string };
const ACCESS: Record<string, AccessRule> = {
  "/omnichannel/inbox": { pageKey: "omnichannel-inbox" },
  "/omnichannel/contacts": { pageKey: "omnichannel-contacts" },
  "/orders": { pageKey: "orders" }, "/customers": { pageKey: "customers" },
  "/dashboard": { pageKey: null, alwaysVisible: true },
  "/ops-dashboard": { pageKey: "ops-dashboard" },
  "/project-manager-dashboard": { pageKey: "project-manager-dashboard" },
  "/florist-orders": { pageKey: "florist_orders" }, "/card-message": { pageKey: "card-message" },
  "/print-history": { pageKey: "print-history" }, "/fleet": { pageKey: "fleet" },
  "/cities": { pageKey: "cities" }, "/address-book": { pageKey: "address-book" },
  "/address-collector": { pageKey: "address-collector" }, "/locations": { pageKey: "locations" },
  "/cmc-pos": { pageKey: "cmc-pos" }, "/cmc-pos/new-order": { pageKey: "cmc_pos.sell" },
  "/cmc-pos/sales": { pageKey: "cmc_pos.audit", altPageKey: "cmc_pos.sell" },
  "/cmc-pos/returns": { pageKey: "cmc_pos.returns" }, "/cmc-pos/location-requests": { pageKey: "cmc_pos.view_location_requests" },
  "/cmc-pos/monthly-sales": { pageKey: "cmc_pos.monthly_sales" },
  "/cash-sessions": { pageKey: "cash-sessions" }, "/cash-drawers": { pageKey: "cash-drawers" },
  "/cash-transfers": { pageKey: "cash-sessions" }, "/cash-bills": { pageKey: "cash-sessions" },
  "/cash-approvals": { pageKey: "cash-sessions" }, "/brands": { pageKey: "brands" },
  "/stickers": { pageKey: "stickers" }, "/products": { pageKey: "products", altPageKey: "products.manage" },
  "/events": { pageKey: "events" }, "/recipe-review": { pageKey: "products.manage" },
  "/recipe-benchmarks": { pageKey: "products", altPageKey: "products.manage" },
  "/bloomprint": { pageKey: "products" }, "/base-items": { pageKey: "base-items" },
  "/base-item-categories": { pageKey: "base-item-categories" },
  "/catalog-attributes/categories": { pageKey: "catalog-categories-attr" },
  "/catalog-attributes/occasions": { pageKey: "catalog-occasions" },
  "/catalog-attributes/recipients": { pageKey: "catalog-recipients" },
  "/catalog-attributes/brands": { pageKey: "catalog-brands-attr" },
  "/suppliers/reorder": { pageKey: "suppliers" }, "/suppliers": { pageKey: "suppliers" },
  "/supplier-statements": { pageKey: "supplier-statements" },
  "/purchase-orders": { pageKey: "purchase-orders" }, "/ai-invoice-import": { pageKey: "ai-invoice-import" },
  "/settings/devices/scanners": { pageKey: "invoice-scanners" },
  "/audiences": { pageKey: "customers" }, "/occasion-campaigns": { pageKey: "occasion-campaigns" },
  "/coupons": { pageKey: "coupons" }, "/upsell": { pageKey: "upsell" },
  "/payment-links": { pageKey: "payment-links" }, "/marketing-budget-planner": { pageKey: "marketing-budget-planner" },
  "/google-product-post": { pageKey: null, ownerOnly: true }, "/review-rewards": { pageKey: "review-rewards" },
  "/admin/homepage-banners": { pageKey: "homepage_banners.manage" }, "/publish": { pageKey: null },
  "/publishing-channels": { pageKey: "publishing-channels" }, "/channels": { pageKey: "channels" },
  "/backlink-engine": { pageKey: "backlink-engine" }, "/backlink-engine/opportunities": { pageKey: "backlink-engine" },
  "/backlink-engine/competitors": { pageKey: "backlink-engine" }, "/backlink-engine/campaigns": { pageKey: "backlink-engine" },
  "/backlink-engine/monitor": { pageKey: "backlink-engine" },
  "/analytics": { pageKey: "analytics" }, "/store-analytics": { pageKey: "store-analytics" },
  "/customer-analytics": { pageKey: "customer-analytics" }, "/marketing-analytics": { pageKey: "marketing-analytics" },
  "/operations-analytics": { pageKey: "operations-analytics" }, "/inventory-cogs-analytics": { pageKey: "inventory-cogs-analytics" },
  "/marketplace-analytics": { pageKey: "marketplace-analytics" },
  "/invoices": { pageKey: "invoices" }, "/tax-rules": { pageKey: "finance_accounting" },
  "/roles": { pageKey: "roles", ownerOnly: true }, "/people": { pageKey: "people.directory" },
  "/people/access": { pageKey: "people.invites" }, "/admin/attendance": { pageKey: "people.attendance" },
  "/admin/attendance/requests": { pageKey: "people.attendance" }, "/admin/people/work-schedules": { pageKey: "people.work-schedules" },
  "/admin/time-off/policies": { pageKey: "time-off.manage" }, "/admin/public-holidays": { pageKey: "time-off.manage" },
  "/admin/time-off/blackout-dates": { pageKey: "time-off.manage" }, "/time-off/approvals": { pageKey: "time-off.manage" },
  "/attendance/my": { pageKey: "people.attendance" }, "/time-off/my": { pageKey: "time-off" },
  "/time-off/calendar": { pageKey: "time-off" }, "/profile": { pageKey: "profile", alwaysVisible: true },
  "/api-keys": { pageKey: "api-keys" }, "/webhook-endpoints": { pageKey: "webhook-endpoints", ownerOnly: true },
  "/api-docs": { pageKey: "api-docs" }, "/smoke-tests": { pageKey: null, ownerOnly: true },
  "/settings": { pageKey: "settings" }, "/devices": { pageKey: "devices" }, "/downloads": { pageKey: "downloads" },
  "/omnichannel/automations": { pageKey: "omnichannel-automations" },
  "/settings/channels": { pageKey: null, ownerOnly: true },
  "/admin/people/attendance-settings": { pageKey: "people.work-schedules", ownerOnly: true },
  "/omnichannel/audit-log": { pageKey: null, ownerOnly: true },
};
for (const path of [
  "/finance/accounting/monthly-closing", "/finance/accounting/cash-activity",
  "/finance/accounting/journal-entries", "/finance/accounting/reconciliation",
  "/finance/accounting/chart-of-accounts", "/finance/accounting/reports",
]) ACCESS[path] = { pageKey: "finance_accounting" };

export function hasChannelsAccess(pages: string[]) { return pages.includes("channels") || pages.includes("channels.manage"); }
export function hasFloristOrdersAccess(pages: string[]) { return pages.includes("florist_orders") || pages.includes("orders"); }
export function hasCmcPosAccess(pages: string[]) { return pages.some((p) => p === "cmc-pos" || p.startsWith("cmc_pos.")); }
export function hasCmcPosDashboardAccess(pages: string[]) { return pages.includes("cmc-pos"); }
export function hasCmcPosNewOrderAccess(pages: string[]) { return pages.includes("cmc_pos.sell"); }
export function hasCmcPosSubAccess(subKey: string) {
  return (pages: string[]) => pages.includes(subKey) || (pages.includes("cmc-pos") && !pages.some((p) => p.startsWith("cmc_pos.")));
}
export function hasCmcPosSalesAccess(pages: string[]) {
  return hasCmcPosSubAccess("cmc_pos.sell")(pages) || hasCmcPosSubAccess("cmc_pos.audit")(pages);
}

export function isNavVisible(item: NavItem, isOwner: boolean, realIsOwner: boolean, allowedPages: string[] | null): boolean {
  const rule = ACCESS[item.path] ?? { pageKey: null };
  if (rule.alwaysVisible) return true;
  if (item.path === "/ops-dashboard") return allowedPages !== null && allowedPages.includes("ops-dashboard");
  if (rule.ownerOnly) return allowedPages === null && realIsOwner;
  if (allowedPages === null || isOwner) return true;
  if (item.path === "/channels") return hasChannelsAccess(allowedPages);
  if (item.path === "/florist-orders") return hasFloristOrdersAccess(allowedPages);
  if (item.path === "/brands") return allowedPages.some((p) => p === "brands" || p.startsWith("brands."));
  if (item.path.startsWith("/cmc-pos")) {
    if (item.path === "/cmc-pos") return hasCmcPosAccess(allowedPages);
    return hasCmcPosSubAccess(rule.pageKey ?? "")(allowedPages) ||
      (rule.altPageKey != null && hasCmcPosSubAccess(rule.altPageKey)(allowedPages));
  }
  return rule.pageKey !== null &&
    (allowedPages.includes(rule.pageKey) || (rule.altPageKey != null && allowedPages.includes(rule.altPageKey)));
}

export function isNavGroupVisible(group: NavGroup, isOwner: boolean, realIsOwner: boolean, allowedPages: string[] | null) {
  return group.children.some((child) => isNavVisible(child, isOwner, realIsOwner, allowedPages));
}