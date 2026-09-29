import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { ByCityCard } from "./StoreProductAnalytics";

const withMargin = [
  { name: "Beirut", orders: 10, revenue: 500, marginUsd: 120 },
  { name: "Saida", orders: 5, revenue: 200, marginUsd: null },
];

const withoutMargin = [
  { name: "Beirut", orders: 10, revenue: 500, marginUsd: null },
  { name: "Saida", orders: 5, revenue: 200, marginUsd: null },
];

describe("ByCityCard", () => {
  it("renders city names, orders, revenue and share", () => {
    render(<ByCityCard rows={withMargin} />);
    const row0 = screen.getByTestId("row-city-product-0");
    expect(row0).toHaveTextContent("Beirut");
    expect(row0).toHaveTextContent("10");
    expect(row0).toHaveTextContent("$500.00");
    expect(row0).toHaveTextContent("66.7%");
    expect(screen.getByTestId("row-city-product-1")).toHaveTextContent("Saida");
  });

  it("shows the Margin column when at least one row has margin data", () => {
    render(<ByCityCard rows={withMargin} />);
    expect(
      screen.getByText("Margin"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("row-city-product-0")).toHaveTextContent(
      "$120.00",
    );
    expect(
      screen.queryByTestId("text-city-margin-hint"),
    ).not.toBeInTheDocument();
  });

  it("hides the Margin column entirely and shows a hint when no row has margin data", () => {
    render(<ByCityCard rows={withoutMargin} />);
    expect(
      screen.queryByText("Margin"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("text-city-margin-hint")).toBeInTheDocument();
  });

  it("renders the empty state when there are no rows", () => {
    render(<ByCityCard rows={[]} />);
    expect(screen.getByText("No data for this period.")).toBeInTheDocument();
  });
});
