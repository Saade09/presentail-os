import { describe, it, expect } from "vitest";
import {
  cartKey,
  resolveSupplierCatalogItemId,
  buildLineItemPayload,
  type CartItem,
} from "./CreatePoWizard";
import type { SupplierCatalogItem } from "@workspace/api-client-react";

// ---------------------------------------------------------------------------
// Regression coverage for the PO wizard linked-base-item bug.
//
// Ordering a "linked base item" used to send a 404 because the client cart
// submitted the catalog row's id as `supplier_catalog_item_id`, but a linked
// base item has no supplier_catalog_items row — the server must receive
// `supplier_catalog_item_id: null` plus a `base_item_id`. These tests guard the
// payload shape (resolveSupplierCatalogItemId + buildLineItemPayload) and the
// distinct cart keys that let linked + standalone items coexist in one cart.
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<SupplierCatalogItem> = {}): SupplierCatalogItem {
  return {
    id: 1,
    workspace_owner_id: "ws",
    supplier_id: 10,
    name: "Test Item",
    currency: "AED",
    min_order_quantity: "1",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveSupplierCatalogItemId — what the cart stores per item source
// ---------------------------------------------------------------------------

describe("resolveSupplierCatalogItemId — cart supplier_catalog_item_id by source", () => {
  it("returns null for a linked_base_item so the server treats it as a base item", () => {
    const item = makeItem({ id: 42, source: "linked_base_item", base_item_id: 7 });
    expect(resolveSupplierCatalogItemId(item)).toBeNull();
  });

  it("returns the item id for a standalone catalog item", () => {
    const item = makeItem({ id: 42, source: "standalone" });
    expect(resolveSupplierCatalogItemId(item)).toBe(42);
  });

  it("treats a missing source as standalone (uses the item id)", () => {
    const item = makeItem({ id: 99, source: undefined });
    expect(resolveSupplierCatalogItemId(item)).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// buildLineItemPayload — the POST /api/purchase-orders line-item shape
// ---------------------------------------------------------------------------

describe("buildLineItemPayload — line-item payload submitted to the API", () => {
  it("a linked_base_item submits supplier_catalog_item_id: null and base_item_id set", () => {
    const cartItem: CartItem = {
      supplier_catalog_item_id: null,
      item: makeItem({
        id: 500,
        source: "linked_base_item",
        base_item_id: 88,
        name: "Linked Widget",
        price: "12.50",
        currency: "USD",
      }),
      quantity: "3",
    };

    const payload = buildLineItemPayload(cartItem, "AED");

    expect(payload.supplier_catalog_item_id).toBeNull();
    expect(payload.base_item_id).toBe(88);
    expect(payload).toEqual({
      supplier_catalog_item_id: null,
      base_item_id: 88,
      description: "Linked Widget",
      quantity: "3",
      unit_price: "12.50",
      currency: "USD",
    });
  });

  it("a linked_base_item with no base_item_id falls back to null", () => {
    const cartItem: CartItem = {
      supplier_catalog_item_id: null,
      item: makeItem({ id: 501, source: "linked_base_item", base_item_id: null }),
      quantity: "1",
    };

    const payload = buildLineItemPayload(cartItem, "AED");
    expect(payload.supplier_catalog_item_id).toBeNull();
    expect(payload.base_item_id).toBeNull();
  });

  it("a standalone item submits supplier_catalog_item_id: item.id and omits base_item_id", () => {
    const cartItem: CartItem = {
      supplier_catalog_item_id: 600,
      item: makeItem({
        id: 600,
        source: "standalone",
        name: "Standalone Widget",
        price: "4.00",
        currency: "AED",
      }),
      quantity: "5",
    };

    const payload = buildLineItemPayload(cartItem, "AED");

    expect(payload.supplier_catalog_item_id).toBe(600);
    expect("base_item_id" in payload).toBe(false);
    expect(payload).toEqual({
      supplier_catalog_item_id: 600,
      description: "Standalone Widget",
      quantity: "5",
      unit_price: "4.00",
      currency: "AED",
    });
  });

  it("falls back to the order currency when the item has no currency", () => {
    const cartItem: CartItem = {
      supplier_catalog_item_id: 700,
      item: makeItem({ id: 700, source: "standalone", currency: "" }),
      quantity: "2",
    };

    const payload = buildLineItemPayload(cartItem, "EUR");
    expect(payload.currency).toBe("EUR");
  });

  it("falls back to '0' unit_price when the item has no price", () => {
    const cartItem: CartItem = {
      supplier_catalog_item_id: 800,
      item: makeItem({ id: 800, source: "standalone", price: null }),
      quantity: "2",
    };

    const payload = buildLineItemPayload(cartItem, "AED");
    expect(payload.unit_price).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// cartKey — mixing linked + standalone items must not collide
// ---------------------------------------------------------------------------

describe("cartKey — distinct keys keep linked + standalone items separate", () => {
  it("namespaces the key by source so the same id does not collide", () => {
    const linked = makeItem({ id: 5, source: "linked_base_item", base_item_id: 5 });
    const standalone = makeItem({ id: 5, source: "standalone" });

    expect(cartKey(linked)).toBe("linked_base_item-5");
    expect(cartKey(standalone)).toBe("standalone-5");
    expect(cartKey(linked)).not.toBe(cartKey(standalone));
  });

  it("a cart keyed by cartKey holds both a linked and a standalone item with the same id", () => {
    const linked = makeItem({ id: 5, source: "linked_base_item", base_item_id: 5, name: "Linked" });
    const standalone = makeItem({ id: 5, source: "standalone", name: "Standalone" });

    const cart = new Map<string, CartItem>();
    cart.set(cartKey(linked), {
      supplier_catalog_item_id: resolveSupplierCatalogItemId(linked),
      item: linked,
      quantity: "2",
    });
    cart.set(cartKey(standalone), {
      supplier_catalog_item_id: resolveSupplierCatalogItemId(standalone),
      item: standalone,
      quantity: "3",
    });

    expect(cart.size).toBe(2);

    const payloads = Array.from(cart.values()).map((ci) => buildLineItemPayload(ci, "AED"));
    const linkedPayload = payloads.find((p) => p.description === "Linked");
    const standalonePayload = payloads.find((p) => p.description === "Standalone");

    expect(linkedPayload?.supplier_catalog_item_id).toBeNull();
    expect(linkedPayload?.base_item_id).toBe(5);
    expect(standalonePayload?.supplier_catalog_item_id).toBe(5);
    expect("base_item_id" in (standalonePayload ?? {})).toBe(false);
  });

  it("treats a missing source as the standalone namespace", () => {
    const item = makeItem({ id: 9, source: undefined });
    expect(cartKey(item)).toBe("standalone-9");
  });
});
