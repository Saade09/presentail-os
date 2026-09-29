import { Users } from "lucide-react";
import { AttributeListPage } from "./AttributeListPage";
import type { AttributeHooksConfig } from "./attributeHooks";
import {
  useListRecipients,
  getListRecipientsQueryKey,
  useCreateRecipient,
  useUpdateRecipient,
  useDeleteRecipient,
  useGetRecipientCityAvailability,
  getGetRecipientCityAvailabilityQueryKey,
  useSetRecipientCityAvailability,
  useBulkSetRecipientCityAvailability,
} from "@workspace/api-client-react";

const hooksConfig: AttributeHooksConfig = {
  useList: useListRecipients as AttributeHooksConfig["useList"],
  getListQueryKey: getListRecipientsQueryKey as AttributeHooksConfig["getListQueryKey"],
  useCreate: useCreateRecipient as AttributeHooksConfig["useCreate"],
  useUpdate: useUpdateRecipient as AttributeHooksConfig["useUpdate"],
  useDelete: useDeleteRecipient as AttributeHooksConfig["useDelete"],
  useGetCityAvailability: useGetRecipientCityAvailability as AttributeHooksConfig["useGetCityAvailability"],
  getCityAvailabilityQueryKey: getGetRecipientCityAvailabilityQueryKey,
  useSetCityAvailability: useSetRecipientCityAvailability as AttributeHooksConfig["useSetCityAvailability"],
  useBulkSetCityAvailability: useBulkSetRecipientCityAvailability as AttributeHooksConfig["useBulkSetCityAvailability"],
};

export default function RecipientsPage() {
  return (
    <AttributeListPage
      hooksConfig={hooksConfig}
      typeSingular="Recipient"
      title="Recipients"
      icon={<Users size={18} />}
      permissionKey="catalog-recipients"
      attributeType="recipient"
    />
  );
}
