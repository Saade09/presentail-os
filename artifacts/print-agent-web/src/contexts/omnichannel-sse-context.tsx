import { createContext, useContext } from "react";

interface OmnichannelSSEState {
  reconnecting: boolean;
  backOnline: boolean;
}

export const OmnichannelSSEContext = createContext<OmnichannelSSEState>({
  reconnecting: false,
  backOnline: false,
});

export function useOmnichannelSSEState(): OmnichannelSSEState {
  return useContext(OmnichannelSSEContext);
}
