import { useEffect, useState } from "react";

function getVisibility(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function useDocumentVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(getVisibility);

  useEffect(() => {
    function handleChange() {
      setIsVisible(getVisibility());
    }
    document.addEventListener("visibilitychange", handleChange);
    return () => document.removeEventListener("visibilitychange", handleChange);
  }, []);

  return isVisible;
}
