import type { QueryKey, UseQueryResult, UseMutationResult } from "@tanstack/react-query";
import type {
  CatalogAttributeListResponse,
  CatalogAttributeCreateInput,
  CatalogAttributeUpdateInput,
  CatalogAttributeCityAvailabilityResponse,
  CatalogAttributeCityAvailabilityUpdateInput,
  CatalogAttributeCityAvailabilityBulkBody,
} from "@workspace/api-client-react";

export type ListParams = {
  q?: string;
  status?: "active" | "inactive";
  page?: number;
  pageSize?: number;
};

export interface AttributeHooksConfig {
  useList: (params?: ListParams) => UseQueryResult<CatalogAttributeListResponse> & { queryKey: QueryKey };
  getListQueryKey: (params?: ListParams) => QueryKey;
  useCreate: () => UseMutationResult<unknown, Error, { data: CatalogAttributeCreateInput }>;
  useUpdate: () => UseMutationResult<unknown, Error, { id: number; data: CatalogAttributeUpdateInput }>;
  useDelete: () => UseMutationResult<unknown, Error, { id: number }>;
  useGetCityAvailability: (id: number) => UseQueryResult<CatalogAttributeCityAvailabilityResponse> & { queryKey: QueryKey };
  getCityAvailabilityQueryKey: (id: number) => QueryKey;
  useSetCityAvailability: () => UseMutationResult<unknown, Error, { id: number; data: CatalogAttributeCityAvailabilityUpdateInput }>;
  useBulkSetCityAvailability: () => UseMutationResult<unknown, Error, { id: number; data: CatalogAttributeCityAvailabilityBulkBody }>;
}
