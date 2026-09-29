import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";

interface SseEvent {
  type: "conversation_updated";
  conversation_id: number;
  workspace_owner_id: string;
}

const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 30_000;
const BACK_ONLINE_DURATION_MS = 3_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000; // 2× server heartbeat interval (30 s)

export function useOmnichannelSSE() {
  const { getToken } = useAuth();
  // Keep getToken in a ref so the `connect` useCallback never needs to list it
  // as a dependency.  Clerk may return a new function reference on every render
  // (e.g. when its internal state rebuilds); adding it to the dependency array
  // would cause connect to recreate, which triggers the useEffect cleanup and
  // tears down the live SSE connection on every incidental re-render.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const qc = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const retryDelayRef = useRef(MIN_DELAY_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backOnlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const hasDisconnectedRef = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [backOnline, setBackOnline] = useState(false);

  const scheduleRetry = useCallback((connect: () => void) => {
    if (unmountedRef.current) return;
    hasDisconnectedRef.current = true;
    setReconnecting(true);
    setBackOnline(false);
    if (backOnlineTimerRef.current !== null) {
      clearTimeout(backOnlineTimerRef.current);
      backOnlineTimerRef.current = null;
    }
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(delay * 2, MAX_DELAY_MS);
    retryTimerRef.current = setTimeout(() => {
      if (!unmountedRef.current) connect();
    }, delay);
  }, []);

  const connect = useCallback(async () => {
    if (unmountedRef.current) return;

    let token: string | null = null;
    try {
      token = await getTokenRef.current();
    } catch {
      // token unavailable — retry after backoff
    }

    if (!token) {
      scheduleRetry(() => connect());
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const response = await fetch("/api/omnichannel/events", {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE response ${response.status}`);
      }

      // Connected successfully — reset backoff
      retryDelayRef.current = MIN_DELAY_MS;
      if (hasDisconnectedRef.current) {
        setReconnecting(false);
        setBackOnline(true);
        if (backOnlineTimerRef.current !== null) clearTimeout(backOnlineTimerRef.current);
        backOnlineTimerRef.current = setTimeout(() => {
          if (!unmountedRef.current) setBackOnline(false);
        }, BACK_ONLINE_DURATION_MS);
      } else {
        setReconnecting(false);
      }

      // Parse the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      let eventData = "";

      /**
       * Reset the heartbeat watchdog.  Called on every received chunk so that
       * both real events and server-sent ": heartbeat" comment lines keep the
       * connection considered alive.  If no data arrives within
       * HEARTBEAT_TIMEOUT_MS the current controller is aborted which causes the
       * read loop to throw an AbortError → the catch block schedules a reconnect.
       */
      const resetHeartbeatTimer = () => {
        if (heartbeatTimerRef.current !== null) clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setTimeout(() => {
          heartbeatTimerRef.current = null;
          controller.abort();
        }, HEARTBEAT_TIMEOUT_MS);
      };

      // Start the watchdog immediately after the connection opens
      resetHeartbeatTimer();

      while (!unmountedRef.current) {
        const { done, value } = await reader.read();
        if (done) break;

        // Any received chunk (event or heartbeat comment) resets the watchdog
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
            if (eventType === "conversation_updated" && eventData) {
              try {
                const data = JSON.parse(eventData) as SseEvent;
                qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
                qc.invalidateQueries({
                  queryKey: [`/api/omnichannel/conversations/${data.conversation_id}`],
                });
              } catch {
                qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
              }
            }
            eventType = "";
            eventData = "";
          }
        }
      }

      // Clear heartbeat watchdog when the loop exits
      if (heartbeatTimerRef.current !== null) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }

      // Stream ended cleanly (server closed) — reconnect
      if (!unmountedRef.current) {
        scheduleRetry(() => connect());
      }
    } catch (err) {
      // Clear heartbeat watchdog on any error exit
      if (heartbeatTimerRef.current !== null) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }

      if (unmountedRef.current) return;
      // AbortError caused by the heartbeat watchdog (not by unmount) or any
      // other network failure — schedule a reconnect either way.
      scheduleRetry(() => connect());
    }
  }, [qc, scheduleRetry]);

  useEffect(() => {
    unmountedRef.current = false;
    hasDisconnectedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (backOnlineTimerRef.current !== null) {
        clearTimeout(backOnlineTimerRef.current);
        backOnlineTimerRef.current = null;
      }
      if (heartbeatTimerRef.current !== null) {
        clearTimeout(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };
  }, [connect]);

  return { reconnecting, backOnline };
}
