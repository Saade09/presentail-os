import { useListSecurityAlertEvents } from "@workspace/api-client-react";
import type { SecurityAlertEvent } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Globe, Monitor, RefreshCw, ShieldAlert } from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return parseISO(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function kindLabel(kind: string): string {
  if (kind === "new_device") return "New device sign-in";
  if (kind === "unexpected_country") return "Sign-in from new country";
  return kind;
}

function AlertEventRow({ event }: { event: SecurityAlertEvent }) {
  const isDevice = event.kind === "new_device";

  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-b-0">
      <div className="mt-0.5 shrink-0 h-8 w-8 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center">
        {isDevice ? (
          <Monitor size={14} className="text-amber-600" />
        ) : (
          <Globe size={14} className="text-amber-600" />
        )}
      </div>
      <div className="space-y-0.5 min-w-0 flex-1">
        <p className="text-sm font-medium">{kindLabel(event.kind)}</p>
        <p className="text-xs text-muted-foreground">
          {[event.deviceLabel, event.country].filter(Boolean).join(" · ")}
        </p>
        <p className="text-xs text-muted-foreground" title={absoluteTime(event.sentAt)}>
          {absoluteTime(event.sentAt)}{" "}
          <span className="text-muted-foreground/60">({relativeTime(event.sentAt)})</span>
        </p>
      </div>
    </div>
  );
}

function AlertEventSkeleton() {
  return (
    <div className="flex items-start gap-3 py-3 border-b last:border-b-0">
      <Skeleton className="h-8 w-8 rounded-full shrink-0 mt-0.5" />
      <div className="space-y-2 flex-1">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}

export function SecurityAlertHistory() {
  const { data, isLoading, isError, refetch } = useListSecurityAlertEvents();
  const events = data?.events ?? [];

  if (isLoading) {
    return (
      <div>
        <AlertEventSkeleton />
        <AlertEventSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center text-muted-foreground">
        <p className="text-sm">Failed to load alert history.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw size={14} />
          Retry
        </Button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
        <ShieldAlert size={24} className="text-muted-foreground/40" />
        <p className="text-sm">No security alert emails have been sent yet.</p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {events.map((event) => (
        <AlertEventRow key={event.id} event={event} />
      ))}
    </div>
  );
}
