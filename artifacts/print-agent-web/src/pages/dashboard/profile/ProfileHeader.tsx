import { useRef, useState } from "react";
import { useUser } from "@clerk/react";
type UserResource = NonNullable<ReturnType<typeof useUser>["user"]>;
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Camera, MapPin, Briefcase, Mail, Phone, Clock, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { FullProfileData } from "./types";
import { getRoleLabel } from "./types";

interface ProfileHeaderProps {
  user: UserResource;
  profile: FullProfileData | undefined;
  onPhotoChange: (file: File) => Promise<void>;
  onPhotoRemove: () => Promise<void>;
  uploadingPhoto: boolean;
  removingPhoto: boolean;
  onEditProfile: () => void;
}

function LocalTime() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shortTz = tzName.split("/").pop()?.replace(/_/g, " ") ?? tzName;
  return (
    <span className="text-sm text-muted-foreground flex items-center gap-1">
      <Clock size={13} />
      {timeStr} · {shortTz}
    </span>
  );
}

export function ProfileHeader({
  user,
  profile,
  onPhotoChange,
  onPhotoRemove,
  uploadingPhoto,
  removingPhoto,
  onEditProfile,
}: ProfileHeaderProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasPhoto = user.hasImage;
  const avatarUrl = user.imageUrl;
  const email = user.primaryEmailAddress?.emailAddress ?? profile?.member_email ?? "";
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0] ||
    "Unknown";
  const initials = (user.firstName?.[0] ?? email[0] ?? "U").toUpperCase();

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await onPhotoChange(file);
    } catch {
      toast({ title: "Failed to upload photo", variant: "destructive" });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const roleLabel = profile ? getRoleLabel(profile) : null;
  const isOwner = profile?.role === "owner";

  return (
    <div className="rounded-xl border bg-card p-6 mb-6">
      <div className="flex flex-col sm:flex-row gap-5 items-start">
        {/* Avatar */}
        <div className="relative group shrink-0">
          <div className="w-20 h-20 rounded-full overflow-hidden bg-secondary flex items-center justify-center text-2xl font-semibold border-2 border-border">
            {hasPhoto ? (
              <img src={avatarUrl} alt="Profile photo" className="w-full h-full object-cover" />
            ) : (
              <span>{initials}</span>
            )}
          </div>
          <button
            className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPhoto || removingPhoto}
            aria-label="Change profile photo"
            type="button"
            data-testid="upload-photo-button"
          >
            <Camera size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
            data-testid="photo-file-input"
          />
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <h2 className="text-xl font-bold tracking-tight truncate">{fullName}</h2>
            <Badge
              variant="secondary"
              className="text-emerald-700 bg-emerald-50 border border-emerald-200 text-xs font-medium"
            >
              Active
            </Badge>
            {roleLabel && (
              <Badge
                variant={isOwner ? "default" : "outline"}
                className="text-xs font-medium"
              >
                {roleLabel}
              </Badge>
            )}
          </div>
          {profile?.job_title && (
            <p className="text-sm text-muted-foreground mb-2">{profile.job_title}</p>
          )}

          {/* Meta row */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {profile?.location && (
              <span className="flex items-center gap-1">
                <MapPin size={13} />
                {profile.location}
              </span>
            )}
            {profile?.department && (
              <span className="flex items-center gap-1">
                <Briefcase size={13} />
                {profile.department}
              </span>
            )}
            {profile?.manager_name && (
              <span className="flex items-center gap-1">
                <Users size={13} />
                {profile.manager_name}
              </span>
            )}
            <span className="flex items-center gap-1">
              <Mail size={13} />
              {email}
            </span>
            {profile?.phone && (
              <span className="flex items-center gap-1">
                <Phone size={13} />
                {profile.phone}
              </span>
            )}
            <LocalTime />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onEditProfile} data-testid="edit-profile-btn">
            Edit profile
          </Button>
          {hasPhoto && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-destructive hover:text-destructive"
              onClick={onPhotoRemove}
              disabled={removingPhoto || uploadingPhoto}
              data-testid="remove-photo-button"
            >
              {removingPhoto ? "Removing…" : "Remove photo"}
            </Button>
          )}
          {!hasPhoto && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPhoto}
            >
              {uploadingPhoto ? "Uploading…" : "Upload photo"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
