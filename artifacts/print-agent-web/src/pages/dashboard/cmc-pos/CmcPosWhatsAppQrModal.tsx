import { useState, useEffect } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/** WhatsApp brand green */
const WA_GREEN = "#25D366";

/** WhatsApp SVG icon (official logo shape) */
function WhatsAppIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M16 2C8.268 2 2 8.268 2 16c0 2.478.672 4.8 1.846 6.794L2 30l7.394-1.826A13.937 13.937 0 0 0 16 30c7.732 0 14-6.268 14-14S23.732 2 16 2Z"
        fill={WA_GREEN}
      />
      <path
        d="M22.08 19.04c-.318-.16-1.88-.928-2.172-1.034-.292-.106-.504-.16-.716.16-.212.318-.822 1.034-.99 1.24-.178.212-.35.24-.666.08-.318-.16-1.34-.494-2.552-1.574-.944-.842-1.58-1.882-1.764-2.2-.186-.318-.02-.49.14-.648.142-.14.318-.37.478-.554.16-.184.212-.318.318-.528.106-.212.054-.398-.026-.558-.08-.16-.716-1.726-.98-2.364-.258-.622-.52-.538-.716-.548-.186-.008-.398-.01-.61-.01-.212 0-.558.08-.85.398-.292.318-1.11 1.086-1.11 2.648 0 1.562 1.136 3.072 1.296 3.284.158.212 2.236 3.41 5.418 4.784.756.326 1.346.52 1.806.666.758.24 1.448.206 1.994.126.608-.09 1.88-.768 2.146-1.51.266-.742.266-1.38.186-1.512-.08-.132-.292-.212-.61-.37Z"
        fill="white"
      />
    </svg>
  );
}

/** Full-screen overlay shown when "Display Full Screen" is clicked.
 *  Rendered outside any Dialog so it has full pointer events and focus. */
function CmcPosWhatsAppQrFullScreen({ onExit }: { onExit: () => void }) {
  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onExit();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [onExit]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="WhatsApp QR code full screen"
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center"
      style={{ background: "#fff" }}
    >
      {/* Exit button */}
      <button
        type="button"
        onClick={onExit}
        aria-label="Exit full screen"
        className="absolute top-4 right-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{ outlineColor: WA_GREEN }}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      >
        <Minimize2 className="h-4 w-4" />
        Exit Full Screen
      </button>

      {/* WhatsApp branding header */}
      <div className="mb-6 flex flex-col items-center gap-2">
        <WhatsAppIcon size={48} />
        <h2 className="text-2xl font-bold text-gray-900">Order on WhatsApp</h2>
        <p className="text-gray-500 text-base">Scan to chat with Presentail and place an order.</p>
      </div>

      {/* QR code — fills as much vertical space as possible, stays square */}
      <div
        className="relative"
        style={{
          width: "min(70vw, 70vh)",
          height: "min(70vw, 70vh)",
          padding: "16px",
          background: "#fff",
          borderRadius: "12px",
          boxShadow: "0 4px 32px rgba(0,0,0,0.10)",
        }}
      >
        <img
          src="/cmc-whatsapp-qr.png"
          alt="Presentail WhatsApp ordering QR code"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            imageRendering: "pixelated",
          }}
          draggable={false}
        />
      </div>

      {/* Context label */}
      <div
        className="mt-6 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium"
        style={{ background: "#e6f9ee", color: "#1a7340" }}
      >
        <WhatsAppIcon size={16} />
        Presentail CMC · WhatsApp ordering
      </div>
    </div>
  );
}

/** Props for the main modal */
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Display mode for the QR experience.
 *
 * - "hidden"     — nothing visible
 * - "modal"      — the Dialog is open
 * - "fullscreen" — the full-screen overlay is shown (Dialog is NOT mounted,
 *                  so there is no Radix focus trap blocking the overlay)
 */
type DisplayMode = "hidden" | "modal" | "fullscreen";

/**
 * WhatsApp QR modal with optional full-screen mode.
 *
 * Uses a single `mode` state rather than two independent booleans to avoid
 * the race condition where an effect that resets `fullScreen` on `open=false`
 * would fire immediately after clicking "Display Full Screen"
 * (because that click also sets `open=false` via `onOpenChange`).
 */
export default function CmcPosWhatsAppQrModal({ open, onOpenChange }: Props) {
  const [mode, setMode] = useState<DisplayMode>(open ? "modal" : "hidden");

  // Sync `mode` with the external `open` prop — but only when we are NOT
  // already in full-screen, so an intentional modal→fullscreen transition
  // is never interrupted by the prop change.
  useEffect(() => {
    if (mode !== "fullscreen") {
      setMode(open ? "modal" : "hidden");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleEnterFullScreen = () => {
    // 1. Switch internal mode to "fullscreen" first.
    // 2. Tell parent the dialog is closed (open→false).
    //    The useEffect above will NOT reset mode because mode is already "fullscreen".
    setMode("fullscreen");
    onOpenChange(false);
  };

  const handleExitFullScreen = () => {
    setMode("hidden");
    onOpenChange(false);
  };

  if (mode === "fullscreen") {
    return <CmcPosWhatsAppQrFullScreen onExit={handleExitFullScreen} />;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm p-0 overflow-hidden"
        aria-label="WhatsApp ordering QR code"
      >
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-lg font-semibold text-gray-900">
            Order on WhatsApp
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">
            Scan to chat with Presentail and place an order.
          </DialogDescription>
        </DialogHeader>

        {/* Context row */}
        <div
          className="mx-5 mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium"
          style={{ background: "#e6f9ee", color: "#1a7340" }}
        >
          <WhatsAppIcon size={16} />
          Presentail CMC · WhatsApp ordering
        </div>

        {/* QR image */}
        <div className="mx-5 mb-5 flex items-center justify-center">
          <div
            className="relative rounded-xl overflow-hidden"
            style={{
              background: "#fff",
              padding: "12px",
              boxShadow: "0 1px 8px rgba(0,0,0,0.08)",
              width: "100%",
              maxWidth: "280px",
            }}
          >
            <img
              src="/cmc-whatsapp-qr.png"
              alt="Presentail WhatsApp ordering QR code — scan to start an order on WhatsApp"
              style={{
                width: "100%",
                height: "auto",
                display: "block",
                imageRendering: "pixelated",
              }}
              draggable={false}
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-4">
          <button
            type="button"
            onClick={handleEnterFullScreen}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ background: WA_GREEN, outlineColor: WA_GREEN }}
            aria-label="Display QR code full screen"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Display Full Screen
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
          >
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
