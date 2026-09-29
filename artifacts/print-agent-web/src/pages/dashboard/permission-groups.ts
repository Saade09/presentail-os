// ── Permission group definitions ──────────────────────────────────────────────
// Extracted so nav.test.ts can import this without pulling in React/UI deps.

import {
  CMC_POS_DASHBOARD_PAGE_KEY,
  CMC_POS_NEW_ORDER_PAGE_KEY,
} from "@workspace/page-keys";

export type PermPage = {
  key: string;
  label: string;
  subPerms?: { key: string; label: string }[];
};

export type PermGroup = {
  id: string;
  label: string;
  description: string;
  pages: PermPage[];
};

export const PERMISSION_GROUPS: PermGroup[] = [
  {
    id: "core",
    label: "Core",
    description: "Main workspace navigation and reporting tools",
    pages: [
      { key: "project-manager-dashboard", label: "Dashboard" },
      { key: "devices", label: "Devices" },
      { key: "invoice-scanners", label: "Invoice Scanners" },
      { key: "print-history", label: "Print History" },
      { key: "analytics", label: "Analytics" },
      { key: "store-analytics", label: "E-commerce Analytics" },
      { key: "cart-checkout-analytics", label: "Cart & Checkout Analytics" },
      { key: "operations-analytics", label: "Operations Analytics" },
      { key: "customer-analytics", label: "Customer Analytics" },
      { key: "marketing-analytics", label: "Marketing Analytics" },
      { key: "seo-analytics", label: "SEO Analytics" },
      { key: "inventory-cogs-analytics", label: "Inventory & COGS Analytics" },
      { key: "marketplace-analytics", label: "Marketplace Analytics" },
      { key: "delivery-analytics", label: "Delivery Analytics" },
      { key: "search-discovery-analytics", label: "Search & Discovery Analytics" },
      { key: "locations", label: "Locations" },
      {
        key: "cities",
        label: "Delivery Cities",
        subPerms: [{ key: "cities.manage", label: "Manage delivery cities" }],
      },
      { key: "settings", label: "Settings" },
      { key: "api-docs", label: "API Docs" },
    ],
  },
  {
    id: "catalog",
    label: "Catalog",
    description: "Products, brands, base items, categories, and stickers",
    pages: [
      {
        key: "brands",
        label: "Brands",
        subPerms: [
          { key: "brands.manage", label: "Manage brands" },
          { key: "brands.create", label: "Create brands" },
          { key: "brands.edit", label: "Edit brand details" },
          { key: "brands.manage-logos", label: "Manage logos" },
          { key: "brands.manage-cover-photos", label: "Manage cover photos" },
          { key: "brands.manage-card-message", label: "Manage card message" },
          { key: "brands.delete", label: "Delete brands" },
        ],
      },
      {
        key: "products",
        label: "Products",
        subPerms: [{ key: "products.manage", label: "Manage products" }],
      },
      {
        key: "events",
        label: "Events",
        subPerms: [{ key: "events.manage", label: "Manage events" }],
      },
      {
        key: "upsell",
        label: "Upsell",
        subPerms: [{ key: "upsell.manage", label: "Manage upsell items" }],
      },
      {
        key: "base-items",
        label: "Base Items",
        subPerms: [
          { key: "base_items.manage", label: "Manage base items" },
          { key: "base_items.create", label: "Create Base Items" },
        ],
      },
      {
        key: "base-item-categories",
        label: "Base Item Categories",
        subPerms: [
          { key: "base-item-categories.create", label: "Create categories" },
          { key: "base-item-categories.edit", label: "Edit categories" },
          { key: "base-item-categories.delete", label: "Delete categories" },
        ],
      },
      {
        key: "stickers",
        label: "Stickers (legacy)",
        subPerms: [{ key: "stickers.upload", label: "Upload stickers" }],
      },
      {
        key: "brand-sticker-sheets",
        label: "Brand Sticker Sheets",
        subPerms: [
          { key: "sticker-sheets.upload", label: "Upload sticker sheets" },
          { key: "sticker-sheets.approve", label: "Approve sticker sheets" },
          { key: "sticker-sheets.request-changes", label: "Request changes on sticker sheets" },
          { key: "sticker-sheets.archive", label: "Archive sticker sheets" },
          { key: "sticker-sheets.delete", label: "Delete sticker sheets" },
        ],
      },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    description: "Channels, fleet, and customer management",
    pages: [
      { key: "ops-dashboard", label: "Ops Dashboard" },
      {
        key: "channels.manage",
        label: "Manage Channels",
        subPerms: [
          { key: "channels.create", label: "Create channels" },
          { key: "channels.edit", label: "Edit channels" },
          { key: "channels.delete", label: "Delete channels" },
          { key: "channels.manage-logo", label: "Manage channel logos" },
          { key: "channels.manage-image-configs", label: "Manage image configs" },
        ],
      },
      {
        key: "fleet",
        label: "Fleet",
        subPerms: [
          { key: "fleet.manage", label: "Manage fleet drivers & vehicle types" },
        ],
      },
      { key: "orders", label: "Orders" },
      { key: "florist_orders", label: "Florist Orders" },
      { key: "customers", label: "Contacts" },
      { key: "address-book", label: "Address Book" },
      { key: "address-collector", label: "Address Collector" },
      { key: "api-keys", label: "API Keys" },
      { key: "webhook-endpoints", label: "Webhook Endpoints" },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    description: "Homepage banners, campaigns, and marketing tools",
    pages: [
      {
        key: "homepage-banners",
        label: "Homepage Banners",
        subPerms: [
          { key: "homepage_banners.manage", label: "Manage homepage banners" },
        ],
      },
      {
        key: "coupons",
        label: "Coupons",
        subPerms: [{ key: "coupons.manage", label: "Manage coupons" }],
      },
      { key: "marketing-budget-planner", label: "Marketing Budget Planner" },
      { key: "occasion-campaigns", label: "Occasion Campaigns" },
      { key: "card-message", label: "Card Messages" },
      { key: "backlink-engine", label: "Backlink Engine" },
      { key: "review-rewards", label: "Google Review Rewards" },
    ],
  },
  {
    id: "catalog-attributes",
    label: "Catalog Attributes",
    description: "Occasions, categories, brands, and recipients for the product catalog",
    pages: [
      {
        key: "catalog-occasions",
        label: "Occasions",
        subPerms: [
          { key: "catalog-occasions.create", label: "Create occasions" },
          { key: "catalog-occasions.edit", label: "Edit occasions" },
          { key: "catalog-occasions.delete", label: "Delete occasions" },
        ],
      },
      {
        key: "catalog-categories-attr",
        label: "Categories",
        subPerms: [
          { key: "catalog-categories-attr.create", label: "Create categories" },
          { key: "catalog-categories-attr.edit", label: "Edit categories" },
          { key: "catalog-categories-attr.delete", label: "Delete categories" },
        ],
      },
      {
        key: "catalog-brands-attr",
        label: "Brands",
        subPerms: [
          { key: "catalog-brands-attr.create", label: "Create brands" },
          { key: "catalog-brands-attr.edit", label: "Edit brands" },
          { key: "catalog-brands-attr.delete", label: "Delete brands" },
        ],
      },
      {
        key: "catalog-recipients",
        label: "Recipients",
        subPerms: [
          { key: "catalog-recipients.create", label: "Create recipients" },
          { key: "catalog-recipients.edit", label: "Edit recipients" },
          { key: "catalog-recipients.delete", label: "Delete recipients" },
        ],
      },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    description: "Payments, invoicing, accounting, and financial tools",
    pages: [
      { key: "payment-links", label: "Payment Links" },
      { key: "finance_accounting", label: "Accounting" },
      {
        key: "invoices",
        label: "Invoices",
        subPerms: [
          { key: "invoices.create", label: "Create invoices" },
          { key: "invoices.edit", label: "Edit invoices" },
          { key: "invoices.delete", label: "Delete invoices" },
        ],
      },
    ],
  },
  {
    id: "procurement",
    label: "Procurement",
    description: "Purchase orders, supplier management, procurement workflows, and inventory receiving",
    pages: [
      {
        key: "suppliers",
        label: "Suppliers",
        subPerms: [
          { key: "suppliers.create", label: "Create suppliers" },
          { key: "suppliers.edit", label: "Edit suppliers" },
          { key: "suppliers.delete", label: "Archive suppliers" },
        ],
      },
      {
        key: "purchase-orders",
        label: "Purchase Orders",
        subPerms: [
          { key: "purchase-orders.create", label: "Create purchase orders" },
          { key: "purchase-orders.edit", label: "Edit purchase orders" },
          { key: "purchase-orders.delete", label: "Delete purchase orders" },
          { key: "suppliers.approve", label: "Approve purchase orders" },
        ],
      },
      {
        key: "supplier-statements",
        label: "Supplier Statements",
        subPerms: [
          { key: "supplier-statements.create", label: "Create statement requests" },
          { key: "supplier-statements.edit", label: "Edit schedules and contacts" },
        ],
      },
      { key: "ai-invoice-import", label: "Invoice Import (AI)" },
    ],
  },
  {
    id: "time-off-hr",
    label: "Time Off / HR",
    description: "Employee attendance, schedules, and time-off management",
    pages: [
      { key: "people.attendance", label: "Attendance" },
      { key: "people.work-schedules", label: "Work Schedules" },
      {
        key: "time-off",
        label: "Time Off",
        subPerms: [
          {
            key: "time-off.manage",
            label: "Manage time-off policies & public holidays",
          },
        ],
      },
    ],
  },
  {
    id: "cmc-pos",
    label: "CMC POS",
    description: "CMC Beirut Hospital point of sale, branch requests, and delivery orders",
    pages: [
      { key: CMC_POS_DASHBOARD_PAGE_KEY, label: "Dashboard" },
      { key: CMC_POS_NEW_ORDER_PAGE_KEY, label: "New Order" },
      {
        key: "cmc-pos",
        label: "CMC POS",
        subPerms: [
          { key: "cmc_pos.sell", label: "Sell shelf products" },
          { key: "cmc_pos.discount", label: "Apply discounts on CMC sales" },
          { key: "cmc_pos.refund", label: "Refund or void CMC sales" },
          { key: "cmc_pos.edit", label: "Edit CMC sales (notes, payment method)" },
          { key: "cmc_pos.create_request", label: "Create branch requests" },
          { key: "cmc_pos.accept_request", label: "Accept branch requests" },
          { key: "cmc_pos.dispatch_request", label: "Dispatch branch requests" },
          { key: "cmc_pos.receive_request", label: "Receive branch requests at CMC" },
          { key: "cmc_pos.override_fulfillment", label: "Override CMC fulfillment decisions" },
          { key: "cmc_pos.view_location_requests", label: "View source-location requests" },
          { key: "cmc_pos.audit", label: "View CMC audit report and export" },
          { key: "cmc_pos.monthly_sales", label: "View CMC monthly sales" },
          { key: "cmc_pos.returns", label: "Submit CMC returns" },
          { key: "cmc_pos.delete_request", label: "Delete branch requests" },
          { key: "cmc_pos.cash_drawer", label: "View CMC cash drawer" },
        ],
      },
    ],
  },
  {
    id: "cash-desk",
    label: "Cash Desk",
    description: "Cash sessions, bills, drawers, and downloads",
    pages: [
      {
        key: "cash-sessions",
        label: "Cash Sessions & Bills",
        subPerms: [
          { key: "cash_sessions.open", label: "Open cash sessions" },
          { key: "cash_sessions.close", label: "Close cash sessions" },
          { key: "cash_sessions.approve", label: "Approve cash sessions" },
          { key: "cash_sessions.reopen", label: "Reopen cash sessions" },
          { key: "cash_sessions.flag", label: "Flag cash sessions" },
          { key: "cash_sessions.adjust", label: "Add cash session adjustments" },
          { key: "cash_sessions.export", label: "Export cash sessions" },
          { key: "cash_transactions.create", label: "Record cash transactions" },
          { key: "cash_sessions.transfer", label: "Initiate cash transfers" },
          { key: "cash_sessions.receive_transfer", label: "Confirm transfer receipt" },
          { key: "cash_sessions.resolve_transfer_dispute", label: "Resolve transfer disputes" },
          { key: "payroll_expenses", label: "Record payroll expenses" },
        ],
      },
      {
        key: "cash-drawers",
        label: "Cash Drawers",
        subPerms: [
          { key: "cash_drawers.create", label: "Create cash drawers" },
          { key: "cash_drawers.edit", label: "Edit cash drawers" },
          { key: "cash_drawers.deactivate", label: "Deactivate cash drawers" },
        ],
      },
      { key: "downloads", label: "Downloads" },
    ],
  },
  {
    id: "omnichannel",
    label: "Omnichannel",
    description: "Inbox, automations, contacts, and omnichannel analytics",
    pages: [
      { key: "omnichannel-inbox", label: "Inbox" },
      { key: "omnichannel-automations", label: "Automations" },
      { key: "omnichannel-contacts", label: "Omnichannel Contacts" },
      { key: "omnichannel-analytics", label: "Omnichannel Analytics" },
    ],
  },
  {
    id: "publishing",
    label: "Publishing",
    description: "Publishing channels and snapshot publishing",
    pages: [
      { key: "publishing-channels", label: "Publishing Channels" },
    ],
  },
  {
    id: "people",
    label: "People",
    description: "Team directory and workspace access management",
    pages: [
      { key: "people.directory", label: "People Directory" },
      { key: "people.invites", label: "Invites & Access" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "User management, roles, and administrative tools",
    pages: [
      {
        key: "users",
        label: "Users",
        subPerms: [
          { key: "users.invite", label: "Invite members" },
          { key: "users.edit", label: "Edit member details" },
          { key: "users.assign-role", label: "Assign member roles" },
          { key: "users.remove", label: "Remove members" },
          { key: "users.revoke-invite", label: "Revoke invitations" },
          { key: "users.resend-invite", label: "Resend invitations" },
          { key: "users.copy-invite-link", label: "Copy invite links" },
          { key: "users.make-owner", label: "Make member an owner" },
        ],
      },
      { key: "roles", label: "Roles" },
    ],
  },
];
