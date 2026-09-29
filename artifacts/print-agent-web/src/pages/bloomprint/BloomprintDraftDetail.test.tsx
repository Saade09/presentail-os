import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockUseBloomprintDraft,
  mockUpdateDraft,
  mockRenderDraft,
  mockApproveDraft,
  mockDeleteDraft,
  mockApiFetch,
} = vi.hoisted(() => ({
  mockUseBloomprintDraft: vi.fn(),
  mockUpdateDraft: { isPending: false, mutate: vi.fn() },
  mockRenderDraft: { isPending: false, mutate: vi.fn() },
  mockApproveDraft: { isPending: false, mutate: vi.fn() },
  mockDeleteDraft: { isPending: false, mutate: vi.fn() },
  mockApiFetch: vi.fn(),
}));

vi.mock("@/hooks/use-bloomprint", () => ({
  useBloomprintDraft: mockUseBloomprintDraft,
  useUpdateBloomprintDraft: () => mockUpdateDraft,
  useRenderBloomprintDraft: () => mockRenderDraft,
  useApproveBloomprintDraft: () => mockApproveDraft,
  useDeleteBloomprintDraft: () => mockDeleteDraft,
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: mockApiFetch,
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useParams: () => ({ id: "2" }),
  useLocation: () => ["/bloomprint/2", vi.fn()],
}));

import BloomprintDraftDetail from "./BloomprintDraftDetail";

const RESOLVED_ITEM = { id: 3, name: "White Rose", code: "BQ8LJD", image_url: "/objects/x/rose.jpg" };
const BASE_ITEMS = [
  RESOLVED_ITEM,
  { id: 4, name: "Pink Rose", code: "LDUSWF", image_url: null },
  { id: 5, name: "Purple Rose", code: "PHHFQM", image_url: null },
];

function makeDraft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 2,
    name: "Test Draft",
    description: "desc",
    price_usd: "50.00",
    price_aed: "180.00",
    box_color: "black",
    substitution_notes: "",
    status: "draft",
    inspiration_image_path: "/objects/x/y.jpg",
    generated_image_path: null,
    analysis: {},
    render_attempts: [],
    approved_product_id: null,
    recipe_lines: [
      {
        id: 1,
        line_order: 0,
        proposed_base_item_id: 3,
        proposed_base_item_name: "White Rose",
        quantity: 12,
        extracted_requirement: "White flowers, roughly a dozen",
        match_confidence: "high",
        source_type: "auto",
        rationale: "Matched by AI vision analysis",
      },
    ],
    ...overrides,
  };
}

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BloomprintDraftDetail />
    </QueryClientProvider>,
  );
}

describe("BloomprintDraftDetail — Resolved Base Item combobox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBloomprintDraft.mockReturnValue({ data: makeDraft(), isLoading: false });
    mockApiFetch.mockImplementation((url: string) => {
      if (/\/api\/base-items\/3$/.test(url)) {
        return Promise.resolve({ item: RESOLVED_ITEM });
      }
      if (/\/api\/base-items\?/.test(url)) {
        const match = decodeURIComponent(url).match(/[?&]q=([^&]+)/);
        if (!match) {
          return Promise.resolve({ items: BASE_ITEMS });
        }
        const q = match[1].toLowerCase();
        return Promise.resolve({ items: BASE_ITEMS.filter(i => i.name.toLowerCase().includes(q)) });
      }
      throw new Error(`Unexpected apiFetch call: ${url}`);
    });
  });

  it("shows the currently resolved item as the trigger label with its thumbnail", async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByText("Recipe & Build"));

    const trigger = await screen.findByRole("combobox");
    expect(within(trigger).getByText("White Rose")).toBeInTheDocument();

    await waitFor(() => {
      const img = within(trigger).queryByRole("img", { name: "White Rose" });
      expect(img).toHaveAttribute("src", expect.stringContaining("/api/storage/objects/x/rose.jpg"));
    });
  });

  it("lets staff search base items and shows thumbnails (or a placeholder) per option", async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByText("Recipe & Build"));
    const trigger = await screen.findByRole("combobox");
    await user.click(trigger);

    const searchInput = await screen.findByPlaceholderText("Search base items…");
    await user.type(searchInput, "rose");

    await waitFor(() => {
      expect(screen.getByText("Pink Rose")).toBeInTheDocument();
      expect(screen.getByText("Purple Rose")).toBeInTheDocument();
    });

    // Item with no image_url falls back to a placeholder initial instead of an <img>.
    const pinkRoseOption = screen.getByText("Pink Rose").closest('[cmdk-item]') as HTMLElement;
    expect(within(pinkRoseOption).queryByRole("img")).not.toBeInTheDocument();
    expect(within(pinkRoseOption).getByText("P")).toBeInTheDocument();
  });

  it("updates the requirement's resolved base item id/name on selection", async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByText("Recipe & Build"));
    const trigger = await screen.findByRole("combobox");
    await user.click(trigger);

    const searchInput = await screen.findByPlaceholderText("Search base items…");
    await user.type(searchInput, "purple");

    const option = await screen.findByText("Purple Rose");
    await user.click(option);

    await waitFor(() => {
      expect(within(screen.getByRole("combobox")).getByText("Purple Rose")).toBeInTheDocument();
    });
  });

  it("requests enough results that an item past the API's default page size is searchable", async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByText("Recipe & Build"));
    const trigger = await screen.findByRole("combobox");
    await user.click(trigger);
    await screen.findByPlaceholderText("Search base items…");

    await waitFor(() => {
      const urls = mockApiFetch.mock.calls.map(call => call[0] as string);
      const searchCall = urls.find(u => /\/api\/base-items\?/.test(u) && !/\/api\/base-items\/\d+/.test(u));
      expect(searchCall).toBeDefined();
      // The base-items API defaults to only 10 results per page; without an
      // explicit higher limit, items beyond the first page would be
      // unreachable through this "no search term yet" view.
      expect(searchCall).toMatch(/[?&]limit=100(&|$)/);
    });
  });

  it("disables the combobox once the draft is approved", async () => {
    mockUseBloomprintDraft.mockReturnValue({ data: makeDraft({ status: "approved" }), isLoading: false });
    const user = userEvent.setup();
    renderComponent();

    await user.click(screen.getByText("Recipe & Build"));
    const trigger = await screen.findByRole("combobox");
    expect(trigger).toBeDisabled();
  });
});
