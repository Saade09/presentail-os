import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSecuritySessions,
  getListSecuritySessionsQueryKey,
  useRevokeSecuritySession,
  useRevokeOtherSecuritySessions,
} from "@workspace/api-client-react";
import type { SecuritySession } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Globe, Monitor, RefreshCw } from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";

function countryCodeToFlag(code: string | null | undefined): string | null {
  if (!code || code.length !== 2) return null;
  const upper = code.toUpperCase();
  const a = upper.charCodeAt(0) - 65;
  const b = upper.charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) return null;
  return String.fromCodePoint(0x1f1e6 + a, 0x1f1e6 + b);
}

function CountryFlag({ country }: { country: string | null | undefined }) {
  const flag = countryCodeToFlag(country);
  if (flag) {
    return <span aria-label={country ?? undefined}>{flag}</span>;
  }
  return <Globe size={12} className="inline text-muted-foreground" aria-label="Unknown location" />;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function absoluteTime(iso: string | null): string {
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

function SessionSkeleton() {
  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b last:border-b-0">
      <div className="flex items-start gap-3 flex-1">
        <Skeleton className="h-8 w-8 rounded-full shrink-0 mt-0.5" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
      <Skeleton className="h-8 w-20 shrink-0" />
    </div>
  );
}

interface SessionRowProps {
  session: SecuritySession;
  onRevoke: (sessionId: string) => void;
  isRevoking: boolean;
}

function SessionRow({ session, onRevoke, isRevoking }: SessionRowProps) {
  const location = [session.city, session.country].filter(Boolean).join(", ");

  return (
    <div className="flex items-start justify-between gap-4 py-4 border-b last:border-b-0">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="mt-0.5 shrink-0 h-8 w-8 rounded-full bg-muted flex items-center justify-center">
          <Monitor size={14} className="text-muted-foreground" />
        </div>
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{session.deviceLabel}</span>
            {session.isCurrent && (
              <Badge variant="secondary" className="text-xs">Current</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1 flex-wrap">
            <CountryFlag country={session.country} />
            <span>
              Last active {relativeTime(session.lastActiveAt)}
              {location ? ` · ${location}` : ""}
              {session.ipAddress ? ` · ${session.ipAddress}` : ""}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Signed in {absoluteTime(session.createdAt)}
            {session.expireAt ? ` · Expires ${absoluteTime(session.expireAt)}` : ""}
          </p>
        </div>
      </div>
      <div className="shrink-0">
        {session.isCurrent ? (
          <span className="text-xs text-muted-foreground italic">Current session</span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRevoke(session.id)}
            disabled={isRevoking}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
          >
            Revoke
          </Button>
        )}
      </div>
    </div>
  );
}

export function ActiveSessions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const { data, isLoading, isError, refetch } = useListSecuritySessions();
  const sessions = data?.sessions ?? [];

  const { mutate: revokeSession, isPending: isRevokingOne } = useRevokeSecuritySession({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListSecuritySessionsQueryKey() });
        toast({ title: "Session revoked", description: "The session has been signed out." });
        setConfirmRevokeId(null);
      },
      onError: (err) => {
        const msg = (err as Error).message ?? "Failed to revoke session";
        toast({ title: "Failed to revoke", description: msg, variant: "destructive" });
        setConfirmRevokeId(null);
      },
    },
  });

  const { mutate: revokeOthers, isPending: isRevokingOthers } = useRevokeOtherSecuritySessions({
    mutation: {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListSecuritySessionsQueryKey() });
        const count = res?.revokedCount ?? 0;
        toast({
          title: "Sessions revoked",
          description: `${count} other session${count === 1 ? "" : "s"} signed out.`,
        });
        setConfirmRevokeAll(false);
      },
      onError: (err) => {
        const msg = (err as Error).message ?? "Failed to revoke sessions";
        toast({ title: "Failed to revoke", description: msg, variant: "destructive" });
        setConfirmRevokeAll(false);
      },
    },
  });

  const otherSessions = sessions.filter((s) => !s.isCurrent);

  if (isLoading) {
    return (
      <div>
        <SessionSkeleton />
        <SessionSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center text-muted-foreground">
        <p className="text-sm">Failed to load sessions.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw size={14} />
          Retry
        </Button>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">No active sessions found.</p>
    );
  }

  return (
    <div>
      <div className="divide-y">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            onRevoke={(id) => setConfirmRevokeId(id)}
            isRevoking={isRevokingOne || isRevokingOthers}
          />
        ))}
      </div>

      {otherSessions.length > 0 && (
        <div className="mt-4 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRevokeAll(true)}
            disabled={isRevokingOne || isRevokingOthers}
            className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
          >
            Revoke all other sessions
          </Button>
        </div>
      )}

      <AlertDialog open={confirmRevokeId !== null} onOpenChange={(o) => !o && setConfirmRevokeId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke session?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately sign out that device. The user will need to sign in again to regain access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmRevokeId && revokeSession({ sessionId: confirmRevokeId })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRevokeAll} onOpenChange={(o) => !o && setConfirmRevokeAll(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke all other sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              This will immediately sign out all other devices ({otherSessions.length} session{otherSessions.length === 1 ? "" : "s"}). They will need to sign in again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeOthers()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Revoke all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
