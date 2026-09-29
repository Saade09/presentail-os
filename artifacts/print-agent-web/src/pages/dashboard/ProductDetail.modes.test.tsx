import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProductDetail from "./ProductDetail";

const MOCK_PRODUCT = {
  id: 42,
  workspace_owner_id: "ws-1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.70",
  discount_price_usd: null,
  discount_price_aed: null,
  main_image_url: null,
  additional_image_urls: [],
  description: "A useful description",
  status: "available",
  brand: "Presentail",
  tags: ["gift"],
  category: "Gifts",
  catalog_categories: [{ id: 1, name: "Gifts", slug: "gifts" }],
  occasions: [{ id: 2, name: "Birthday", slug: "birthday" }],
  catalog_brand: { id: 3, name: "Presentail" },
  has_input_field: true,
  letter_input_enabled: false,
  is_upsell: true,
  is_cmc: false,
  created_at: "2026-01-01T00:00:00.000Z",
};
const MOCK_RECIPE: never[] = [];

const toast = vi.fn();
const navigate = vi.fn();
const apiFetch = vi.fn();
let failNextSave = false;

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
  useParams: () => ({ id: "42" }),
  useLocation: () => ["/products/42", navigate],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  getClerkToken: vi.fn(),
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({
    role: "owner",
    isOwner: true,
    canManage: true,
    allowedPages: ["products.manage"],
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[0] === "product") {
      return { data: { product: MOCK_PRODUCT, recipe: MOCK_RECIPE }, isLoading: false, isError: false };
    }
    if (queryKey[0] === "brands") {
      return { data: { brands: [] }, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: (options: {
    mutationFn: (value: unknown) => Promise<unknown>;
    onMutate?: () => void;
    onSuccess?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }) => {
    const [isPending, setIsPending] = React.useState(false);
    return {
      isPending,
      mutate: async (value: unknown) => {
        options.onMutate?.();
        setIsPending(true);
        try {
          const result = await options.mutationFn(value);
          options.onSuccess?.(result);
        } catch (error) {
          options.onError?.(error as Error);
        } finally {
          setIsPending(false);
        }
      },
    };
  },
}));

describe("ProductDetail modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/products/42" && init?.method === "PATCH") {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("Temporary save failure");
        }
        const body = JSON.parse(String(init.body));
        return { product: { ...MOCK_PRODUCT, ...body, price_usd: String(body.price_usd), price_aed: String(body.price_aed) } };
      }
      return {};
    });
  });

  it("opens in a scan-friendly read-only mode with representative settings", () => {
    render(<ProductDetail />);

    expect(screen.getByTestId("product-view-mode")).toBeInTheDocument();
    expect(screen.getByText("Media")).toBeInTheDocument();
    expect(screen.getByText("Market pricing")).toBeInTheDocument();
    expect(screen.getByText("Personalization & channels")).toBeInTheDocument();
    expect(screen.getByText("Birthday")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("enables Save only for a semantic change and disables it after reverting", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    const save = screen.getByRole("button", { name: "Save" });
    const name = screen.getByLabelText(/Name/);
    expect(save).toBeDisabled();

    await user.clear(name);
    await user.type(name, " Test Product ");
    expect(save).toBeDisabled();

    await user.clear(name);
    await user.type(name, "Changed Product");
    expect(save).toBeEnabled();

    await user.clear(name);
    await user.type(name, "Test Product");
    expect(save).toBeDisabled();
  });

  it("treats an invalid optional discount as unsaved work", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    const discount = screen.getByLabelText("Discount (USD)") as HTMLInputElement;
    discount.type = "text";
    await user.type(discount, "invalid");
    discount.type = "number";

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
  });

  it("keeps edits when discard is rejected and restores values when confirmed", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "Changed Product");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(name).toHaveValue("Changed Product");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByTestId("product-view-mode")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Test Product" })).toBeInTheDocument();
  });

  it("guards tab changes and switches only after a confirmed discard", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    await user.type(screen.getByLabelText(/Name/), " changed");
    await user.click(screen.getByRole("tab", { name: "Recipe" }));

    expect(screen.getByRole("tabpanel", { name: "Product Details" })).toHaveAttribute("data-state", "active");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Recipe" })).toHaveAttribute("data-state", "active"));
  });

  it("shows the save lifecycle and success toast after a successful request", async () => {
    const user = userEvent.setup();
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "Saved Product");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/api/products/42",
      expect.objectContaining({ method: "PATCH" }),
    ));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Saved",
      duration: 4000,
    })));
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("keeps entered values after a failed save and allows a retry", async () => {
    const user = userEvent.setup();
    failNextSave = true;
    render(<ProductDetail />);

    await user.click(screen.getByTestId("button-edit-product"));
    const name = screen.getByLabelText(/Name/);
    await user.clear(name);
    await user.type(name, "Retry Product");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Failed to save product",
    })));
    expect(name).toHaveValue("Retry Product");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Saved" })));
  });
});