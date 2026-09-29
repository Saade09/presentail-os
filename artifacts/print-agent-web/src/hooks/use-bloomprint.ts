import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  approveBloomprintDraft,
  createBloomprintDraft,
  createBloomprintStyleProfile,
  discardBloomprintDraft,
  getBloomprintDraft,
  listBloomprintDrafts,
  listBloomprintStyleProfiles,
  renderBloomprintDraft,
  updateBloomprintDraft,
} from "@workspace/api-client-react";
import type {
  BloomprintDraft,
  BloomprintDraftDetailResponse,
  BloomprintDraftInput,
  BloomprintDraftListItem,
  BloomprintDraftUpdate,
  BloomprintRecipeLine,
  BloomprintRenderAttempt,
  BloomprintStyleProfile,
  BloomprintStyleProfileInput,
} from "@workspace/api-client-react";
import { isPermissionError } from "@/lib/permissionError";

export function bloomprintErrorMessage(error: unknown, fallback: string): string {
  if (isPermissionError(error)) {
    return "Bloomprint requires owner access or the Manage products permission. Ask a workspace owner to grant access.";
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export type StyleProfile = BloomprintStyleProfile;
export type RecipeLine = BloomprintRecipeLine;
export type RenderAttempt = BloomprintRenderAttempt;
export type Draft = Omit<BloomprintDraft, "analysis"> & {
  analysis: BloomprintDraft["analysis"] & { visual_summary?: string };
  recipe_lines?: RecipeLine[];
  render_attempts?: RenderAttempt[];
};
type DraftSummary = BloomprintDraftListItem & Pick<Partial<Draft>, "analysis" | "description">;
type DraftEditorUpdate = Omit<BloomprintDraftUpdate, "recipe_items"> & {
  recipe_items?: Array<Pick<RecipeLine, "proposed_base_item_id" | "quantity" | "rationale">>;
};

function draftId(id: number | string): number {
  return Number(id);
}

function unwrapDraftDetail(response: BloomprintDraftDetailResponse): Draft {
  return {
    ...response.draft,
    recipe_lines: response.recipe_lines,
    render_attempts: response.render_attempts,
  };
}

export function useBloomprintDrafts() {
  return useQuery({
    queryKey: ["bloomprint-drafts"],
    queryFn: async (): Promise<DraftSummary[]> => (await listBloomprintDrafts()).drafts,
  });
}

export function useBloomprintDraft(id: number | string | undefined) {
  return useQuery({
    queryKey: ["bloomprint-draft", id],
    queryFn: async () => unwrapDraftDetail(await getBloomprintDraft(draftId(id!))),
    enabled: !!id && id !== "new",
  });
}

export function useCreateBloomprintDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: BloomprintDraftInput) =>
      unwrapDraftDetail(await createBloomprintDraft(data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bloomprint-drafts"] });
    },
  });
}

export function useUpdateBloomprintDraft(id: number | string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: DraftEditorUpdate) => {
      const { recipe_items, ...draftFields } = data;
      const update: BloomprintDraftUpdate = {
        ...draftFields,
        ...(recipe_items
          ? {
              recipe_items: recipe_items.map((item) => {
                if (item.proposed_base_item_id == null) {
                  throw new Error("Each recipe item needs an active Base Item before saving.");
                }
                return {
                  base_item_id: item.proposed_base_item_id,
                  quantity: Number(item.quantity),
                  ...(item.rationale ? { rationale: item.rationale } : {}),
                };
              }),
            }
          : {}),
      };
      return unwrapDraftDetail(await updateBloomprintDraft(draftId(id), update));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bloomprint-draft", id] });
      queryClient.invalidateQueries({ queryKey: ["bloomprint-drafts"] });
    },
  });
}

export function useRenderBloomprintDraft(id: number | string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => unwrapDraftDetail(await renderBloomprintDraft(draftId(id))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bloomprint-draft", id] });
      queryClient.invalidateQueries({ queryKey: ["bloomprint-drafts"] });
    },
  });
}

export function useApproveBloomprintDraft(id: number | string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => approveBloomprintDraft(draftId(id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bloomprint-draft", id] });
      queryClient.invalidateQueries({ queryKey: ["bloomprint-drafts"] });
    },
  });
}

export function useDeleteBloomprintDraft(id: number | string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => discardBloomprintDraft(draftId(id)),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["bloomprint-draft", id] });
      queryClient.invalidateQueries({ queryKey: ["bloomprint-drafts"] });
    },
  });
}

export function useBloomprintStyleProfiles() {
  return useQuery({
    queryKey: ["bloomprint-style-profiles"],
    queryFn: async () => (await listBloomprintStyleProfiles()).profiles,
  });
}

export function useCreateBloomprintStyleProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: BloomprintStyleProfileInput) =>
      (await createBloomprintStyleProfile(data)).profile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bloomprint-style-profiles"] });
    },
  });
}
