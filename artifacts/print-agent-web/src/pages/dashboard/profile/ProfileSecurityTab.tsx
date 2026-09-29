import { useUser } from "@clerk/react";
type UserResource = NonNullable<ReturnType<typeof useUser>["user"]>;
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, Key, Monitor, Bell } from "lucide-react";
import { ActiveSessions } from "./ActiveSessions";
import { SecurityAlertHistory } from "./SecurityAlertHistory";

interface ProfileSecurityTabProps {
  user: UserResource;
}

export function ProfileSecurityTab({ user }: ProfileSecurityTabProps) {
  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const lastSignIn = user.lastSignInAt;
  const createdAt = user.createdAt;

  const authProvider = (() => {
    const ext = user.externalAccounts?.[0];
    if (ext?.provider === "google") return "Google";
    if (ext?.provider === "github") return "GitHub";
    if (user.primaryEmailAddress) return "Email / Password";
    return "Unknown";
  })();

  function formatTs(ts: Date | null | undefined): string {
    if (!ts) return "—";
    return ts.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="space-y-5">
      {/* Authentication info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Key size={16} />
            Authentication
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Auth provider</p>
              <p className="text-sm font-medium">{authProvider}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Account email</p>
              <p className="text-sm font-medium">{email}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Last sign in</p>
              <p className="text-sm font-medium">{formatTs(lastSignIn)}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Account created</p>
              <p className="text-sm font-medium">{formatTs(createdAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 2FA placeholder */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Shield size={16} />
            Two-Factor Authentication
            <Badge variant="secondary" className="text-xs">Coming soon</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-muted-foreground">
            <Shield size={18} className="shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">2FA not yet available</p>
              <p className="text-xs">
                Two-factor authentication will be available in a future release. Authentication is currently managed via your Clerk account.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Active Sessions */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Monitor size={16} />
            Active Sessions
          </CardTitle>
          <CardDescription className="text-xs">
            Review where your account is currently signed in. Revoke sessions you do not recognize.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActiveSessions />
        </CardContent>
      </Card>

      {/* Security Alert History */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Bell size={16} />
            Security Alert History
          </CardTitle>
          <CardDescription className="text-xs">
            A log of security alert emails sent to you — new device sign-ins and unexpected country logins.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SecurityAlertHistory />
        </CardContent>
      </Card>
    </div>
  );
}
