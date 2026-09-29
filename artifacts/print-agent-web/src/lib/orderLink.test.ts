import { describe, expect, it } from "vitest";

import { orderDetailPath } from "./orderLink";

describe("orderDetailPath", () => {
  it.each([
    {
      kind: "externally-ingested order",
      order: {
        id: "d647fdf5-23d3-4a08-be1f-ee6b06ca475f",
        display_order_number: null,
        external_order_id: "LB-2368",
      },
    },
    {
      kind: "manual order",
      order: {
        id: "15ffd98a-b1eb-4098-a9b8-3c305b8af46e",
        display_order_number: "M-1079",
        external_order_id: null,
      },
    },
    {
      kind: "order without a visible number",
      order: {
        id: "f5ee5b4a-88f2-4a3c-859b-03c2bea63196",
        display_order_number: null,
        external_order_id: null,
      },
    },
  ])("uses the canonical UUID for a $kind", ({ order }) => {
    expect(orderDetailPath(order)).toBe(`/orders/${order.id}`);
  });
});