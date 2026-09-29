import { PartyPopper } from "lucide-react";
import { AttributeListPage } from "./AttributeListPage";
import type { AttributeHooksConfig } from "./attributeHooks";
import {
  useListOccasions,
  getListOccasionsQueryKey,
  useCreateOccasion,
  useUpdateOccasion,
  useDeleteOccasion,
  useGetOccasionCityAvailability,
  getGetOccasionCityAvailabilityQueryKey,
  useSetOccasionCityAvailability,
  useBulkSetOccasionCityAvailability,
} from "@workspace/api-client-react";

const hooksConfig: AttributeHooksConfig = {
  useList: useListOccasions as AttributeHooksConfig["useList"],
  getListQueryKey: getListOccasionsQueryKey as AttributeHooksConfig["getListQueryKey"],
  useCreate: useCreateOccasion as AttributeHooksConfig["useCreate"],
  useUpdate: useUpdateOccasion as AttributeHooksConfig["useUpdate"],
  useDelete: useDeleteOccasion as AttributeHooksConfig["useDelete"],
  useGetCityAvailability: useGetOccasionCityAvailability as AttributeHooksConfig["useGetCityAvailability"],
  getCityAvailabilityQueryKey: getGetOccasionCityAvailabilityQueryKey,
  useSetCityAvailability: useSetOccasionCityAvailability as AttributeHooksConfig["useSetCityAvailability"],
  useBulkSetCityAvailability: useBulkSetOccasionCityAvailability as AttributeHooksConfig["useBulkSetCityAvailability"],
};

export default function OccasionsPage() {
  return (
    <AttributeListPage
      hooksConfig={hooksConfig}
      typeSingular="Occasion"
      title="Occasions"
      icon={<PartyPopper size={18} />}
      permissionKey="catalog-occasions"
      attributeType="occasion"
      showFeaturedToggle
    />
  );
}
