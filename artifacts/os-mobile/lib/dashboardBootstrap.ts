export const DASHBOARD_BOOTSTRAP_TIMEOUT_MS = 12_000;

export async function requestDashboardBootstrap({
  apiBase,
  token,
  onInvalidSession,
  timeoutMs = DASHBOARD_BOOTSTRAP_TIMEOUT_MS,
  fetchImpl = fetch,
  signal,
}: {
  apiBase: string;
  token: string;
  onInvalidSession: () => Promise<void>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) controller.abort();
  let deadlineExpired = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let result: {
    res: Response;
    data: { bootstrapUrl?: string; error?: string };
  };
  try {
    const operation = (async () => {
      const res = await fetchImpl(`${apiBase}/api/mobile/auth/web-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      let data: { bootstrapUrl?: string; error?: string };
      try {
        data = await res.json() as { bootstrapUrl?: string; error?: string };
      } catch (error) {
        if (controller.signal.aborted) throw error;
        data = {};
      }
      return { res, data };
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
        reject(new Error("Dashboard bootstrap deadline exceeded"));
      }, timeoutMs);
    });
    result = await Promise.race([operation, deadline]);
  } catch {
    if (signal?.aborted) {
      throw new Error("The dashboard request was cancelled.");
    }
    if (deadlineExpired) {
      throw new Error("The dashboard request timed out. Check your connection and try again.");
    }
    throw new Error("Unable to reach the dashboard. Check your connection and try again.");
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }

  if (signal?.aborted) {
    throw new Error("The dashboard request was cancelled.");
  }
  const { res, data } = result;
  if (res.status === 401 && res.headers.get("x-mobile-auth") === "invalid") {
    await onInvalidSession();
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!res.ok || !data.bootstrapUrl) {
    throw new Error(data.error ?? "Unable to open the dashboard right now");
  }
  return data.bootstrapUrl;
}