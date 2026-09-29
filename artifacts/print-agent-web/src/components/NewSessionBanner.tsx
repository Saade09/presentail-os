import { Link } from "wouter";
import { ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNewSessionAlert } from "@/hooks/use-new-session-alert";

export function NewSessionBanner() {
  const { newSessions, dismiss } = useNewSessionAlert();

  if (newSessions.length === 0) return null;

  let message: string;

  if (newSessions.length === 1) {
    const { session, kind } = newSessions[0];
    if (kind === "unexpected_country") {
      const location = session.country ?? "an unexpected location";
      message = `New sign-in on ${session.deviceLabel} detected from ${location}.`;
    } else {
      message = `New sign-in detected on ${session.deviceLabel}.`;
    }
  } else {
    message = `New sign-ins detected on ${newSessions.length} new devices or locations.`;
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex items-center gap-3 bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-sm text-amber-900"
      data-testid="new-session-banner"
    >
      <ShieldAlert size={15} className="shrink-0 text-amber-600" />
      <span className="flex-1">
        {message}{" "}
        Not you?{" "}
        <Link
          href="/profile?tab=security"
          onClick={dismiss}
          className="underline underline-offset-2 font-medium hover:text-amber-700 transition-colors"
          data-testid="new-session-banner-link"
        >
          Revoke it in Security settings.
        </Link>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
        onClick={dismiss}
        aria-label="Dismiss new sign-in alert"
        data-testid="new-session-banner-dismiss"
      >
        <X size={13} />
      </Button>
    </div>
  );
}
