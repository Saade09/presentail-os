import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

export type RecipeAttentionSummary = {
  attention_count: number;
  products_without_recipe: number[];
  products_with_pending_suggestion: Array<{
    product_id: number;
    suggestion_id: number;
    version: number;
    confidence: number | null;
    created_at: string;
  }>;
};

export const recipeAttentionQueryKey = ["recipe-review-summary"] as const;

export function useRecipeAttention(enabled = true) {
  return useQuery({
    queryKey: recipeAttentionQueryKey,
    queryFn: () =>
      apiFetch<RecipeAttentionSummary>("/api/products/recipe-review-summary"),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}