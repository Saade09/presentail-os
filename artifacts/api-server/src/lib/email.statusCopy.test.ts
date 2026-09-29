import { describe, it, expect } from "vitest";
import { buildOrderStatusHtml } from "./email";

describe("order status email copy", () => {
  it("says the order has been delivered for the completed status", () => {
    const html = buildOrderStatusHtml({ orderNumber: "LB-42", status: "completed" });
    expect(html).toContain("been delivered");
    expect(html).toContain("Your order has been delivered.");
    expect(html).toContain("Delivered");
    expect(html).not.toContain("is now complete");
    expect(html).not.toContain("Your order is<br/>complete");
  });

  it("keeps the out-for-delivery copy", () => {
    const html = buildOrderStatusHtml({ orderNumber: "LB-42", status: "out_for_delivery" });
    expect(html).toContain("out for delivery");
  });
});
