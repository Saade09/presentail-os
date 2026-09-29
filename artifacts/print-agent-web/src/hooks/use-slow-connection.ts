import { useEffect, useState } from "react";

type NetworkInfo = EventTarget & {
  effectiveType?: string;
  saveData?: boolean;
};

function checkSlowOrMetered(): boolean {
  const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  if (conn.effectiveType === "slow-2g" || conn.effectiveType === "2g") return true;
  return false;
}

export function useIsSlowConnection(): boolean {
  const [isSlow, setIsSlow] = useState(checkSlowOrMetered);

  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: NetworkInfo }).connection;
    if (!conn) return;

    function handleChange() {
      setIsSlow(checkSlowOrMetered());
    }

    conn.addEventListener("change", handleChange);
    return () => conn.removeEventListener("change", handleChange);
  }, []);

  return isSlow;
}
