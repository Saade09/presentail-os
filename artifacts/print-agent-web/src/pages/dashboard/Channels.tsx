import { useState, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tv2, Plus, Pencil, Trash2, Upload, X, ImageIcon, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, queryClient, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Info } from "lucide-react";

type Channel = {
  id: number;
  name: string;
  has_cover_photo: boolean;
  cover_photo_width: number | null;
  cover_photo_height: number | null;
  has_logo: boolean;
  created_at: string;
};

type ChannelsResponse = { channels: Channel[] };

type ChannelFormValues = {
  name: string;
  has_cover_photo: boolean;
  cover_photo_width: string;
  cover_photo_height: string;
  logo: File | null;
  removeLogo: boolean;
};

const DEFAULT_FORM: ChannelFormValues = {
  name: "",
  has_cover_photo: true,
  cover_photo_width: "",
  cover_photo_height: "",
  logo: null,
  removeLogo: false,
};

function channelToForm(c: Channel): ChannelFormValues {
  return {
    name: c.name,
    has_cover_photo: c.has_cover_photo,
    cover_photo_width: c.cover_photo_width !== null ? String(c.cover_photo_width) : "",
    cover_photo_height: c.cover_photo_height !== null ? String(c.cover_photo_height) : "",
    logo: null,
    removeLogo: false,
  };
}

function buildFormData(f: ChannelFormValues): FormData {
  const fd = new FormData();
  fd.append("name", f.name.trim());
  fd.append("has_cover_photo", String(f.has_cover_photo));
  if (f.has_cover_photo && f.cover_photo_width !== "") {
    fd.append("cover_photo_width", f.cover_photo_width);
  }
  if (f.has_cover_photo && f.cover_photo_height !== "") {
    fd.append("cover_photo_height", f.cover_photo_height);
  }
  if (f.logo) {
    fd.append("logo", f.logo);
  } else if (f.removeLogo) {
    fd.append("remove_logo", "true");
  }
  return fd;
}

const MAX_LOGO_PX = 500;
const ALLOWED_LOGO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function ChannelForm({
  initial = DEFAULT_FORM,
  channelId,
  hasExistingLogo = false,
  submitLabel,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: ChannelFormValues;
  channelId?: number;
  hasExistingLogo?: boolean;
  submitLabel: string;
  onSubmit: (values: ChannelFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<ChannelFormValues>(initial);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof ChannelFormValues>(key: K, value: ChannelFormValues[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleLogoFile(file: File) {
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Logo must be a JPEG, PNG, or WebP image.");
      return;
    }
    if (logoPreview) URL.revokeObjectURL(logoPreview);
    const preview = URL.createObjectURL(file);
    setLogoPreview(preview);
    setForm((prev) => ({ ...prev, logo: file, removeLogo: false }));
    setLogoError(null);

    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth !== img.naturalHeight) {
        setLogoError("Logo must be square (width must equal height).");
      } else {
        setLogoError(null);
      }
    };
    img.onerror = () => { setLogoError("Could not read the image."); };
    img.src = preview;
  }

  function handleRemoveLogo() {
    if (logoPreview) {
      URL.revokeObjectURL(logoPreview);
      setLogoPreview(null);
    }
    setForm((prev) => ({ ...prev, logo: null, removeLogo: true }));
    setLogoError(null);
  }

  function handleUndoRemove() {
    setForm((prev) => ({ ...prev, removeLogo: false }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (logoError) return;
    if (form.name.trim()) onSubmit(form);
  }

  const isSubmitDisabled =
    isPending ||
    !form.name.trim() ||
    (form.has_cover_photo && (!form.cover_photo_width || !form.cover_photo_height)) ||
    !!logoError;

  const showExistingLogo = hasExistingLogo && !form.logo && !form.removeLogo && channelId !== undefined;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Channel name</label>
        <Input
          placeholder="e.g. Online Store"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          required
          maxLength={200}
          data-testid="input-channel-name"
        />
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <Checkbox
            checked={form.has_cover_photo}
            onCheckedChange={(checked) => set("has_cover_photo", checked === true)}
            data-testid="checkbox-has-cover-photo"
          />
          <span className="font-medium">Has cover photo</span>
        </label>

        {form.has_cover_photo && (
          <div className="pl-6 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">
                Width (px) <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 1920"
                value={form.cover_photo_width}
                onChange={(e) => set("cover_photo_width", e.target.value)}
                required
                data-testid="input-cover-photo-width"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">
                Height (px) <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                min={1}
                placeholder="e.g. 1080"
                value={form.cover_photo_height}
                onChange={(e) => set("cover_photo_height", e.target.value)}
                required
                data-testid="input-cover-photo-height"
              />
            </div>
          </div>
        )}
      </div>

      {/* Logo upload */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">
          Logo <span className="text-muted-foreground font-normal">(optional, square — auto-resized if larger than {MAX_LOGO_PX}×{MAX_LOGO_PX} px)</span>
        </label>
        <div className="flex items-center gap-3">
          {logoPreview ? (
            <img
              src={logoPreview}
              alt="Logo preview"
              className="w-10 h-10 rounded border border-border object-cover shrink-0"
            />
          ) : showExistingLogo ? (
            <WorkspaceImage
              src={`/api/channels/${channelId}/logo`}
              alt="Current logo"
              className="w-10 h-10 rounded border border-border object-cover shrink-0"
              data-testid="existing-channel-logo-preview"
            />
          ) : (
            <div className="w-10 h-10 rounded border border-dashed border-border bg-muted flex items-center justify-center shrink-0">
              <Upload size={14} className="text-muted-foreground" />
            </div>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            data-testid="input-channel-logo"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleLogoFile(file);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => logoInputRef.current?.click()}
          >
            {form.logo || showExistingLogo ? "Change logo" : "Choose logo"}
          </Button>
          {form.logo && (
            <span className="text-xs text-muted-foreground truncate max-w-[140px]">{form.logo.name}</span>
          )}
          {showExistingLogo && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={handleRemoveLogo}
              data-testid="button-remove-logo"
            >
              <X size={14} className="mr-1" />
              Remove logo
            </Button>
          )}
        </div>
        {form.removeLogo && (
          <p className="text-xs text-muted-foreground mt-1" data-testid="remove-logo-notice">
            Logo will be removed on save.{" "}
            <button
              type="button"
              className="underline hover:no-underline"
              onClick={handleUndoRemove}
              data-testid="button-undo-remove-logo"
            >
              Undo
            </button>
          </p>
        )}
        {logoError && (
          <p className="text-xs text-destructive mt-1" data-testid="logo-error">{logoError}</p>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitDisabled}
          data-testid="button-channel-submit"
        >
          {isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function coverPhotoLabel(c: Channel): string {
  if (!c.has_cover_photo) return "No cover photo";
  if (c.cover_photo_width && c.cover_photo_height) {
    return `${c.cover_photo_width} × ${c.cover_photo_height} px`;
  }
  return "Cover photo (dimensions not set)";
}

async function submitChannel(url: string, method: "POST" | "PUT", values: ChannelFormValues) {
  const fd = buildFormData(values);
  const token = await getClerkToken();
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json;
}

export default function ChannelsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isOwner, allowedPages, customRoleId, loaded: roleLoaded } = useWorkspaceRole();
  const canCreate = isOwner || (allowedPages?.includes("channels.manage") ?? false) || (allowedPages?.includes("channels.create") ?? false);
  const canEdit = isOwner || (allowedPages?.includes("channels.manage") ?? false) || (allowedPages?.includes("channels.edit") ?? false);
  const canDelete = isOwner || (allowedPages?.includes("channels.manage") ?? false) || (allowedPages?.includes("channels.delete") ?? false);
  const [creating, setCreating] = useState(false);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);

  const { data, isLoading } = useQuery<ChannelsResponse>({
    queryKey: ["channels"],
    queryFn: () => apiFetch("/api/channels"),
  });

  const channels = data?.channels ?? [];

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["channels"] });
  }

  const createMutation = useMutation({
    mutationFn: (values: ChannelFormValues) =>
      submitChannel("/api/channels", "POST", values),
    onSuccess: () => {
      setCreating(false);
      invalidate();
      toast({ title: "Channel created" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not create channel", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: number; values: ChannelFormValues }) =>
      submitChannel(`/api/channels/${id}`, "PUT", values),
    onSuccess: () => {
      setEditingChannel(null);
      invalidate();
      toast({ title: "Channel updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not update channel", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/channels/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeletingChannel(null);
      invalidate();
      toast({ title: "Channel deleted" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not delete channel", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("nav.channels")}</h1>
          <p className="text-muted-foreground mt-2">
            Manage the channels where products are sold or distributed.
          </p>
        </div>
        {!creating && canCreate && (
          <Button
            onClick={() => setCreating(true)}
            className="shrink-0"
            data-testid="button-new-channel"
          >
            <Plus size={16} className="mr-1.5" />
            New channel
          </Button>
        )}
      </div>

      {roleLoaded && !isOwner && customRoleId !== null && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground"
          data-testid="channels-role-filter-notice"
        >
          <Info size={15} className="shrink-0" />
          Showing channels available to your role.
        </div>
      )}

      {creating && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">New channel</CardTitle>
          </CardHeader>
          <CardContent>
            <ChannelForm
              submitLabel="Create channel"
              onSubmit={(values) => createMutation.mutate(values)}
              onCancel={() => setCreating(false)}
              isPending={createMutation.isPending}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Channels</CardTitle>
          <CardDescription>
            {isLoading
              ? "Loading…"
              : channels.length === 1
                ? "1 channel"
                : `${channels.length} channels`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">Loading…</div>
          ) : channels.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <Tv2 size={32} className="mx-auto mb-3 opacity-30" />
              <p>No channels yet</p>
              <p className="text-sm mt-1">Create a channel to get started.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {channels.map((c) =>
                editingChannel?.id === c.id ? (
                  <li key={c.id} className="px-6 py-4">
                    <ChannelForm
                      initial={channelToForm(c)}
                      channelId={c.id}
                      hasExistingLogo={c.has_logo}
                      submitLabel="Save changes"
                      onSubmit={(values) => updateMutation.mutate({ id: c.id, values })}
                      onCancel={() => setEditingChannel(null)}
                      isPending={updateMutation.isPending}
                    />
                  </li>
                ) : (
                  <li
                    key={c.id}
                    className="px-6 py-4"
                    data-testid={`channel-row-${c.id}`}
                  >
                    <div className="flex items-start gap-4">
                      <Link href={`/channels/${c.id}`}>
                        {c.has_logo ? (
                          <WorkspaceImage
                            src={`/api/channels/${c.id}/logo`}
                            alt={`${c.name} logo`}
                            className="w-8 h-8 rounded border border-border object-cover shrink-0 mt-0.5 cursor-pointer hover:opacity-80 transition-opacity"
                            data-testid={`channel-logo-${c.id}`}
                          />
                        ) : (
                          <div className="w-8 h-8 rounded border border-dashed border-border bg-muted shrink-0 mt-0.5 cursor-pointer hover:border-border transition-colors" />
                        )}
                      </Link>
                      <div className="flex-1 min-w-0">
                        <Link
                          href={`/channels/${c.id}`}
                          className="font-medium hover:underline hover:text-primary transition-colors"
                          data-testid={`channel-link-${c.id}`}
                        >
                          {c.name}
                        </Link>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {coverPhotoLabel(c)}
                        </div>
                        <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <ImageIcon size={11} />
                            Click to manage image dimensions &amp; contacts
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingChannel(c)}
                            data-testid={`button-edit-channel-${c.id}`}
                          >
                            <Pencil size={15} />
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeletingChannel(c)}
                            data-testid={`button-delete-channel-${c.id}`}
                          >
                            <Trash2 size={15} className="text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ),
              )}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={deletingChannel !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeletingChannel(null);
        }}
      >
        <DialogContent data-testid="dialog-confirm-delete-channel">
          <DialogHeader>
            <DialogTitle>Delete channel?</DialogTitle>
            <DialogDescription>
              {deletingChannel && (
                <>
                  Permanently delete <strong>{deletingChannel.name}</strong>? This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingChannel(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingChannel && deleteMutation.mutate(deletingChannel.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-channel"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
