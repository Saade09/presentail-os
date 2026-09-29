import { useEffect, useRef, useState } from "react";
import { useListSecuritySessions } from "@workspace/api-client-react";
import type { SecuritySession } from "@workspace/api-client-react";

const STORAGE_KEY = "presentail_known_session_labels";

export type NewSessionKind = "new_device" | "unexpected_country";

export interface NewSessionAlert {
  session: SecuritySession;
  kind: NewSessionKind;
}

interface KnownEntry {
  label: string;
  country: string | null;
}

function readKnownEntries(): KnownEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (parsed.length === 0) return [];
    if (typeof parsed[0] === "string") {
      return (parsed as string[]).map((label) => ({ label, country: null }));
    }
    return parsed as KnownEntry[];
  } catch {
    return [];
  }
}

function writeKnownEntries(entries: KnownEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage errors
  }
}

function sessionToEntry(s: SecuritySession): KnownEntry {
  return { label: s.deviceLabel, country: s.country ?? null };
}

export interface NewSessionAlertResult {
  newSessions: NewSessionAlert[];
  dismiss: () => void;
}

/**
 * Compares the current Clerk session list against a localStorage baseline of
 * known {deviceLabel, country} pairs. Returns sessions that are either:
 *   - "new_device": a previously-unseen device label, or
 *   - "unexpected_country": a known device label appearing from a different country.
 *
 * A known entry with country=null (migrated from old string-array format) will
 * never trigger an unexpected-country alert for that device label, preserving
 * backward-compatibility with existing stored data.
 *
 * The hook re-evaluates whenever the session list changes (e.g. via polling or
 * query invalidation) so that newly-appearing devices or locations are caught
 * even within the same JS runtime. `baselineRef` tracks the in-memory baseline;
 * dismiss() advances it so already-dismissed alerts don't reappear.
 *
 * Returns a `dismiss` function that advances the baseline to the current full
 * set, silencing the alert until the next new device or location appears.
 */
export function useNewSessionAlert(): NewSessionAlertResult {
  const { data, isSuccess } = useListSecuritySessions();
  const sessions = data?.sessions ?? [];

  const [newSessions, setNewSessions] = useState<NewSessionAlert[]>([]);

  // null = not yet initialised; KnownEntry[] = current in-memory baseline
  const baselineRef = useRef<KnownEntry[] | null>(null);

  // Stable string key: re-runs the effect only when label+country content
  // changes, not on every render due to new array references from the query hook.
  const sessionKey = sessions
    .map((s) => `${s.deviceLabel}\0${s.country ?? ""}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (!isSuccess) return;

    // First success: initialise the baseline from localStorage.
    if (baselineRef.current === null) {
      const known = readKnownEntries();

      if (known.length === 0) {
        // First-ever load — seed the baseline silently so we don't alert on
        // the very first sign-in from this browser (that would always fire).
        const entries = sessions.map(sessionToEntry);
        writeKnownEntries(entries);
        baselineRef.current = entries;
        return;
      }

      baselineRef.current = known;
    }

    // Re-evaluate against the current in-memory baseline on every label+country change.
    const known = baselineRef.current;
    const knownLabels = new Set(known.map((e) => e.label));
    const fullyKnownKey = (label: string, country: string | null) =>
      `${label}\0${country ?? ""}`;
    const fullyKnown = new Set(known.map((e) => fullyKnownKey(e.label, e.country)));
    const hasNullCountryForLabel = (label: string) =>
      known.some((e) => e.label === label && e.country === null);

    const alerts: NewSessionAlert[] = [];

    for (const s of sessions) {
      const key = fullyKnownKey(s.deviceLabel, s.country ?? null);
      if (fullyKnown.has(key)) continue;

      if (!knownLabels.has(s.deviceLabel)) {
        alerts.push({ session: s, kind: "new_device" });
      } else if (!hasNullCountryForLabel(s.deviceLabel)) {
        alerts.push({ session: s, kind: "unexpected_country" });
      }
    }

    setNewSessions(alerts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, sessionKey]);

  function dismiss() {
    setNewSessions([]);
    const entries = sessions.map(sessionToEntry);
    // Advance both the in-memory baseline and localStorage so re-opening the
    // app in a new tab doesn't re-show already-dismissed alerts.
    baselineRef.current = entries;
    writeKnownEntries(entries);
  }

  return { newSessions, dismiss };
}
