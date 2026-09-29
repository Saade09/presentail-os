import { Sparkles } from "lucide-react";
import { AttributeListPage } from "./AttributeListPage";
import type { AttributeHooksConfig } from "./attributeHooks";
import {
  useListCatalogBrands,
  getListCatalogBrandsQueryKey,
  useCreateCatalogBrand,
  useUpdateCatalogBrand,
  useDeleteCatalogBrand,
  useGetCatalogBrandCityAvailability,
  getGetCatalogBrandCityAvailabilityQueryKey,
  useSetCatalogBrandCityAvailability,
  useBulkSetCatalogBrandCityAvailability,
} from "@workspace/api-client-react";

const hooksConfig: AttributeHooksConfig = {
  useList: useListCatalogBrands as AttributeHooksConfig["useList"],
  getListQueryKey: getListCatalogBrandsQueryKey as AttributeHooksConfig["getListQueryKey"],
  useCreate: useCreateCatalogBrand as AttributeHooksConfig["useCreate"],
  useUpdate: useUpdateCatalogBrand as AttributeHooksConfig["useUpdate"],
  useDelete: useDeleteCatalogBrand as AttributeHooksConfig["useDelete"],
  useGetCityAvailability: useGetCatalogBrandCityAvailability as AttributeHooksConfig["useGetCityAvailability"],
  getCityAvailabilityQueryKey: getGetCatalogBrandCityAvailabilityQueryKey,
  useSetCityAvailability: useSetCatalogBrandCityAvailability as AttributeHooksConfig["useSetCityAvailability"],
  useBulkSetCityAvailability: useBulkSetCatalogBrandCityAvailability as AttributeHooksConfig["useBulkSetCityAvailability"],
};

export default function CatalogBrandsPage() {
  return (
    <AttributeListPage
      hooksConfig={hooksConfig}
      typeSingular="Brand"
      title="Brands"
      icon={<Sparkles size={18} />}
      permissionKey="catalog-brands-attr"
      attributeType="brand"
    />
  );
}
