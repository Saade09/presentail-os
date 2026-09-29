/**
 * Single source of truth for valid allowedPages keys.
 *
 * Both the web frontend (artifacts/print-agent-web) and the API server
 * (artifacts/api-server) import from this package. Adding a new page key here
 * automatically keeps both sides in sync — no manual duplication required.
 *
 * Rules for adding a new page:
 *  1. Add it to ALL_PAGES (top-level pages) or SUB_PERMISSION_LABELS (sub-permissions)
 *     in this file — this is the only place that needs to change.
 *  2. On the frontend, if the page is also a post-login redirect destination, add the
 *     corresponding route to POST_LOGIN_ROUTES in post-login-routes.ts as well.
 */

/** Canonical page keys for the independently grantable CMC POS workflows. */
export const CMC_POS_DASHBOARD_PAGE_KEY = "cmc-pos-dashboard";
export const CMC_POS_NEW_ORDER_PAGE_KEY = "cmc-pos-new-order";
/** Canonical page key for the invoice scanner management page. */
export const INVOICE_SCANNERS_PAGE_KEY = "invoice-scanners";

/** Every top-level page key available in the role editor. */
export const ALL_PAGES: { key: string; label: string }[] = [
  { key: "project-manager-dashboard", label: "Dashboard" },
  { key: "ops-dashboard", label: "Ops Dashboard" },
  { key: "devices", label: "Devices" },
  { key: INVOICE_SCANNERS_PAGE_KEY, label: "Invoice Scanners" },
  { key: "stickers", label: "Stickers" },
  { key: "locations", label: "Locations" },
  { key: "cities", label: "Delivery Cities" },
  { key: "brands", label: "Brands" },
  { key: "channels.manage", label: "Manage Channels" },
  { key: "products", label: "Products" },
  { key: "coupons", label: "Coupons" },
  { key: "base-items", label: "Base Items" },
  { key: "base-item-categories", label: "Base Item Categories" },
  { key: "suppliers", label: "Suppliers" },
  { key: "ai-invoice-import", label: "AI Invoice Import" },
  { key: "api-keys", label: "API Keys" },
  { key: "downloads", label: "Downloads" },
  { key: "print-history", label: "Print History" },
  { key: "analytics", label: "Analytics" },
  { key: "store-analytics", label: "E-commerce Analytics" },
  { key: "cart-checkout-analytics", label: "Cart & Checkout Analytics" },
  { key: "operations-analytics", label: "Operations Analytics" },
  { key: "customer-analytics", label: "Customer Analytics" },
  { key: "marketing-analytics", label: "Marketing Analytics" },
  { key: "seo-analytics", label: "SEO Analytics" },
  { key: "delivery-analytics", label: "Delivery Analytics" },
  { key: "search-discovery-analytics", label: "Search & Discovery Analytics" },
  { key: "inventory-cogs-analytics", label: "Inventory & COGS Analytics" },
  { key: "upsell", label: "Upsell" },
  { key: "marketplace-analytics", label: "Marketplace Analytics" },
  { key: "users", label: "Users" },
  { key: "roles", label: "Roles" },
  { key: "payment-links", label: "Payment Links" },
  { key: "api-docs", label: "API Docs" },
  { key: "settings", label: "Settings" },
  { key: "time-off", label: "Time Off" },
  { key: "homepage-banners", label: "Homepage Banners" },
  { key: "fleet", label: "Fleet" },
  { key: "customers", label: "Contacts" },
  { key: "audiences", label: "Audiences" },
  { key: "address-book", label: "Address Book" },
  { key: "address-collector", label: "Address Collector" },
  { key: "publishing-channels", label: "Publishing Channels" },
  { key: "marketing-budget-planner", label: "Marketing Budget Planner" },
  { key: "catalog-occasions", label: "Occasions" },
  { key: "catalog-categories-attr", label: "Categories" },
  { key: "catalog-brands-attr", label: "Brands" },
  { key: "catalog-recipients", label: "Recipients" },
  { key: "webhook-endpoints", label: "Webhook Endpoints" },
  { key: "omnichannel-inbox", label: "Inbox" },
  { key: "omnichannel-automations", label: "Automations" },
  { key: "omnichannel-contacts", label: "Contacts" },
  { key: "omnichannel-analytics", label: "Omnichannel Analytics" },
  { key: "people.directory", label: "People Directory" },
  { key: "people.invites", label: "Invites & Access" },
  { key: "people.attendance", label: "Attendance" },
  { key: "people.work-schedules", label: "Work Schedules" },
  { key: "brand-sticker-sheets", label: "Brand Sticker Sheets" },
  { key: "occasion-campaigns", label: "Occasion Campaigns" },
  { key: "orders", label: "Orders" },
  { key: "florist_orders", label: "Florist Orders" },
  { key: "purchase-orders", label: "Purchase Orders" },
  { key: "invoices", label: "Invoices" },
  { key: "cash-sessions", label: "Cash Sessions" },
  { key: "cash-drawers", label: "Cash Drawers" },
  { key: "card-message", label: "Card Message Print" },
  { key: "finance_accounting", label: "Finance & Accounting" },
  { key: "backlink-engine", label: "Backlink Engine" },
  { key: "review-rewards", label: "Google Review Rewards" },
  { key: CMC_POS_DASHBOARD_PAGE_KEY, label: "CMC POS Dashboard" },
  { key: CMC_POS_NEW_ORDER_PAGE_KEY, label: "CMC POS New Order" },
  { key: "cmc-pos", label: "CMC POS" },
  { key: "events", label: "Events" },
];

/** Human-readable labels for sub-permission keys. */
export const SUB_PERMISSION_LABELS: Record<string, string> = {
  "brands.manage": "Manage brands",
  "brands.create": "Create brands",
  "brands.edit": "Edit brand details",
  "brands.manage-logos": "Manage logos",
  "brands.manage-cover-photos": "Manage cover photos",
  "brands.manage-card-message": "Manage card message",
  "brands.delete": "Delete brands",
  "products.manage": "Manage products",
  "upsell.manage": "Manage upsell items",
  "coupons.manage": "Manage coupons",
  "base_items.manage": "Manage base items",
  "base_items.create": "Create base items",
  "base_items.delete": "Delete base items",
  "stickers.upload": "Upload stickers",
  "sticker-sheets.upload": "Upload sticker sheets",
  "sticker-sheets.approve": "Approve sticker sheets",
  "sticker-sheets.request-changes": "Request changes on sticker sheets",
  "sticker-sheets.archive": "Archive sticker sheets",
  "sticker-sheets.delete": "Delete sticker sheets",
  "time-off.manage": "Manage time-off policies & public holidays",
  "cities.manage": "Manage delivery cities",
  "homepage_banners.manage": "Manage homepage banners",
  "fleet.manage": "Manage fleet drivers & vehicle types",
  "base-item-categories.create": "Create categories",
  "base-item-categories.edit": "Edit categories",
  "base-item-categories.delete": "Delete categories",
  "suppliers.create": "Create suppliers",
  "suppliers.edit": "Edit suppliers",
  "suppliers.delete": "Archive suppliers",
  "suppliers.approve": "Approve purchase orders",
  "users.invite": "Invite members",
  "users.edit": "Edit member details",
  "users.assign-role": "Assign member roles",
  "users.remove": "Remove members",
  "users.revoke-invite": "Revoke invitations",
  "users.resend-invite": "Resend invitations",
  "users.copy-invite-link": "Copy invite links",
  "users.make-owner": "Make member an owner",
  "channels.create": "Create channels",
  "channels.edit": "Edit channels",
  "channels.delete": "Delete channels",
  "channels.manage-logo": "Manage channel logos",
  "channels.manage-image-configs": "Manage image configs",
  "catalog-occasions.create": "Create occasions",
  "catalog-occasions.edit": "Edit occasions",
  "catalog-occasions.delete": "Delete occasions",
  "catalog-categories-attr.create": "Create categories",
  "catalog-categories-attr.edit": "Edit categories",
  "catalog-categories-attr.delete": "Delete categories",
  "catalog-brands-attr.create": "Create brands",
  "catalog-brands-attr.edit": "Edit brands",
  "catalog-brands-attr.delete": "Delete brands",
  "catalog-recipients.create": "Create recipients",
  "catalog-recipients.edit": "Edit recipients",
  "catalog-recipients.delete": "Delete recipients",
  "occasion-campaigns.edit": "Create & edit campaigns and occasion types",
  "occasion-campaigns.delete": "Delete campaigns and occasion types",
  "purchase-orders.create": "Create purchase orders",
  "purchase-orders.edit": "Edit purchase orders",
  "purchase-orders.delete": "Delete purchase orders",
  "invoices.create": "Create invoices",
  "invoices.edit": "Edit invoices",
  "invoices.delete": "Delete invoices",
  "cash_sessions.open": "Open cash sessions",
  "cash_sessions.close": "Close cash sessions",
  "cash_sessions.approve": "Approve cash sessions",
  "cash_sessions.reopen": "Reopen cash sessions",
  "cash_sessions.flag": "Flag cash sessions",
  "cash_sessions.adjust": "Add cash session adjustments",
  "cash_sessions.export": "Export cash sessions",
  "cash_sessions.transfer": "Initiate cash transfers",
  "cash_sessions.receive_transfer": "Confirm cash transfer receipt",
  "cash_sessions.resolve_transfer_dispute": "Resolve cash transfer disputes",
  "cash_drawers.create": "Create cash drawers",
  "cash_drawers.edit": "Edit cash drawers",
  "cash_drawers.deactivate": "Deactivate cash drawers",
  "cash_transactions.create": "Record cash transactions",
  "payroll_expenses": "Record payroll expenses",
  "backlink-engine.manage": "Manage backlinks (approve & send outreach)",
  "cmc_pos.sell": "Sell shelf products",
  "cmc_pos.discount": "Apply discounts on CMC sales",
  "cmc_pos.refund": "Refund or void CMC sales",
  "cmc_pos.edit": "Edit CMC sales (notes, payment method)",
  "cmc_pos.create_request": "Create branch requests",
  "cmc_pos.accept_request": "Accept branch requests",
  "cmc_pos.dispatch_request": "Dispatch branch requests",
  "cmc_pos.receive_request": "Receive branch requests at CMC",
  "cmc_pos.override_fulfillment": "Override CMC fulfillment decisions",
  "cmc_pos.view_location_requests": "View source-location requests",
  "cmc_pos.audit": "View CMC audit report and export",
  "cmc_pos.monthly_sales": "View CMC Monthly Sales report",
  "cmc_pos.returns": "Submit CMC returns",
  "cmc_pos.delete_request": "Delete branch requests",
  "cmc_pos.cash_drawer": "View CMC cash drawer",
  "events.manage": "Manage events",
  "finance_manager": "Finance Manager (approve & sync supplier reconciliations)",
};

/**
 * The complete set of valid page-key strings.
 * Derived automatically from ALL_PAGES and SUB_PERMISSION_LABELS.
 */
export const VALID_PAGE_KEYS: ReadonlySet<string> = new Set([
  ...ALL_PAGES.map((p) => p.key),
  ...Object.keys(SUB_PERMISSION_LABELS),
]);

/**
 * Returns true if the given value is a recognised page key.
 */
export function isValidPageKey(key: unknown): key is string {
  return typeof key === "string" && VALID_PAGE_KEYS.has(key);
}

/**
 * Validate an allowedPages array from a request body.
 * Returns null if all keys are valid, or an error message string if any key is unknown.
 */
export function validateAllowedPages(pages: unknown[]): string | null {
  const invalid = pages.filter((p) => !isValidPageKey(p));
  if (invalid.length === 0) return null;
  const quoted = invalid.map((v) => JSON.stringify(v)).join(", ");
  return `Unknown page key${invalid.length > 1 ? "s" : ""}: ${quoted}`;
}
