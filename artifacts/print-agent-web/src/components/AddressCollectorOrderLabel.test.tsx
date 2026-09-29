import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AddressCollectorOrderLabel } from "./AddressCollectorOrderLabel";

const UUID = "11111111-1111-1111-1111-111111111111";
const baseProps = {
  orderLabel: "Order",
  standaloneLabel: "Standalone respond.io receiver",
  unavailableLabel: "number unavailable",
};

describe("AddressCollectorOrderLabel", () => {
  it("renders a linked order number with exactly one hash prefix", () => {
    render(
      <AddressCollectorOrderLabel
        {...baseProps}
        orderId={UUID}
        orderNumber="#LB-2465"
      />,
    );

    expect(screen.getByText("Order #LB-2465")).toBeInTheDocument();
  });

  it("never exposes a linked order UUID when its display number is missing", () => {
    render(
      <AddressCollectorOrderLabel
        {...baseProps}
        orderId={UUID}
        orderNumber={null}
      />,
    );

    expect(screen.getByText("Order number unavailable")).toBeInTheDocument();
    expect(screen.queryByText(UUID)).not.toBeInTheDocument();
  });

  it("keeps the standalone recipient label", () => {
    render(
      <AddressCollectorOrderLabel
        {...baseProps}
        orderId={null}
        orderNumber={null}
      />,
    );

    expect(screen.getByText(baseProps.standaloneLabel)).toBeInTheDocument();
  });
});