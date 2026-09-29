import { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { RotateCcw, History, ChevronRight } from "lucide-react";
import { CmcPosReturnsProvider, useReturnsContext } from "./CmcPosReturnsContext";
import CmcPosReturnsStep1 from "./CmcPosReturnsStep1";
import CmcPosReturnsStep2 from "./CmcPosReturnsStep2";
import CmcPosReturnsStep3 from "./CmcPosReturnsStep3";
import CmcPosReturnsSuccess from "./CmcPosReturnsSuccess";
import type { CmcReturn } from "@/hooks/useCmcReturns";
import { useState } from "react";

// ── Step indicator ─────────────────────────────────────────────────────────────

const STEPS = [
  { label: "Select products", index: 0 },
  { label: "Return details", index: 1 },
  { label: "Review & submit", index: 2 },
];

function StepBar({ current }: { current: number }) {
  return (
    <nav aria-label="Return wizard steps" className="flex items-center gap-0">
      {STEPS.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={s.index} className="flex items-center">
            <div
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-teal-700 text-white"
                  : done
                  ? "bg-teal-100 text-teal-700"
                  : "bg-muted text-muted-foreground"
              }`}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                  active
                    ? "bg-white/20"
                    : done
                    ? "bg-teal-600/20"
                    : "bg-muted-foreground/10"
                }`}
              >
                {i + 1}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mx-1" />
            )}
          </div>
        );
      })}
    </nav>
  );
}

// ── Inner wizard (uses context) ────────────────────────────────────────────────

function ReturnsWizard() {
  const { draft, isDirty, reset } = useReturnsContext();
  const [submittedReturn, setSubmittedReturn] = useState<CmcReturn | null>(null);
  const [, navigate] = useLocation();
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  // Focus step heading when step changes
  useEffect(() => {
    const el = document.getElementById(`step${draft.currentStep}-heading`) as HTMLHeadingElement | null;
    if (el) el.focus();
  }, [draft.currentStep]);

  // Warn on navigate-away if dirty
  useEffect(() => {
    if (!isDirty || submittedReturn) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty, submittedReturn]);

  const handleSuccess = (ret: CmcReturn) => {
    setSubmittedReturn(ret);
    reset();
  };

  const handleCreateAnother = () => {
    setSubmittedReturn(null);
    reset();
  };

  if (submittedReturn) {
    return (
      <div className="flex flex-col min-h-full">
        <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Return submitted</h1>
          </div>
          <Link
            href="/cmc-pos/returns/history"
            className="text-sm text-teal-700 hover:underline flex items-center gap-1"
          >
            <History className="h-4 w-4" />
            View history
          </Link>
        </div>
        <div className="flex-1 overflow-auto px-6 pb-8 max-w-2xl">
          <CmcPosReturnsSuccess
            ret={submittedReturn}
            onCreateAnother={handleCreateAnother}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 border-b">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-teal-700" />
            New CMC Return
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Report poor-condition CMC stock and arrange collection
          </p>
        </div>
        <Link
          href="/cmc-pos/returns/history"
          className="text-sm text-muted-foreground hover:text-teal-700 flex items-center gap-1 shrink-0"
        >
          <History className="h-4 w-4" />
          View history
        </Link>
      </div>

      {/* Step bar */}
      <div className="px-6 py-3 border-b bg-muted/20">
        <StepBar current={draft.currentStep} />
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-auto px-6 py-6 max-w-2xl w-full">
        {draft.currentStep === 0 && <CmcPosReturnsStep1 />}
        {draft.currentStep === 1 && <CmcPosReturnsStep2 />}
        {draft.currentStep === 2 && (
          <CmcPosReturnsStep3 onSuccess={handleSuccess} />
        )}
      </div>
    </div>
  );
}

// ── Page export ────────────────────────────────────────────────────────────────

export default function CmcPosReturns() {
  return (
    <CmcPosReturnsProvider>
      <ReturnsWizard />
    </CmcPosReturnsProvider>
  );
}
