import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import type { ReturnReason, CollectionMethod } from "@/hooks/useCmcReturns";

// ── Draft types ────────────────────────────────────────────────────────────────

export interface DraftLineItem {
  /** Unique ID within the draft (not the product ID) */
  draftId: string;
  product_id: number | null;
  /** Maps to API field name_snapshot */
  name_snapshot: string;
  /** Maps to API field sku_snapshot */
  sku_snapshot: string | null;
  /** Maps to API field image_url */
  image_url: string | null;
  quantity: number;
  reason: ReturnReason;
  available_stock: number;
  is_custom: boolean;
}

export interface DraftDetails {
  notes: string;
  collection_method: CollectionMethod;
  collection_date: string;
  photo_urls: string[];
  /** ID of the florist branch location (from active shift or user selection) */
  branch_location_id: number | null;
  /** ID of the CMC receiving / return-to location */
  return_to_location_id: number | null;
}

export interface ReturnsDraft {
  lines: DraftLineItem[];
  details: DraftDetails;
  currentStep: 0 | 1 | 2;
}

function emptyDraft(): ReturnsDraft {
  return {
    lines: [],
    details: {
      notes: "",
      collection_method: "next_delivery",
      collection_date: "",
      photo_urls: [],
      branch_location_id: null,
      return_to_location_id: null,
    },
    currentStep: 0,
  };
}

// ── Context ────────────────────────────────────────────────────────────────────

interface ReturnsContextValue {
  draft: ReturnsDraft;
  isDirty: boolean;
  addLine: (line: Omit<DraftLineItem, "draftId">) => void;
  updateLine: (draftId: string, update: Partial<DraftLineItem>) => void;
  removeLine: (draftId: string) => void;
  updateDetails: (update: Partial<DraftDetails>) => void;
  setStep: (step: 0 | 1 | 2) => void;
  reset: () => void;
}

let _nextId = 1;
function nextDraftId() {
  return `draft-${_nextId++}`;
}

const ReturnsContext = createContext<ReturnsContextValue | null>(null);

export function CmcPosReturnsProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<ReturnsDraft>(emptyDraft);

  const isDirty =
    draft.lines.length > 0 ||
    draft.details.notes !== "" ||
    draft.details.photo_urls.length > 0;

  const addLine = useCallback((line: Omit<DraftLineItem, "draftId">) => {
    setDraft((d) => ({
      ...d,
      lines: [...d.lines, { ...line, draftId: nextDraftId() }],
    }));
  }, []);

  const updateLine = useCallback(
    (draftId: string, update: Partial<DraftLineItem>) => {
      setDraft((d) => ({
        ...d,
        lines: d.lines.map((l) =>
          l.draftId === draftId ? { ...l, ...update } : l,
        ),
      }));
    },
    [],
  );

  const removeLine = useCallback((draftId: string) => {
    setDraft((d) => ({
      ...d,
      lines: d.lines.filter((l) => l.draftId !== draftId),
    }));
  }, []);

  const updateDetails = useCallback((update: Partial<DraftDetails>) => {
    setDraft((d) => ({ ...d, details: { ...d.details, ...update } }));
  }, []);

  const setStep = useCallback((step: 0 | 1 | 2) => {
    setDraft((d) => ({ ...d, currentStep: step }));
  }, []);

  const reset = useCallback(() => {
    setDraft(emptyDraft());
  }, []);

  return (
    <ReturnsContext.Provider
      value={{
        draft,
        isDirty,
        addLine,
        updateLine,
        removeLine,
        updateDetails,
        setStep,
        reset,
      }}
    >
      {children}
    </ReturnsContext.Provider>
  );
}

export function useReturnsContext() {
  const ctx = useContext(ReturnsContext);
  if (!ctx)
    throw new Error("useReturnsContext must be used inside CmcPosReturnsProvider");
  return ctx;
}
