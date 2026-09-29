import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user_test123" }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const mockMutate = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useCreateManualOrder: () => ({ mutate: mockMutate, isPending: false }),
}));

// Products query (step 3) — one product available to add.
// Category/occasion queries return empty arrays so the filter pills don't crash.
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "catalog-categories" || queryKey[0] === "catalog-occasions") {
      return { data: [], isLoading: false };
    }
    return {
      data: {
        products: [
          {
            id: 1,
            name: "Roses",
            price_usd: "25.00",
            price_aed: "90.00",
            main_image_url: null,
            status: "available",
            sku: "SKU-1",
          },
        ],
        total: 1,
      },
      isLoading: false,
    };
  },
}));

// Contact picker is exercised elsewhere; the prefill path keeps step 1 valid.
vi.mock("@/components/ContactSearchPicker", () => ({
  ContactSearchPicker: () => <div data-testid="contact-picker" />,
  contactDisplayName: (c: { display_name?: string | null }) => c.display_name ?? "",
}));

import { CreateOrderWizard } from "./CreateOrderWizard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function advanceToDelivery(user: ReturnType<typeof userEvent.setup>) {
  // Customer → Recipient (same as customer) → Delivery.
  await user.click(screen.getByTestId("button-create-order-next"));
  await user.click(screen.getByTestId("button-create-order-next"));
}

async function advanceToCardMessage(user: ReturnType<typeof userEvent.setup>) {
  // Delivery → Products → Payment details → Card message.
  await user.click(screen.getByTestId("button-create-order-next"));
  // Products: add the product, then → Details.
  await user.click(screen.getByTestId("button-add-product-1"));
  await user.click(screen.getByTestId("button-create-order-next"));
  await user.click(screen.getByTestId("button-create-order-next"));
}

function renderWizard(initialCustomer = { name: "Jane Doe", phone: "+96170000000" }) {
  const user = userEvent.setup();
  render(
    <CreateOrderWizard
      open
      onOpenChange={() => {}}
      initialCustomer={initialCustomer}
    />,
  );
  return user;
}

function lastPayload() {
  expect(mockMutate).toHaveBeenCalled();
  const call = mockMutate.mock.calls.at(-1)!;
  return (call[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CreateOrderWizard – delivery date/time", () => {
  it("creates an order with the chosen delivery window and syncs the address date/slot", async () => {
    const user = renderWizard();
    await advanceToDelivery(user);

    // Pick a delivery day from the calendar popover (day 15 of current month).
    await user.click(screen.getByTestId("create-order-delivery-day"));
    const grid = await screen.findByRole("grid");
    await user.click(within(grid).getByText("15", { selector: "button, [role=gridcell] *, td *" }));

    // Set the start (10:00) and end (12:00) times.
    const startTime = screen.getByTestId("create-order-start-time");
    await user.click(within(startTime).getByLabelText("Hour"));
    await user.click(await screen.findByRole("option", { name: "10" }));
    const endTime = screen.getByTestId("create-order-end-time");
    await user.click(within(endTime).getByLabelText("Hour"));
    await user.click(await screen.findByRole("option", { name: "12" }));

    await advanceToCardMessage(user);
    await user.click(screen.getByTestId("button-create-order-submit"));

    const payload = lastPayload();
    const start = new Date(payload.window_start as string);
    const end = new Date(payload.window_end as string);
    expect(start.getHours()).toBe(10);
    expect(end.getHours()).toBe(12);
    expect(start.getDate()).toBe(15);
    expect(end.getDate()).toBe(15);

    const addr = payload.delivery_address as Record<string, unknown>;
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(addr.date).toBe(
      `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    );
    expect(typeof addr.slot).toBe("string");
    expect(addr.slot).not.toBe("");
  });

  it("still creates an order without a delivery window (empty stays empty)", async () => {
    const user = renderWizard();
    await advanceToDelivery(user);

    // Do not pick a day; the time pickers are hidden until a day is chosen.
    expect(screen.queryByTestId("create-order-start-time")).not.toBeInTheDocument();

    await advanceToCardMessage(user);
    await user.click(screen.getByTestId("button-create-order-submit"));

    const payload = lastPayload();
    expect(payload.window_start).toBeNull();
    expect(payload.window_end).toBeNull();
    expect(payload.delivery_address).toBeNull();
  });

  it("blocks Next when the end time is before the start time", async () => {
    const user = renderWizard();
    await advanceToDelivery(user);

    await user.click(screen.getByTestId("create-order-delivery-day"));
    const grid = await screen.findByRole("grid");
    await user.click(within(grid).getByText("15", { selector: "button, [role=gridcell] *, td *" }));

    const startTime = screen.getByTestId("create-order-start-time");
    await user.click(within(startTime).getByLabelText("Hour"));
    await user.click(await screen.findByRole("option", { name: "14" }));
    const endTime = screen.getByTestId("create-order-end-time");
    await user.click(within(endTime).getByLabelText("Hour"));
    await user.click(await screen.findByRole("option", { name: "10" }));

    // Validation error shown; Next is disabled so the user stays on Details.
    // There may be more than one alert (e.g. past-date warning + window error).
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    expect(screen.getByTestId("button-create-order-next")).toBeDisabled();
  });

  it("normalizes prefilled customer and card names in the dashboard payload", async () => {
    const user = renderWizard({ name: "  janah   khadaj ", phone: "+96170000000" });
    await advanceToDelivery(user);

    // The card fields are the first two text inputs on this step; the third
    // textbox is the free-form message and stays raw.
    await advanceToCardMessage(user);
    const [cardFrom, cardTo] = screen.getAllByRole("textbox");
    await user.type(cardFrom, "  sara   saad ");
    await user.type(cardTo, "mary-jane o'connor");
    await user.click(screen.getByTestId("button-create-order-submit"));

    const payload = lastPayload();
    expect(payload.customer).toMatchObject({ display_name: "Janah Khadaj" });
    expect(payload.card_from).toBe("Sara Saad");
    expect(payload.card_to).toBe("Mary-Jane O'Connor");
  });
});
