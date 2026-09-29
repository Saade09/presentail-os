import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user_test123" }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useCreateManualOrder: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/ContactSearchPicker", () => ({
  ContactSearchPicker: () => <div data-testid="contact-picker" />,
  contactDisplayName: (contact: { display_name?: string | null }) =>
    contact.display_name ?? "",
}));

vi.mock("@/components/CountryCombobox", () => ({
  CountryCombobox: ({ onChange }: { onChange: (code: string) => void }) => (
    <button type="button" data-testid="choose-country-lb" onClick={() => onChange("LB")}>
      Lebanon
    </button>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "wizard-cities") {
      return {
        data: {
          countries: ["Lebanon"],
          cities: [
            {
              slug: "beirut",
              name: "Beirut",
              country: "Lebanon",
              country_code: "LB",
              delivery_fee: "7.50",
              free_delivery_enabled: false,
              free_delivery_threshold: null,
              currency: "USD",
            },
          ],
        },
        isLoading: false,
      };
    }
    if (queryKey[0] === "create-order-products") {
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
              has_input_field: false,
              letter_input_enabled: false,
            },
          ],
          total: 1,
        },
        isLoading: false,
      };
    }
    if (queryKey[0] === "catalog-categories" || queryKey[0] === "catalog-occasions") {
      return { data: [], isLoading: false };
    }
    return { data: { payment_links: [] }, isLoading: false };
  },
}));

import { CreateOrderWizard } from "./CreateOrderWizard";

describe("CreateOrderWizard delivery fee display", () => {
  it("shows the selected city's fee and includes it in the live total", async () => {
    const user = userEvent.setup();
    render(
      <CreateOrderWizard
        open
        onOpenChange={() => {}}
        initialCustomer={{ name: "Jane Doe", phone: "+96170000000" }}
      />,
    );

    await user.click(screen.getByTestId("button-create-order-next"));
    await user.click(screen.getByTestId("checkbox-create-order-same-as-customer"));
    await user.click(screen.getByTestId("button-create-order-next"));
    await user.click(screen.getByTestId("choose-country-lb"));

    await user.click(screen.getByRole("combobox", { name: "" }));
    await user.click(await screen.findByRole("option", { name: "Beirut" }));
    await user.click(screen.getByTestId("button-create-order-next"));
    await user.click(screen.getByTestId("button-add-product-1"));

    expect(screen.getByTestId("create-order-delivery-fee")).toHaveTextContent("USD 7.50");
    expect(screen.getByTestId("create-order-grand-total")).toHaveTextContent("USD 32.50");
  });
});