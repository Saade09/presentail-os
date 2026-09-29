import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { OrderStatusStepper } from "./OrderStatusStepper";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Render the i18n key as the label so tests are locale-agnostic.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIMESTAMPS: Record<string, string> = {
  pending:    "2026-08-10T08:00:00.000Z",
  processing: "2026-08-10T09:15:00.000Z",
  preparing:  "2026-08-10T10:30:00.000Z",
};

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

describe("OrderStatusStepper — basic render", () => {
  it("renders the stepper container", () => {
    render(
      <OrderStatusStepper status="pending" />,
    );
    expect(screen.getByTestId("order-status-stepper")).toBeInTheDocument();
  });

  it("renders all 6 flow steps", () => {
    render(<OrderStatusStepper status="pending" />);
    const stepper = screen.getByTestId("order-status-stepper");
    // Each step has a label rendered as the i18n key.
    expect(stepper).toHaveTextContent("orders.statusPending");
    expect(stepper).toHaveTextContent("orders.statusProcessing");
    expect(stepper).toHaveTextContent("orders.statusPreparing");
    expect(stepper).toHaveTextContent("orders.statusReadyForDelivery");
    expect(stepper).toHaveTextContent("orders.statusOutForDelivery");
    expect(stepper).toHaveTextContent("orders.statusCompleted");
  });
});

// ---------------------------------------------------------------------------
// Timestamps — appear only for reached steps
// ---------------------------------------------------------------------------

describe("OrderStatusStepper — timestamp visibility", () => {
  it("shows no timestamps when statusTimestamps is empty", () => {
    render(<OrderStatusStepper status="preparing" />);
    expect(screen.queryByTestId("step-timestamp-pending")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-timestamp-processing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-timestamp-preparing")).not.toBeInTheDocument();
  });

  it("shows timestamps for reached (done) steps", () => {
    render(
      <OrderStatusStepper
        status="preparing"
        statusTimestamps={TIMESTAMPS}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    // pending and processing are "done" (before active)
    expect(screen.getByTestId("step-timestamp-pending")).toBeInTheDocument();
    expect(screen.getByTestId("step-timestamp-processing")).toBeInTheDocument();
  });

  it("shows timestamp for the active (current) step", () => {
    render(
      <OrderStatusStepper
        status="preparing"
        statusTimestamps={TIMESTAMPS}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    // preparing is the active step — its timestamp should also appear
    expect(screen.getByTestId("step-timestamp-preparing")).toBeInTheDocument();
  });

  it("does not show timestamps for future (unreached) steps", () => {
    render(
      <OrderStatusStepper
        status="preparing"
        statusTimestamps={{
          ...TIMESTAMPS,
          // Provide timestamps for future steps too — should still be hidden
          ready_for_delivery: "2026-08-10T11:00:00.000Z",
          out_for_delivery:   "2026-08-10T12:00:00.000Z",
          completed:          "2026-08-10T13:00:00.000Z",
        }}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    expect(screen.queryByTestId("step-timestamp-ready_for_delivery")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-timestamp-out_for_delivery")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-timestamp-completed")).not.toBeInTheDocument();
  });

  it("shows no timestamp element for a step that has no entry in statusTimestamps", () => {
    // Only processing has a timestamp; pending and preparing do not.
    render(
      <OrderStatusStepper
        status="preparing"
        statusTimestamps={{ processing: "2026-08-10T09:15:00.000Z" }}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    expect(screen.queryByTestId("step-timestamp-pending")).not.toBeInTheDocument();
    expect(screen.getByTestId("step-timestamp-processing")).toBeInTheDocument();
    expect(screen.queryByTestId("step-timestamp-preparing")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Timestamp formatting — same-day vs cross-day
// ---------------------------------------------------------------------------

describe("OrderStatusStepper — timestamp formatting", () => {
  it("shows only time (no ·) for a same-day timestamp", () => {
    render(
      <OrderStatusStepper
        status="processing"
        statusTimestamps={{
          pending:    "2026-08-10T08:00:00.000Z", // same UTC date as orderedAt
          processing: "2026-08-10T09:15:00.000Z",
        }}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    const el = screen.getByTestId("step-timestamp-pending");
    // Same day → "h:mm AM/PM" only, no date portion
    expect(el.textContent).not.toContain("·");
    expect(el.textContent).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
  });

  it("shows date + time (with ·) for a cross-day timestamp", () => {
    render(
      <OrderStatusStepper
        status="processing"
        statusTimestamps={{
          pending:    "2026-08-09T22:00:00.000Z", // previous UTC date
          processing: "2026-08-10T09:00:00.000Z",
        }}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    const el = screen.getByTestId("step-timestamp-pending");
    expect(el.textContent).toContain("·");
  });
});

// ---------------------------------------------------------------------------
// Off-flow statuses (cancelled etc.) still render the stepper
// ---------------------------------------------------------------------------

describe("OrderStatusStepper — off-flow statuses", () => {
  it("renders without error when status is cancelled (no active step in flow)", () => {
    render(<OrderStatusStepper status="cancelled" />);
    expect(screen.getByTestId("order-status-stepper")).toBeInTheDocument();
  });

  it("shows no timestamps for cancelled orders even if timestamps are provided", () => {
    render(
      <OrderStatusStepper
        status="cancelled"
        statusTimestamps={TIMESTAMPS}
        orderedAt="2026-08-10T07:00:00.000Z"
        timezone="UTC"
      />,
    );
    // None of the steps are "reached" when status is off-flow
    expect(screen.queryByTestId("step-timestamp-pending")).not.toBeInTheDocument();
  });
});
