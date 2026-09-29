import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";

function isTokenExpiringSoon(token: string): boolean {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return false;
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized)) as { exp?: unknown };
    return (
      typeof payload.exp === "number" &&
      payload.exp <= Date.now() / 1000 + 15
    );
  } catch {
    return false;
  }
}

const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000; // 2× server heartbeat interval (30 s)

/**
 * Map of SSE event name → handler. The handler receives the raw `data:` field
 * text (hooks are responsible for JSON-parsing it).
 */
export type SseEventHandlers = Record<string, (data: string) => void>;

export interface AuthedSseOptions {
  /**
   * Called after every successful (re)connection, with `isReconnect` false on
   * the first connect of the hook's lifetime and true afterwards. Use it to
   * trigger a catch-up refetch for events missed while disconnected (network
   * blip, laptop sleep, server restart).
   */
  onConnect?: (isReconnect: boolean) => void;
}

/**
 * Opens a token-authenticated Server-Sent Events connection using a `fetch()`
 * stream carrying an `Authorization: Bearer <Clerk token>` header, instead of
 * a native cookie-based `EventSource`. Cookie auth is not accepted in the
 * deployed environment, while Bearer tokens are — so this is the connection
 * method that works both in development and production (same pattern as
 * `useOmnichannelSSE`).
 *
 * Behavior:
 * - Fetches a fresh Clerk token before every (re)connection attempt, so
 *   short-lived token expiry never permanently kills the stream.
 * - Parses the SSE wire format manually and dispatches named events to the
 *   matching handler in `handlers`.
 * - Reconnects with exponential backoff (2 s → 30 s) after network errors,
 *   non-OK responses, or a server-closed stream; the backoff resets after a
 *   successful connection.
 * - A heartbeat watchdog aborts and reconnects if nothing (events or
 *   `: heartbeat` comments) arrives for {@link HEARTBEAT_TIMEOUT_MS}.
 * - Aborts the in-flight connection and cancels all timers on unmount or when
 *   `enabled` flips to false.
 *
 * `handlers` is kept in a ref, so passing a new object literal on each render
 * is fine and never causes a reconnect.
 */
export function useAuthedSse(
  url: string,
  enabled: boolean,
  handlers: SseEventHandlers,
  options?: AuthedSseOptions,
): void {
  const { getToken } = useAuth();
  // Keep getToken in a ref so the effect never needs it as a dependency —
  // Clerk may return a new function reference on every render, and listing it
  // would tear down the live connection on incidental re-renders.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Tracks whether a connection has ever succeeded so onConnect can
  // distinguish the initial connect from reconnects after a drop.
  const hasConnectedOnceRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let unmounted = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = MIN_DELAY_MS;
    let refreshTokenOnNextConnect = false;

    const clearHeartbeatTimer = () => {
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const scheduleRetry = () => {
      if (unmounted) return;
      const delay = retryDelay;
      retryDelay = Math.min(delay * 2, MAX_DELAY_MS);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!unmounted) void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (unmounted) return;

      let token: string | null = null;
      const forceFreshToken = refreshTokenOnNextConnect;
      try {
        token = await getTokenRef.current(
          forceFreshToken ? { skipCache: true } : undefined,
        );
      } catch {
        // token unavailable — retry after backoff
      }
      if (unmounted) return;
      if (!token) {
        scheduleRetry();
        return;
      }
      if (forceFreshToken) {
        refreshTokenOnNextConnect = false;
      } else if (isTokenExpiringSoon(token)) {
        // getToken() can return Clerk's cached JWT even when it is about to
        // expire. Bypass that cache before opening a long-lived stream.
        refreshTokenOnNextConnect = true;
        try {
          const freshToken = await getTokenRef.current({ skipCache: true });
          if (freshToken) {
            token = freshToken;
            refreshTokenOnNextConnect = false;
          }
        } catch {
          // Keep the refresh flag set and retry with backoff.
        }
        if (unmounted) return;
        if (refreshTokenOnNextConnect) {
          scheduleRetry();
          return;
        }
      }

      const currentController = new AbortController();
      controller = currentController;

      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: currentController.signal,
        });

        if (response.status === 401) {
          // Retry the handshake with a cache-bypassed token. Reusing Clerk's
          // cached token here can create a loop of identical expired-token
          // 401s after a sleeping tab resumes.
          refreshTokenOnNextConnect = true;
        }

        if (!response.ok || !response.body) {
          throw new Error(`SSE response ${response.status}`);
        }

        // Connected successfully — reset backoff
        retryDelay = MIN_DELAY_MS;

        const isReconnect = hasConnectedOnceRef.current;
        hasConnectedOnceRef.current = true;
        try {
          optionsRef.current?.onConnect?.(isReconnect);
        } catch {
          // A throwing onConnect must not kill the stream.
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventType = "";
        let eventData = "";

        // Reset the heartbeat watchdog on every received chunk so that both
        // real events and server ": heartbeat" comments keep the connection
        // considered alive. If nothing arrives within HEARTBEAT_TIMEOUT_MS
        // the controller is aborted → the read loop throws → reconnect.
        const resetHeartbeatTimer = () => {
          clearHeartbeatTimer();
          heartbeatTimer = setTimeout(() => {
            heartbeatTimer = null;
            currentController.abort();
          }, HEARTBEAT_TIMEOUT_MS);
        };
        resetHeartbeatTimer();

        while (!unmounted) {
          const { done, value } = await reader.read();
          if (done) break;

          resetHeartbeatTimer();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              eventData = line.slice(6).trim();
            } else if (line === "") {
              if (eventType) {
                const handler = handlersRef.current[eventType];
                if (handler) {
                  try {
                    handler(eventData);
                  } catch {
                    // A throwing handler must not kill the stream.
                  }
                }
              }
              eventType = "";
              eventData = "";
            }
          }
        }

        clearHeartbeatTimer();

        // Stream ended cleanly (server closed) — reconnect
        if (!unmounted) scheduleRetry();
      } catch {
        clearHeartbeatTimer();
        if (unmounted) return;
        // AbortError from the heartbeat watchdog or any network failure —
        // schedule a reconnect either way.
        scheduleRetry();
      }
    };

    void connect();

    return () => {
      unmounted = true;
      controller?.abort();
      controller = null;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      clearHeartbeatTimer();
    };
  }, [url, enabled]);
}
