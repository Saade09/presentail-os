import { createContext, useContext, useState, ReactNode } from "react";

/**
 * A simulated ("View as role") selection.
 *
 * Only the role's identity (id + name) is stored. The role's permissions
 * (allowedPages) are deliberately NOT snapshotted here — they are resolved
 * live from the current roles data in useWorkspaceRole, so that editing a
 * role's permissions while simulating it immediately updates the simulated
 * view instead of showing a stale snapshot.
 */
export type SimulatedRole = {
  id: number;
  name: string;
};

type SimulatedRoleContextType = {
  simulatedRole: SimulatedRole | null;
  setSimulatedRole: (role: SimulatedRole | null) => void;
};

const SESSION_KEY = "simulatedRole";

function readFromSession(): SimulatedRole | null {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (
        parsed &&
        typeof parsed.id === "number" &&
        typeof parsed.name === "string"
      ) {
        // Older sessions may have persisted an allowedPages snapshot too;
        // it is intentionally dropped so permissions always resolve live.
        return { id: parsed.id, name: parsed.name };
      }
    }
  } catch {
  }
  return null;
}

const SimulatedRoleContext = createContext<SimulatedRoleContextType>({
  simulatedRole: null,
  setSimulatedRole: () => {},
});

export function SimulatedRoleProvider({ children }: { children: ReactNode }) {
  const [simulatedRole, setSimulatedRoleState] = useState<SimulatedRole | null>(readFromSession);

  function setSimulatedRole(role: SimulatedRole | null) {
    if (role === null) {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {
      }
    } else {
      try {
        sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ id: role.id, name: role.name }),
        );
      } catch {
      }
    }
    setSimulatedRoleState(role === null ? null : { id: role.id, name: role.name });
  }

  return (
    <SimulatedRoleContext.Provider value={{ simulatedRole, setSimulatedRole }}>
      {children}
    </SimulatedRoleContext.Provider>
  );
}

export function useSimulatedRole() {
  return useContext(SimulatedRoleContext);
}
