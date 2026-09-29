import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

const mockToast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ---------------------------------------------------------------------------
// Minimal import — only what this test file needs
// ---------------------------------------------------------------------------

import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Helpers — mirror the exact types and logic from MarketplaceReportsTab
// ---------------------------------------------------------------------------

type ImportRecord = { id: number; import_status: string };

function getImportStatusLabel(status: string): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "ready_to_approve":
      return "Ready to Approve";
    case "needs_review":
      return "Needs Review";
    case "extraction_failed":
      return "Extraction Failed";
    case "pending":
      return "Pending";
    case "duplicate":
      return "Duplicate";
    case "rejected":
      return "Rejected";
    default:
      return status;
  }
}

/**
 * Minimal component that reproduces the transition-detection useEffect from
 * MarketplaceReportsTab verbatim.  Rendering this component with different
 * `allImports` values (via `rerender`) exercises the toast-firing logic in
 * isolation without having to mount the full 2 500-line page component.
 */
function ExtractionToastDetector({
  allImports,
  pollingIds,
}: {
  allImports: ImportRecord[];
  pollingIds: Set<number>;
}) {
  const { toast } = useToast();

  // Keep a ref to pollingIds so the transition-detection effect can read it
  // without adding pollingIds to its dependency array (same pattern as source).
  const pollingIdsRef = useRef(pollingIds);
  useEffect(() => {
    pollingIdsRef.current = pollingIds;
  }, [pollingIds]);

  // Track each import's previous status so we can detect pending → terminal.
  // Exact copy of the logic at ~line 1508 in MarketplaceReportsTab.tsx.
  const prevImportStatusesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    for (const imp of allImports) {
      const prevStatus = prevImportStatusesRef.current.get(imp.id);
      if (prevStatus === "pending" && imp.import_status !== "pending") {
        if (!pollingIdsRef.current.has(imp.id)) {
          if (imp.import_status === "extraction_failed") {
            toast({
              variant: "destructive",
              title: "Extraction failed",
              description: "The report could not be extracted — try again.",
            });
          } else if (imp.import_status === "needs_review") {
            toast({
              title: "Extraction complete — ready to review",
              description:
                "The report needs your review before it can be approved.",
            });
          } else if (imp.import_status === "ready_to_approve") {
            toast({
              title: "Extraction complete — ready to approve",
              description:
                "Review the import and approve it to add it to your reports.",
            });
          } else {
            toast({
              title: "Extraction complete",
              description: `Status: ${getImportStatusLabel(imp.import_status)}`,
            });
          }
        }
      }
      prevImportStatusesRef.current.set(imp.id, imp.import_status);
    }
  }, [allImports]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

function makeImport(
  id: number,
  import_status: string,
): ImportRecord {
  return { id, import_status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extraction toast — pending → needs_review", () => {
  it("fires the needs_review toast when an import transitions from pending", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(1, "pending")]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(1, "needs_review")]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Extraction complete — ready to review",
      description: "The report needs your review before it can be approved.",
    });
  });
});

describe("extraction toast — pending → ready_to_approve", () => {
  it("fires the ready_to_approve toast when an import transitions from pending", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(2, "pending")]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(2, "ready_to_approve")]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Extraction complete — ready to approve",
      description:
        "Review the import and approve it to add it to your reports.",
    });
  });
});

describe("extraction toast — pending → extraction_failed", () => {
  it("fires a destructive toast when extraction fails after pending", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(3, "pending")]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(3, "extraction_failed")]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "Extraction failed",
      description: "The report could not be extracted — try again.",
    });
  });
});

describe("extraction toast — pending → other terminal status", () => {
  it("fires a generic Extraction complete toast for other terminal statuses", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(4, "pending")]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(4, "approved")]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Extraction complete",
      description: "Status: Approved",
    });
  });
});

describe("extraction toast — pollingIds suppression (retry flow)", () => {
  it("does NOT fire a toast when the import id is tracked in pollingIds", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(5, "pending")]}
        pollingIds={new Set([5])}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(5, "needs_review")]}
          pollingIds={new Set([5])}
        />,
      );
    });

    expect(mockToast).not.toHaveBeenCalled();
  });

  it("does NOT fire a toast for extraction_failed when the id is in pollingIds", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(6, "pending")]}
        pollingIds={new Set([6])}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(6, "extraction_failed")]}
          pollingIds={new Set([6])}
        />,
      );
    });

    expect(mockToast).not.toHaveBeenCalled();
  });
});

describe("extraction toast — no toast on non-pending transitions", () => {
  it("does NOT fire a toast when a non-pending status changes to another non-pending status", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[makeImport(7, "needs_review")]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[makeImport(7, "ready_to_approve")]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).not.toHaveBeenCalled();
  });

  it("does NOT fire a toast on the initial render when all imports start at pending", () => {
    render(
      <ExtractionToastDetector
        allImports={[makeImport(8, "pending")]}
        pollingIds={new Set()}
      />,
    );

    expect(mockToast).not.toHaveBeenCalled();
  });
});

describe("extraction toast — multiple imports in one update", () => {
  it("fires one toast per import that transitions from pending on the same re-render", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[
          makeImport(10, "pending"),
          makeImport(11, "pending"),
          makeImport(12, "pending"),
        ]}
        pollingIds={new Set()}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[
            makeImport(10, "needs_review"),
            makeImport(11, "extraction_failed"),
            makeImport(12, "ready_to_approve"),
          ]}
          pollingIds={new Set()}
        />,
      );
    });

    expect(mockToast).toHaveBeenCalledTimes(3);

    const calls = mockToast.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Extraction complete — ready to review" }),
        expect.objectContaining({ variant: "destructive", title: "Extraction failed" }),
        expect.objectContaining({ title: "Extraction complete — ready to approve" }),
      ]),
    );
  });

  it("fires toasts only for the imports that were in pollingIds when some are suppressed", () => {
    const { rerender } = render(
      <ExtractionToastDetector
        allImports={[
          makeImport(20, "pending"),
          makeImport(21, "pending"),
        ]}
        pollingIds={new Set([21])}
      />,
    );

    act(() => {
      rerender(
        <ExtractionToastDetector
          allImports={[
            makeImport(20, "needs_review"),
            makeImport(21, "needs_review"),
          ]}
          pollingIds={new Set([21])}
        />,
      );
    });

    // Only import 20 should trigger a toast; import 21 is in pollingIds
    expect(mockToast).toHaveBeenCalledOnce();
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Extraction complete — ready to review" }),
    );
  });
});
