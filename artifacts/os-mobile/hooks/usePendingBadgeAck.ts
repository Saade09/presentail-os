import { createContext, useContext, useState, useCallback } from "react";

const PendingBadgeAckContext = createContext<{
  ackCount: number;
  ack: (count: number) => void;
}>({ ackCount: 0, ack: () => {} });

export const PendingBadgeAckProvider = PendingBadgeAckContext.Provider;

export function usePendingBadgeAck() {
  return useContext(PendingBadgeAckContext);
}

export function usePendingBadgeAckState() {
  const [ackCount, setAckCount] = useState(0);
  const ack = useCallback((count: number) => setAckCount(count), []);
  return { ackCount, ack };
}
