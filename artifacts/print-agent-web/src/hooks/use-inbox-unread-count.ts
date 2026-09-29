import { useQuery } from "@tanstack/react-query";
import { getGetOmnichannelConversationsQueryOptions } from "@workspace/api-client-react";

export function useInboxUnreadCount(): number {
  const { data } = useQuery({
    ...getGetOmnichannelConversationsQueryOptions({ status: "open", limit: 100 }),
    staleTime: 30_000,
  });
  return (data?.conversations ?? []).reduce(
    (sum, c) => sum + (c.unread_count ?? 0),
    0,
  );
}
