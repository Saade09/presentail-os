import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NewOrderAlertBanner } from "./NewOrderAlertBanner";
import type { NewOrderAlert } from "@/hooks/use-new-order-alert-queue";

const navigateMock = vi.fn();

vi.mock("wouter", () => ({
  useLocation: () => ["/", navigateMock],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

const UUID = "3f9c2a10-1234-4bcd-9e8f-aabbccddeeff";

function makeAlert(overrides: Partial<NewOrderAlert> = {}): NewOrderAlert {
  return {
    orderId: UUID,
    displayOrderNumber: "M-1009",
    customerName: "Jane",
    total: 42,
    currency: "USD",
    receivedAt: Date.now(),
    ...overrides,
  } as NewOrderAlert;
}

describe("NewOrderAlertBanner View action", () => {
  it("navigates to the order UUID path even when a display order number is present", () => {
    const onAcknowledge = vi.fn();
    render(
      <NewOrderAlertBanner
        alerts={[makeAlert()]}
        muted={false}
        soundBlocked={false}
        onAcknowledge={onAcknowledge}
        onAcknowledgeAll={vi.fn()}
        onToggleMute={vi.fn()}
      />,
    );

    expect(screen.getByText("#M-1009")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`new-order-alert-view-${UUID}`));

    expect(onAcknowledge).toHaveBeenCalledWith(UUID);
    expect(navigateMock).toHaveBeenCalledWith(`/orders/${UUID}`);
    expect(navigateMock).not.toHaveBeenCalledWith("/orders/m-1009");
  });
});
