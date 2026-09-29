import { LayoutGrid } from "lucide-react";
import { AttributeListPage } from "./AttributeListPage";
import type { AttributeHooksConfig } from "./attributeHooks";
import {
  useListCatalogCategories,
  getListCatalogCategoriesQueryKey,
  useCreateCatalogCategory,
  useUpdateCatalogCategory,
  useDeleteCatalogCategory,
  useGetCatalogCategoryCityAvailability,
  getGetCatalogCategoryCityAvailabilityQueryKey,
  useSetCatalogCategoryCityAvailability,
  useBulkSetCatalogCategoryCityAvailability,
} from "@workspace/api-client-react";

const hooksConfig: AttributeHooksConfig = {
  useList: useListCatalogCategories as AttributeHooksConfig["useList"],
  getListQueryKey: getListCatalogCategoriesQueryKey as AttributeHooksConfig["getListQueryKey"],
  useCreate: useCreateCatalogCategory as AttributeHooksConfig["useCreate"],
  useUpdate: useUpdateCatalogCategory as AttributeHooksConfig["useUpdate"],
  useDelete: useDeleteCatalogCategory as AttributeHooksConfig["useDelete"],
  useGetCityAvailability: useGetCatalogCategoryCityAvailability as AttributeHooksConfig["useGetCityAvailability"],
  getCityAvailabilityQueryKey: getGetCatalogCategoryCityAvailabilityQueryKey,
  useSetCityAvailability: useSetCatalogCategoryCityAvailability as AttributeHooksConfig["useSetCityAvailability"],
  useBulkSetCityAvailability: useBulkSetCatalogCategoryCityAvailability as AttributeHooksConfig["useBulkSetCityAvailability"],
};

export default function CatalogCategoriesPage() {
  return (
    <AttributeListPage
      hooksConfig={hooksConfig}
      typeSingular="Category"
      title="Categories"
      icon={<LayoutGrid size={18} />}
      permissionKey="catalog-categories-attr"
      attributeType="category"
      showDescription
      showFeaturedToggle
    />
  );
}
