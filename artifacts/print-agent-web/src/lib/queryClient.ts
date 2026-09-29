import { QueryClient } from "@tanstack/react-query";
import { getRegisteredAuthToken } from "@workspace/api-client-react";

export type FailedRequestDetail = {
  status: number;
  url?: string;
  code?: string;
};
export type ApiRequestError = Error & { status?: number };
export type ApiFetchOptions = RequestInit & {
  /**
   * Optional request deadline for UI bootstrapping calls. Most mutations and
   * uploads intentionally have no client deadline, but a route gate must never
   * leave the whole application on a spinner forever.
   */
  timeoutMs?: number;
};
type Listener = (detail: FailedRequestDetail) => void;
const listeners401 = new Set<Listener>();
let pendingStaleSessionFailure: FailedRequestDetail | null = null;

export function isAccessRequestError(error: unknown): boolean {
  const status = (error as ApiRequestError | null)?.status;
  return status === 401 || status === 403;
}

export function on401(listener: Listener): () => void {
  listeners401.add(listener);
  if (pendingStaleSessionFailure) {
    const pending = pendingStaleSessionFailure;
    pendingStaleSessionFailure = null;
    listener(pending);
  }
  return () => listeners401.delete(listener);
}

function emit401(detail: FailedRequestDetail) {
  if (
    listeners401.size === 0 &&
    detail.code === "stale_clerk_session"
  ) {
    pendingStaleSessionFailure = detail;
    return;
  }
  listeners401.forEach((l) => l(detail));
}

function getApiUrl(input: RequestInfo | URL): URL | null {
  try {
    const rawUrl = input instanceof Request ? input.url : input.toString();
    return new URL(rawUrl, window.location.href);
  } catch {
    return null;
  }
}

/**
 * Observe every same-origin API response at the browser fetch boundary.
 *
 * The app uses apiFetch, Orval's customFetch, and a few direct fetch calls.
 * Query-cache error handling cannot see all of those paths, while the raw
 * response is the one place where stale_clerk_session is always available.
 */
export function observeApiAuthFailures(fetchImpl: typeof fetch): typeof fetch {
  const existing = fetchImpl as typeof fetch & {
    __presentailApiAuthObserver?: boolean;
  };
  if (existing.__presentailApiAuthObserver) return fetchImpl;

  const observedFetch = async (...args: Parameters<typeof fetch>) => {
    const response = await fetchImpl(...args);
    const url = getApiUrl(args[0]);

    if (
      response.status === 401 &&
      url?.origin === window.location.origin &&
      (url.pathname === "/api" || url.pathname.startsWith("/api/"))
    ) {
      let responseCopy: Response | null = null;
      try {
        responseCopy = response.clone();
      } catch {
        // Observing auth failures must never change the request's behavior.
      }

      void responseCopy
        ?.json()
        .then((body: unknown) => {
          const data =
            body && typeof body === "object"
              ? (body as Record<string, unknown>)
              : null;
          const nestedError =
            data?.error && typeof data.error === "object"
              ? (data.error as Record<string, unknown>)
              : null;
          const code =
            typeof data?.code === "string"
              ? data.code
              : typeof nestedError?.code === "string"
                ? nestedError.code
                : undefined;

          emit401({ status: 401, url: url.pathname, code });
        })
        .catch(() => {
          emit401({ status: 401, url: url.pathname });
        });
    }

    return response;
  };

  Object.defineProperty(observedFetch, "__presentailApiAuthObserver", {
    value: true,
  });
  return observedFetch as typeof fetch;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

type ClerkGlobal = {
  session?: { getToken(opts?: { skipCache?: boolean }): Promise<string | null> };
};

export async function getClerkToken(options?: { skipCache?: boolean }): Promise<string | null> {
  // Prefer the getter registered by ClerkTokenSync (useAuth().getToken).
  // This works even when window.Clerk.session is null, which can happen when
  // Clerk's global script initialises after the React tree has already
  // mounted. The __session cookie is scoped to clerk.presentail.com, so
  // cookies are never a reliable fallback for os.presentail.com requests.
  const registered = await getRegisteredAuthToken(options);
  if (registered) return registered;

  // Fallback: read directly from the window.Clerk global (covers cases where
  // the function is called before ClerkTokenSync has registered its getter).
  try {
    const clerk = (window as Window & { Clerk?: ClerkGlobal }).Clerk;
    return (await clerk?.session?.getToken(options)) ?? null;
  } catch {
    return null;
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const {
    headers: optionHeaders,
    signal: callerSignal,
    timeoutMs,
    ...restOptions
  } = options;
  const controller = timeoutMs ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const requestTimedOut = () => {
    const err = new Error(
      "The request took too long. Please reload the page and try again.",
    ) as Error & { code?: string; url?: string };
    err.code = "request_timeout";
    err.url = url;
    return err;
  };

  const timeoutPromise =
    timeoutMs && controller
      ? new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(requestTimedOut());
          }, timeoutMs);
        })
      : null;

  try {
    // A Clerk token can itself wait on the auth SDK. Race it against the same
    // deadline as the API request so protected routes cannot spin forever.
    const token = timeoutPromise
      ? await Promise.race([getClerkToken(), timeoutPromise])
      : await getClerkToken();
  const isFormData = options.body instanceof FormData;

    const performFetch = (authToken: string | null, forceAuthHeader = false) => fetch(url, {
      credentials: "include",
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(optionHeaders || {}),
        ...(forceAuthHeader && authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      ...restOptions,
      signal: controller?.signal ?? callerSignal,
    });

    let res = timeoutPromise
      ? await Promise.race([
          performFetch(token),
          timeoutPromise,
        ])
      : await performFetch(token);

    if (res.status === 401 && token) {
      const freshToken = timeoutPromise
        ? await Promise.race([getClerkToken({ skipCache: true }), timeoutPromise])
        : await getClerkToken({ skipCache: true });
      if (freshToken) {
        res = timeoutPromise
          ? await Promise.race([performFetch(freshToken, true), timeoutPromise])
          : await performFetch(freshToken, true);
      }
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      let code: string | undefined;
      let body: Record<string, unknown> | undefined;
      try {
        const data = await res.json() as Record<string, unknown>;
        body = data;
        if (typeof data.error === "string") msg = data.error;
        else if (typeof data.message === "string") msg = data.message;
        else if (data.error) msg = (data.error as Record<string, unknown>).message as string ?? msg;
        code = (data.code ?? (data.error as Record<string, unknown> | undefined)?.code) as string | undefined;
      } catch {}
      const err = new Error(msg) as Error & { status: number; code?: string; body?: Record<string, unknown>; url?: string };
      err.status = res.status;
      err.code = code;
      err.body = body;
      err.url = url;
      throw err;
    }
    return res.json() as Promise<T>;
  } catch (error) {
    // Fetch rejects with an implementation-specific AbortError. Expose the
    // actionable timeout message instead for dashboard route gates.
    if (timedOut) throw requestTimedOut();
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
