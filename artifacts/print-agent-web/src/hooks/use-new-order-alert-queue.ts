import { useCallback, useEffect, useRef, useState } from "react";

export type NewOrderAlert = {
  orderId: string;
  displayOrderNumber: string | null;
  customerName: string | null;
  total: number | null;
  currency: string | null;
  receivedAt: string;
};

const QUEUE_KEY = "new_order_alert_queue";
const SOUND_KEY = "new_order_sound_muted";
const MAX_QUEUE = 50;
const RING_INTERVAL_MS = 6000;

function loadQueue(): NewOrderAlert[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is NewOrderAlert =>
        typeof a === "object" && a !== null && typeof (a as NewOrderAlert).orderId === "string",
    );
  } catch {
    return [];
  }
}

function saveQueue(queue: NewOrderAlert[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE)));
  } catch {
    /* storage unavailable */
  }
}

export function loadSoundMuted(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Plays the opening five notes of Black Sabbath's "Iron Man" (B–D–D–E–E) as
 * distorted-sounding power chords (root + fifth + octave, square waves) via
 * the Web Audio API. Returns false when the browser blocked audio (autoplay
 * policy without a prior user gesture).
 */
function playLoudRing(): boolean {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      void ctx.close().catch(() => {});
      return false;
    }
    const now = ctx.currentTime;
    // Iron Man opening riff: B2 (long), D3 (long), D3–E3 (quick pair), E3 (held).
    const B2 = 123.47;
    const D3 = 146.83;
    const E3 = 164.81;
    const riff: { freq: number; start: number; dur: number }[] = [
      { freq: B2, start: 0, dur: 0.5 },
      { freq: D3, start: 0.55, dur: 0.5 },
      { freq: D3, start: 1.1, dur: 0.2 },
      { freq: E3, start: 1.35, dur: 0.2 },
      { freq: E3, start: 1.6, dur: 0.6 },
    ];
    for (const { freq, start, dur } of riff) {
      // Power chord: root + perfect fifth + octave.
      for (const [i, f] of [freq, freq * 1.5, freq * 2].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = f;
        const level = i === 0 ? 0.16 : i === 1 ? 0.1 : 0.06;
        const t0 = now + start;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(level, t0 + 0.015);
        gain.gain.setValueAtTime(level, t0 + Math.max(0.015, dur - 0.08));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      }
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 2600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persistent queue of unacknowledged new-order alerts.
 *
 * - Survives page refresh via localStorage.
 * - While non-empty and sound is not muted, repeats a loud ringtone every few
 *   seconds until every order is acknowledged (dismissed or opened).
 * - Exposes `soundBlocked` when the browser autoplay policy prevented audio;
 *   any pointer/keyboard interaction unblocks it automatically.
 */
export function useNewOrderAlertQueue() {
  const [alerts, setAlerts] = useState<NewOrderAlert[]>(() => loadQueue());
  const [muted, setMutedState] = useState<boolean>(() => loadSoundMuted());
  const [soundBlocked, setSoundBlocked] = useState(false);
  const alertsRef = useRef(alerts);
  const mutedRef = useRef(muted);
  alertsRef.current = alerts;
  mutedRef.current = muted;

  const addAlert = useCallback(
    (payload: Omit<NewOrderAlert, "receivedAt">) => {
      setAlerts((prev) => {
        if (prev.some((a) => a.orderId === payload.orderId)) return prev;
        const next = [{ ...payload, receivedAt: new Date().toISOString() }, ...prev].slice(
          0,
          MAX_QUEUE,
        );
        saveQueue(next);
        return next;
      });
    },
    [],
  );

  const acknowledge = useCallback((orderId: string) => {
    setAlerts((prev) => {
      const next = prev.filter((a) => a.orderId !== orderId);
      saveQueue(next);
      return next;
    });
  }, []);

  const acknowledgeAll = useCallback(() => {
    setAlerts(() => {
      saveQueue([]);
      return [];
    });
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Repeating ringtone while there are unacknowledged alerts.
  useEffect(() => {
    if (alerts.length === 0 || muted) {
      setSoundBlocked(false);
      return;
    }
    const ring = () => {
      if (alertsRef.current.length === 0 || mutedRef.current) return;
      const ok = playLoudRing();
      setSoundBlocked(!ok);
    };
    ring();
    const interval = window.setInterval(ring, RING_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [alerts.length > 0, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  // When audio is blocked, the first user gesture unblocks it.
  useEffect(() => {
    if (!soundBlocked) return;
    const unblock = () => {
      if (alertsRef.current.length > 0 && !mutedRef.current) {
        const ok = playLoudRing();
        setSoundBlocked(!ok);
      } else {
        setSoundBlocked(false);
      }
    };
    window.addEventListener("pointerdown", unblock, { once: true });
    window.addEventListener("keydown", unblock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unblock);
      window.removeEventListener("keydown", unblock);
    };
  }, [soundBlocked]);

  return { alerts, addAlert, acknowledge, acknowledgeAll, muted, setMuted, soundBlocked };
}
