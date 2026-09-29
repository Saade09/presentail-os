import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/queryClient";
import ProductDetail from "./ProductDetail";

const product = {
  id: 42,
  workspace_owner_id: "ws-1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.70",
  discount_price_usd: null,
  discount_price_aed: null,
  main_image_url: "/objects/ws-1/products/42/main.webp",
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

const toast = vi.fn();
const navigate = vi.fn();

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
  useParams: () => ({ id: "42" }),
  useLocation: () => ["/products/42", navigate],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn(),
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

describe("ProductDetail AI gallery", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") return { runs: [] };
      if (url.startsWith("/api/base-items")) return { items: [] };
      if (url === "/api/channel-image-configs?image_type=product") return { image_configs: [] };
      if (url === "/api/channels") return { channels: [] };
      return {};
    });
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ProductDetail />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  async function enterEditMode() {
    await screen.findByTestId("product-view-mode");
    await userEvent.click(screen.getByTestId("button-edit-product"));
    await screen.findByTestId("product-edit-mode");
  }

  it("disables generation and explains when no primary image exists", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") {
        return { product: { ...product, main_image_url: null }, recipe: [] };
      }
      if (url === "/api/products/42/gallery/runs") return { runs: [] };
      return {};
    });
    renderPage();
    await enterEditMode();
    expect(screen.getByRole("button", { name: "Generate gallery with AI" })).toBeDisabled();
    expect(screen.getByText("Add a primary product image first.")).toBeInTheDocument();
  });

  it("opens with all four exact gallery types selected", async () => {
    renderPage();
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Generate gallery with AI" }));
    expect(await screen.findByRole("heading", { name: "Generate product gallery" })).toBeInTheDocument();
    expect(screen.getByText("Create additional images using the primary product image as reference.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Alternative composition/)).toBeChecked();
    expect(screen.getByLabelText(/Close-up details/)).toBeChecked();
    expect(screen.getByLabelText(/Lifestyle setting/)).toBeChecked();
    expect(screen.getByLabelText(/Hand-held for scale/)).toBeChecked();
    expect(screen.getByRole("button", { name: "Generate 4 images" })).toBeEnabled();
  });

  it("disables the dynamic action when no gallery type is selected", async () => {
    renderPage();
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Generate gallery with AI" }));
    for (const label of [
      /Alternative composition/,
      /Close-up details/,
      /Lifestyle setting/,
      /Hand-held for scale/,
    ]) {
      await userEvent.click(screen.getByLabelText(label));
    }
    expect(screen.getByRole("button", { name: "Generate 0 images" })).toBeDisabled();
  });

  it("recovers draft state after refresh and marks an old source", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") return { runs: [{ id: 9, status: "COMPLETED" }] };
      if (url === "/api/products/42/gallery/runs/9") {
        return {
          run: {
            id: 9,
            candidates: [{
              id: 101,
              status: "DRAFT",
              gallery_type: "alternative_composition",
              image_path: "/objects/ws-1/gallery/draft.webp",
              source_path: "/objects/ws-1/products/42/old.webp",
            }],
          },
        };
      }
      if (url === "/api/products/42/gallery/runs/9/recover") {
        return { runId: 9, status: "RECOVERY_REQUESTED", recoveredCount: 1 };
      }
      return {};
    });
    renderPage();
    await enterEditMode();
    expect(await screen.findByText("previous-source")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & add to gallery" })).not.toBeInTheDocument();
  });

  it("refetches the product only after explicit approval", async () => {
    let productFetches = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/products/42") {
        productFetches += 1;
        return { product, recipe: [] };
      }
      if (url === "/api/products/42/gallery/runs") return { runs: [{ id: 9, status: "COMPLETED" }] };
      if (url === "/api/products/42/gallery/runs/9") {
        return {
          run: {
            id: 9,
            candidates: [{
              id: 101,
              status: "DRAFT",
              gallery_type: "alternative_composition",
              image_path: "/objects/ws-1/gallery/draft.webp",
              source_path: product.main_image_url,
            }],
          },
        };
      }
      if (url.endsWith("/gallery/candidates/101/approve") && init?.method === "POST") {
        return { candidateId: 101, status: "APPROVED" };
      }
      return {};
    });
    renderPage();
    await enterEditMode();
    await userEvent.click(await screen.findByRole("button", { name: "Approve & add to gallery" }));
    await waitFor(() => expect(productFetches).toBeGreaterThan(1));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Added to gallery" }));
  });

  it("shows completed drafts progressively with truthful active and failed counts", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") {
        return { runs: [{ id: 9, status: "RUNNING" }] };
      }
      if (url === "/api/products/42/gallery/runs/9") {
        return {
          run: {
            id: 9,
            candidates: [
              {
                id: 101,
                status: "DRAFT",
                gallery_type: "alternative_composition",
                image_path: "/objects/ws-1/gallery/draft.webp",
                source_path: product.main_image_url,
              },
              { id: 102, status: "PROCESSING", gallery_type: "close_up_details" },
              { id: 103, status: "RETRY_WAITING", gallery_type: "lifestyle_setting" },
              {
                id: 104,
                status: "FAILED",
                gallery_type: "hand_held_scale",
                error: { message: "The image provider timed out." },
              },
            ],
          },
        };
      }
      return {};
    });

    renderPage();
    await enterEditMode();

    expect(await screen.findByRole("button", { name: "Approve & add to gallery" })).toBeInTheDocument();
    expect(screen.getByText(/1 of 4 finished/)).toHaveTextContent(
      "1 of 4 finished · 1 generating · 1 retrying · 1 failed",
    );
    expect(screen.getByText("Waiting to retry...")).toBeInTheDocument();
    expect(screen.getByText("The image provider timed out.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows a terminal failure count without claiming another image is generating", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") {
        return { runs: [{ id: 9, status: "FAILED" }] };
      }
      if (url === "/api/products/42/gallery/runs/9") {
        return {
          run: {
            id: 9,
            candidates: [{
              id: 104,
              status: "FAILED",
              gallery_type: "hand_held_scale",
              error: { message: "Generation was interrupted too many times." },
            }],
          },
        };
      }
      return {};
    });

    renderPage();
    await enterEditMode();

    expect(await screen.findByText("0 of 1 finished · 1 failed")).toBeInTheDocument();
    expect(screen.queryByText(/Generating 1 of 1/)).not.toBeInTheDocument();
    expect(screen.getByText("Generation was interrupted too many times.")).toBeInTheDocument();
  });

  it("shows a stalled recovery state without an endless generating spinner", async () => {
    let detailFetches = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") {
        return {
          runs: [{
            id: 9,
            status: "RUNNING",
            updated_at: "2026-01-01T00:00:00.000Z",
          }],
        };
      }
      if (url === "/api/products/42/gallery/runs/9") {
        detailFetches += 1;
        return {
          run: {
            id: 9,
            status: "RUNNING",
            updated_at: "2026-01-01T00:00:00.000Z",
            candidates: [{
              id: 101,
              status: "PROCESSING",
              gallery_type: "alternative_composition",
              updated_at: "2026-01-01T00:00:00.000Z",
            }],
          },
        };
      }
      return {};
    });

    renderPage();
    await enterEditMode();

    expect(await screen.findByText(
      "Gallery generation appears stalled or unavailable. Retry generation to recover interrupted work.",
    )).toBeInTheDocument();
    expect(screen.queryByText(/1 generating/)).not.toBeInTheDocument();
    const fetchesBeforeRefresh = detailFetches;
    await userEvent.click(screen.getByRole("button", { name: "Retry generation" }));
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/products/42/gallery/runs/9/recover",
      { method: "POST" },
    );
    await waitFor(() => expect(detailFetches).toBeGreaterThan(fetchesBeforeRefresh));
  });

  it("lets staff manually retry a terminal candidate", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") return { runs: [{ id: 9, status: "FAILED" }] };
      if (url === "/api/products/42/gallery/runs/9") {
        return {
          run: {
            id: 9,
            status: "FAILED",
            candidates: [{
              id: 104,
              status: "FAILED",
              gallery_type: "hand_held_scale",
              error: { message: "Generation was interrupted too many times." },
            }],
          },
        };
      }
      if (url.endsWith("/gallery/candidates/104/retry") && init?.method === "POST") {
        return { candidateId: 104, status: "PENDING" };
      }
      return {};
    });

    renderPage();
    await enterEditMode();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(apiFetch).toHaveBeenCalledWith(
      "/api/products/42/gallery/candidates/104/retry",
      { method: "POST" },
    );
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Regenerating image" }));
  });

  it("surfaces polling failures with an actionable retry", async () => {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") {
        return { runs: [{ id: 9, status: "RUNNING" }] };
      }
      if (url === "/api/products/42/gallery/runs/9") {
        throw new Error("network unavailable");
      }
      return {};
    });

    renderPage();
    await enterEditMode();

    expect(await screen.findByText(
      "Gallery progress could not be refreshed. Check your connection and try again.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("polls an active run, reveals a finished draft, then stops polling", async () => {
    let detailFetches = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url === "/api/products/42") return { product, recipe: [] };
      if (url === "/api/products/42/gallery/runs") {
        return { runs: [{ id: 9, status: "RUNNING" }] };
      }
      if (url === "/api/products/42/gallery/runs/9") {
        detailFetches += 1;
        return {
          run: {
            id: 9,
            candidates: detailFetches === 1
              ? [{ id: 101, status: "PROCESSING", gallery_type: "alternative_composition" }]
              : [{
                  id: 101,
                  status: "DRAFT",
                  gallery_type: "alternative_composition",
                  image_path: "/objects/ws-1/gallery/draft.webp",
                  source_path: product.main_image_url,
                }],
          },
        };
      }
      return {};
    });

    renderPage();
    await enterEditMode();
    expect(await screen.findByText("Generating...")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Approve & add to gallery" }, { timeout: 3_500 }))
      .toBeInTheDocument();

    const fetchesAtCompletion = detailFetches;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(detailFetches).toBe(fetchesAtCompletion);
  }, 8_000);
});