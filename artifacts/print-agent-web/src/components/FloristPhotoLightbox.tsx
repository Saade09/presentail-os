import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LightboxImage {
  src: string;
  category: string;
  alt: string;
}

interface FloristPhotoLightboxProps {
  images: LightboxImage[];
  initialIndex: number;
  orderLabel: string;
  /** Raw order number used as filename prefix, e.g. "LB-2345" */
  orderSlug: string;
  onClose: () => void;
  /** Ref to the element that triggered the lightbox; focus returns here on close */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.5;
const SWIPE_THRESHOLD = 50;

async function downloadImage(src: string, filename: string) {
  const resp = await fetch(src);
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildFilename(orderSlug: string, category: string, index: number): string {
  // category is e.g. "Prepared order items" or "Card message"
  const slug = category.toLowerCase().includes("card")
    ? "card-message"
    : "prepared-order";
  const safe = orderSlug.replace(/[^a-z0-9_\-]/gi, "-").toLowerCase();
  return `${safe}-${slug}-${index + 1}.jpg`;
}

export function FloristPhotoLightbox({
  images,
  initialIndex,
  orderLabel,
  orderSlug,
  onClose,
  triggerRef,
}: FloristPhotoLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [isPanning, setIsPanning] = useState(false);

  // Mouse-down position to guard backdrop click vs drag
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const touchStartX = useRef<number | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const current = images[currentIndex];
  const hasMultiple = images.length > 1;

  // Return focus to trigger on close
  const handleClose = useCallback(() => {
    onClose();
    triggerRef?.current?.focus();
  }, [onClose, triggerRef]);

  const goNext = useCallback(() => {
    setZoom(MIN_ZOOM);
    setCurrentIndex((i) => (i + 1) % images.length);
  }, [images.length]);

  const goPrev = useCallback(() => {
    setZoom(MIN_ZOOM);
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
  }, [images.length]);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
      if (e.key === "ArrowRight" && hasMultiple) goNext();
      if (e.key === "ArrowLeft" && hasMultiple) goPrev();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose, goNext, goPrev, hasMultiple]);

  // Focus trap
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    function onTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    modal.addEventListener("keydown", onTab);
    // Focus the close button initially
    closeButtonRef.current?.focus();
    return () => modal.removeEventListener("keydown", onTab);
  }, []);

  // Backdrop click — only close if no significant drag occurred
  function onBackdropMouseDown(e: React.MouseEvent) {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  }

  function onBackdropMouseUp(e: React.MouseEvent) {
    if (!mouseDownPos.current) return;
    const dx = Math.abs(e.clientX - mouseDownPos.current.x);
    const dy = Math.abs(e.clientY - mouseDownPos.current.y);
    mouseDownPos.current = null;
    if (dx < 5 && dy < 5) handleClose();
  }

  // Touch swipe
  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (!hasMultiple) return;
    if (delta > SWIPE_THRESHOLD) goPrev();
    else if (delta < -SWIPE_THRESHOLD) goNext();
  }

  const zoomPct = Math.round(zoom * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      aria-modal="true"
      role="dialog"
      aria-label={`${current.category} — ${orderLabel}`}
      onMouseDown={onBackdropMouseDown}
      onMouseUp={onBackdropMouseUp}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Modal panel — stop propagation so clicks inside don't close */}
      <div
        ref={modalRef}
        className={cn(
          "relative flex flex-col bg-white rounded-xl shadow-2xl",
          "w-full max-w-3xl mx-2",
          "sm:mx-4",
          // Near-full-screen on very small viewports
          "max-h-[95dvh] sm:max-h-[92dvh]",
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{current.category}</p>
            <p className="text-xs text-muted-foreground">{orderLabel}</p>
          </div>
          <button
            type="button"
            onClick={() =>
              downloadImage(current.src, buildFilename(orderSlug, current.category, currentIndex))
            }
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium border border-border hover:bg-accent transition-colors"
            title="Download"
          >
            <Download size={13} />
            Download
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Image area */}
        <div
          className={cn(
            "relative flex-1 overflow-auto bg-neutral-50 flex items-center justify-center min-h-0",
            zoom > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-default",
          )}
          onMouseDown={(e) => {
            if (zoom > 1) setIsPanning(true);
            e.stopPropagation();
          }}
          onMouseUp={(e) => {
            setIsPanning(false);
            e.stopPropagation();
          }}
          onMouseLeave={() => setIsPanning(false)}
        >
          <img
            key={current.src}
            src={current.src}
            alt={current.alt}
            draggable={false}
            className="select-none transition-transform duration-150"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "center center",
              maxHeight: zoom === 1 ? "calc(95dvh - 160px)" : undefined,
              maxWidth: zoom === 1 ? "100%" : undefined,
              objectFit: "contain",
            }}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          {/* Navigation */}
          {hasMultiple ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={goPrev}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Previous image"
              >
                <ChevronLeft size={18} />
              </button>
              <span className="text-xs text-muted-foreground tabular-nums w-10 text-center">
                {currentIndex + 1} of {images.length}
              </span>
              <button
                type="button"
                onClick={goNext}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Next image"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          ) : (
            <div className="flex-1" />
          )}

          <div className="flex-1" />

          {/* Zoom controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)))}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Zoom out"
            >
              <ZoomOut size={15} />
            </button>
            <span className="text-xs text-muted-foreground tabular-nums w-12 text-center">
              {zoomPct}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Zoom in"
            >
              <ZoomIn size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Standalone helper — download an image by URL without opening the lightbox */
export { downloadImage };
