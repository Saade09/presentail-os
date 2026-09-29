import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { StoreTimeSlotsResponse } from "@workspace/api-client-react";

import { TimeSlotsCard } from "./StoreSalesSection";

function makeResponse(): StoreTimeSlotsResponse {
  return {
    range: { from: "2026-06-01", to: "2026-07-16" },
    timeSlots: [
      {
        slot: "09:00–12:00",
        orders: 4,
        revenue: 120,
        sharePct: 24,
        standardOrders: 3,
        standardRevenue: 80,
        expressOrders: 1,
        expressRevenue: 40,
        expressSurchargeUsd: 5,
        slotFeeUsd: 0,
      },
      {
        slot: "12:00–15:00",
        orders: 6,
        revenue: 300,
        sharePct: 60,
        standardOrders: 4,
        standardRevenue: 180,
        expressOrders: 2,
        expressRevenue: 120,
        expressSurchargeUsd: 10,
        slotFeeUsd: 3,
      },
      {
        slot: null,
        orders: 2,
        revenue: 80,
        sharePct: 16,
        standardOrders: 2,
        standardRevenue: 80,
        expressOrders: 0,
        expressRevenue: 0,
        expressSurchargeUsd: 0,
        slotFeeUsd: 0,
      },
    ],
    totals: {
      orders: 12,
      revenue: 500,
      expressOrders: 3,
      expressRevenue: 160,
      expressSurchargeUsd: 15,
      slotFeeUsd: 3,
    },
  };
}

describe("TimeSlotsCard", () => {
  it("renders the bar chart container with the top-slot highlight badge", () => {
    render(
      <TimeSlotsCard data={makeResponse()} isLoading={false} emptyMessage="No data" />,
    );

    // Bar chart (revenue + orders per slot) is rendered.
    expect(screen.getByTestId("chart-sales-by-time-slot")).toBeInTheDocument();

    // Highest-revenue slot is called out explicitly.
    const badge = screen.getByTestId("badge-top-time-slot");
    expect(badge).toHaveTextContent("Top slot");
    expect(badge).toHaveTextContent("12:00–15:00");
  });

  it("renders the breakdown table with the no-slot bucket and totals row", () => {
    render(
      <TimeSlotsCard data={makeResponse()} isLoading={false} emptyMessage="No data" />,
    );

    const table = screen.getByTestId("table-sales-by-time-slot");
    expect(within(table).getByText("09:00–12:00")).toBeInTheDocument();
    expect(within(table).getByText("No time slot")).toBeInTheDocument();
    expect(within(table).getByText("Total")).toBeInTheDocument();
  });

  it("hides the top-slot badge when there is no revenue", () => {
    const data = makeResponse();
    data.timeSlots = data.timeSlots.map((s) => ({
      ...s,
      revenue: 0,
      standardRevenue: 0,
      expressRevenue: 0,
    }));
    data.totals = { ...data.totals, revenue: 0, expressRevenue: 0 };

    render(<TimeSlotsCard data={data} isLoading={false} emptyMessage="No data" />);

    expect(screen.queryByTestId("badge-top-time-slot")).not.toBeInTheDocument();
    expect(screen.getByTestId("chart-sales-by-time-slot")).toBeInTheDocument();
  });

  it("shows the empty state when there are no slots", () => {
    render(
      <TimeSlotsCard
        data={{ timeSlots: [], totals: undefined } as unknown as StoreTimeSlotsResponse}
        isLoading={false}
        emptyMessage="No data"
      />,
    );

    expect(screen.getByText("No data")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-sales-by-time-slot")).not.toBeInTheDocument();
  });
});
