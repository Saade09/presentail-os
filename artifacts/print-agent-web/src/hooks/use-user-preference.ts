import { useRef, useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

type PrefsResponse = { ui_preferences: Record<string, unknown> };

/**
 * Syncs a single UI preference key with the server (PATCH /users/me/preferences).
 *
 * - `value`  — current value (starts at `defaultValue`, updated from server on first load)
 * - `set`    — optimistically update value and persist to server
 * - `loaded` — true once the server has responded with a value for this key
 *
 * All callers share the same React Query cache entry ("user-preferences") so a
 * single network request populates every preference at once.
 */
export function useUserPreference<T extends string | boolean>(
  key: string,
  defaultValue: T,
): { value: T; set: (v: T) => void; loaded: boolean } {
  const [value, setValue] = useState<T>(defaultValue);
  const [loaded, setLoaded] = useState(false);
  const serverSynced = useRef(false);

  const { data } = useQuery({
    queryKey: ["user-preferences"],
    queryFn: () => apiFetch<PrefsResponse>("/api/users/me/preferences"),
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (serverSynced.current) return;
    if (data?.ui_preferences?.[key] !== undefined) {
      serverSynced.current = true;
      setLoaded(true);
      setValue(data.ui_preferences[key] as T);
    } else if (data) {
      // Server responded but key is absent — treat default as confirmed.
      serverSynced.current = true;
      setLoaded(true);
    }
  }, [data, key]);

  const mutation = useMutation({
    mutationFn: (v: T) =>
      apiFetch<PrefsResponse>("/api/users/me/preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: v }),
      }),
  });

  function set(v: T) {
    serverSynced.current = true;
    setValue(v);
    mutation.mutate(v);
  }

  return { value, set, loaded };
}
