import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type ChannelStatus = "disconnected" | "pending" | "connected" | "error";

type ChannelAccount = {
  id: number;
  name: string;
  provider: string;
  status: ChannelStatus;
  last_error: string | null;
};

export function useChannelErrorAlert(enabled: boolean) {
  const { toast } = useToast();
  const prevStatusesRef = useRef<Map<number, ChannelStatus>>(new Map());

  const query = useQuery<{ channels: ChannelAccount[] }>({
    queryKey: ["omnichannel-channels"],
    queryFn: () =>
      apiFetch("/api/omnichannel/channels") as Promise<{ channels: ChannelAccount[] }>,
    enabled,
    refetchInterval: 32_000,
    retry: false,
  });

  useEffect(() => {
    const channels = query.data?.channels;
    if (!channels) return;

    const prevStatuses = prevStatusesRef.current;

    for (const ch of channels) {
      const prev = prevStatuses.get(ch.id);
      if (prev !== undefined && prev !== "error" && ch.status === "error") {
        toast({
          title: `Channel error: ${ch.name}`,
          description: ch.last_error ?? "This channel has entered an error state.",
          variant: "destructive",
        });
      }
    }

    const newMap = new Map<number, ChannelStatus>();
    for (const ch of channels) {
      newMap.set(ch.id, ch.status);
    }
    prevStatusesRef.current = newMap;
  }, [query.data, toast]);

  const hasErrorChannels = (query.data?.channels ?? []).some((ch) => ch.status === "error");

  return { hasErrorChannels, query };
}
