import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeliveryCell } from "./OrderDeliveryCell";
import type { OrderRow } from "./orderRowHelpers";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "orders.relToday": "Today",
        "orders.relTomorrow": "Tomorrow",
        "orders.expressDelivery": "Express",
      })[key] ?? key,
  }),
}));

const expressOrder = {
  id: "express-order",
  status: "pending",
  delivery_type: "express",
  window_start: null,
  window_end: null,
  delivery_address: {
    date: "2026-09-10",
    slot: "Express",
    district: "Beirut",
  },
  delivery_timezone: "Asia/Beirut",
} as unknown as OrderRow;

describe("Orders delivery cell", () => {
  it("shows the date and Express marker for imported dated Express metadata", () => {
    render(
      <DeliveryCell
        order={expressOrder}
        nowMs={new Date("2026-09-09T06:00:00.000Z").getTime()}
      />,
    );

    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    expect(screen.getAllByText("Express")).toHaveLength(2);
    expect(screen.getByText("Beirut")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });
});