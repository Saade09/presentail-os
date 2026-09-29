import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@clerk/react", () => ({
  useAuth: () => ({ userId: "user_test123" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useCreateManualOrder: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/ContactSearchPicker", () => ({
  ContactSearchPicker: () => null,
  contactDisplayName: () => "",
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import {
  CreateOrderProductThumbnail,
  CreateOrderWizard,
} from "./CreateOrderWizard";

const products = [
  {
    id: 1,
    name: "Plain Bouquet",
    price_usd: "20",
    price_aed: "73",
    main_image_url: "/objects/user_test123/products/original",
    main_image_thumbnail_url:
      "https://os.presentail.com/api/storage/public-objects/products/1/main-thumbnail-1234567890abcdef.webp",
    status: "available",
    sku: null,
    has_input_field: false,
    letter_input_enabled: false,
  },
  {
    id: 2,
    name: "Letter Balloon",
    price_usd: "30",
    price_aed: "110",
    main_image_url: null,
    status: "available",
    sku: null,
    has_input_field: false,
    letter_input_enabled: true,
  },
  {
    id: 3,
    name: "Custom Mug",
    price_usd: "15",
    price_aed: "55",
    main_image_url: null,
    status: "available",
    sku: null,
    has_input_field: true,
    letter_input_enabled: false,
  },
];

function renderWizard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CreateOrderWizard
        open
        onOpenChange={() => {}}
        initialCustomer={{ name: "Jane" }}
      />
    </QueryClientProvider>,
  );
}

async function goToProductsStep() {
  const next = screen.getByTestId("button-create-order-next");
  fireEvent.click(next); // step 1 -> 2
  fireEvent.click(next); // step 2 -> 3
  await waitFor(() => {
    expect(screen.getByTestId("button-add-product-1")).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockImplementation((url: string) => {
    if (typeof url === "string" && (url.includes("categories") || url.includes("occasions"))) {
      return Promise.resolve([]);
    }
    return Promise.resolve({ products, total: products.length });
  });
});

describe("CreateOrderWizard personalization input", () => {
  it("uses the optimized thumbnail URL in the product picker", async () => {
    render(
      <CreateOrderProductThumbnail product={products[0]} eager />,
    );
    const image = screen.getByRole("presentation");
    expect(image).toHaveAttribute(
      "src",
      expect.stringContaining("main-thumbnail-1234567890abcdef.webp"),
    );
    expect(image).toHaveAttribute("width", "36");
    expect(image).toHaveAttribute("height", "36");
  });

  it("hides the input for products with both toggles off", async () => {
    renderWizard();
    await goToProductsStep();
    fireEvent.click(screen.getByTestId("button-add-product-1"));
    expect(
      screen.queryByPlaceholderText("orders.co.customInputPlaceholder"),
    ).not.toBeInTheDocument();
  });

  it("shows the input when letter_input_enabled is on", async () => {
    renderWizard();
    await goToProductsStep();
    fireEvent.click(screen.getByTestId("button-add-product-2"));
    expect(
      screen.getByPlaceholderText("orders.co.customInputPlaceholder"),
    ).toBeInTheDocument();
  });

  it("shows the input when has_input_field is on, and only for that line", async () => {
    renderWizard();
    await goToProductsStep();
    fireEvent.click(screen.getByTestId("button-add-product-1"));
    fireEvent.click(screen.getByTestId("button-add-product-3"));
    const inputs = screen.getAllByPlaceholderText(
      "orders.co.customInputPlaceholder",
    );
    expect(inputs).toHaveLength(1);
  });
});
