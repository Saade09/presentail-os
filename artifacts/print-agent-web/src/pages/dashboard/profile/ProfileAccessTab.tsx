import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Shield, MapPin, CheckCircle2, XCircle } from "lucide-react";
import type { FullProfileData } from "./types";
import { getRoleLabel } from "./types";

interface ProfileAccessTabProps {
  profile: FullProfileData | undefined;
  allowedPages: string[] | null;
  isOwner: boolean;
}

function PermFlag({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center gap-2 py-2 border-b last:border-0">
      {value ? (
        <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />
      ) : (
        <XCircle size={15} className="text-muted-foreground/50 shrink-0" />
      )}
      <span className={`text-sm ${value ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
    </div>
  );
}

function hasPage(allowedPages: string[] | null, page: string): boolean {
  if (allowedPages === null) return true;
  return allowedPages.includes(page);
}

export function ProfileAccessTab({ profile, allowedPages, isOwner }: ProfileAccessTabProps) {
  if (!profile) return null;

  const roleLabel = getRoleLabel(profile);
  const isOwnerRole = profile.role === "owner";

  const canApproveTimeOff = isOwner || hasPage(allowedPages, "time-off.manage");
  const hasAnalyticsAccess = isOwner || hasPage(allowedPages, "analytics");
  const hasUserMgmtAccess = isOwner || hasPage(allowedPages, "users");
  const hasApiAccess = isOwner || hasPage(allowedPages, "api-keys");
  const hasBrandAccess = isOwner || hasPage(allowedPages, "brands");
  const hasProductAccess = isOwner || hasPage(allowedPages, "products");

  return (
    <div className="space-y-5">
      {/* Role */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Shield size={16} />
            Role & Permissions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge variant={isOwnerRole ? "default" : "outline"} className="text-sm px-3 py-1">
              {roleLabel}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {isOwnerRole
                ? "Full access to all workspace features and settings."
                : (profile.custom_role_names?.length ?? 0) > 0
                  ? `Custom role${(profile.custom_role_names?.length ?? 0) > 1 ? "s" : ""} with specific page access defined below.`
                  : "Standard member with default access."}
            </span>
          </div>

          {!isOwnerRole && allowedPages !== null && (
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">ALLOWED PAGES</p>
              {allowedPages.length === 0 ? (
                <p className="text-xs text-muted-foreground">No specific page permissions granted.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {allowedPages.map((page) => (
                    <Badge key={page} variant="secondary" className="text-xs font-mono">
                      {page}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Assigned locations */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <MapPin size={16} />
            Assigned Locations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isOwnerRole ? (
            <p className="text-sm text-muted-foreground">
              As a workspace owner, you have access to all locations.
            </p>
          ) : profile.assigned_locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No locations assigned — access may be workspace-wide.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {profile.assigned_locations.map((loc) => (
                <Badge key={loc.id} variant="secondary" className="flex items-center gap-1">
                  <MapPin size={11} />
                  {loc.name}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Permission flags */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Permission Summary</CardTitle>
          {!isOwner && (
            <p className="text-xs text-muted-foreground mt-1">
              Contact your workspace owner to change these permissions.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <PermFlag label="Approve time-off requests" value={canApproveTimeOff} />
          <PermFlag label="View analytics" value={hasAnalyticsAccess} />
          <PermFlag label="Manage users & members" value={hasUserMgmtAccess} />
          <PermFlag label="Manage brands" value={hasBrandAccess} />
          <PermFlag label="Manage products" value={hasProductAccess} />
          <PermFlag label="Access API keys" value={hasApiAccess} />
        </CardContent>
      </Card>
    </div>
  );
}
