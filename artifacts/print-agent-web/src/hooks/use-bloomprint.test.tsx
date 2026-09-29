import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockApproveBloomprintDraft,
  mockCreateBloomprintDraft,
  mockCreateBloomprintStyleProfile,
  mockDiscardBloomprintDraft,
  mockGetBloomprintDraft,
  mockListBloomprintDrafts,
  mockListBloomprintStyleProfiles,
  mockRenderBloomprintDraft,
  mockUpdateBloomprintDraft,
} = vi.hoisted(() => ({
  mockApproveBloomprintDraft: vi.fn(),
  mockCreateBloomprintDraft: vi.fn(),
  mockCreateBloomprintStyleProfile: vi.fn(),
  mockDiscardBloomprintDraft: vi.fn(),
  mockGetBloomprintDraft: vi.fn(),
  mockListBloomprintDrafts: vi.fn(),
  mockListBloomprintStyleProfiles: vi.fn(),
  mockRenderBloomprintDraft: vi.fn(),
  mockUpdateBloomprintDraft: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  approveBloomprintDraft: mockApproveBloomprintDraft,
  createBloomprintDraft: mockCreateBloomprintDraft,
  createBloomprintStyleProfile: mockCreateBloomprintStyleProfile,
  discardBloomprintDraft: mockDiscardBloomprintDraft,
  getBloomprintDraft: mockGetBloomprintDraft,
  listBloomprintDrafts: mockListBloomprintDrafts,
  listBloomprintStyleProfiles: mockListBloomprintStyleProfiles,
  renderBloomprintDraft: mockRenderBloomprintDraft,
  updateBloomprintDraft: mockUpdateBloomprintDraft,
}));

import {
  useBloomprintDrafts,
  useDeleteBloomprintDraft,
  useUpdateBloomprintDraft,
} from "./use-bloomprint";

const DRAFT_DETAIL = {
  draft: {
    id: 42,
    workspace_owner_id: "workspace-1",
    inspiration_image_path: "inspiration.png",
    analysis: {},
    name: "Spring draft",
    description: "A seasonal arrangement",
    price_usd: "35",
    price_aed: null,
    box_color: "black",
    generated_image_path: null,
    generated_image_public_path: null,
    status: "draft",
    substitution_notes: null,
    approved_product_id: null,
    created_at: "2026-08-22T00:00:00.000Z",
    updated_at: "2026-08-22T00:00:00.000Z",
  },
  recipe_lines: [],
  render_attempts: [],
};

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateBloomprintDraft.mockResolvedValue(DRAFT_DETAIL);
  mockDiscardBloomprintDraft.mockResolvedValue({ id: 42, status: "discarded" });
  mockListBloomprintDrafts.mockResolvedValue({ drafts: [] });
});

describe("useUpdateBloomprintDraft", () => {
  it("serializes displayed recipe rows into the API recipe item shape", async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useUpdateBloomprintDraft("42"), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        name: "Updated spring draft",
        recipe_items: [
          {
            proposed_base_item_id: 17,
            quantity: "2.5",
            rationale: "Use the fuller blooms",
          },
          {
            proposed_base_item_id: 23,
            quantity: "3",
            rationale: "",
          },
        ],
      });
    });

    expect(mockUpdateBloomprintDraft).toHaveBeenCalledWith(42, {
      name: "Updated spring draft",
      recipe_items: [
        {
          base_item_id: 17,
          quantity: 2.5,
          rationale: "Use the fuller blooms",
        },
        {
          base_item_id: 23,
          quantity: 3,
        },
      ],
    });
  });

  it("rejects unresolved recipe rows before sending the update request", async () => {
    const queryClient = createQueryClient();
    const { result } = renderHook(() => useUpdateBloomprintDraft("42"), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          name: "Draft with an unresolved line",
          recipe_items: [
            {
              proposed_base_item_id: null,
              quantity: "1",
              rationale: "Needs review",
            },
          ],
        }),
      ).rejects.toThrow(
        "Each recipe item needs an active Base Item before saving.",
      );
    });

    expect(mockUpdateBloomprintDraft).not.toHaveBeenCalled();
  });
});

describe("useDeleteBloomprintDraft", () => {
  it("removes the detail cache and refreshes the draft list after discarding", async () => {
    const queryClient = createQueryClient();
    const draftListBeforeDiscard = [{ id: 42, name: "Spring draft" }];
    const draftListAfterDiscard: unknown[] = [];
    mockListBloomprintDrafts
      .mockResolvedValueOnce({ drafts: draftListBeforeDiscard })
      .mockResolvedValueOnce({ drafts: draftListAfterDiscard });
    queryClient.setQueryData(["bloomprint-draft", "42"], DRAFT_DETAIL);

    const { result } = renderHook(
      () => ({
        deleteDraft: useDeleteBloomprintDraft("42"),
        drafts: useBloomprintDrafts(),
      }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.drafts.data).toEqual(draftListBeforeDiscard);
    });

    await act(async () => {
      await result.current.deleteDraft.mutateAsync();
    });

    await waitFor(() => {
      expect(mockListBloomprintDrafts).toHaveBeenCalledTimes(2);
      expect(result.current.drafts.data).toEqual(draftListAfterDiscard);
    });
    expect(queryClient.getQueryData(["bloomprint-draft", "42"])).toBeUndefined();
  });
});