import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  Users,
  ImageIcon,
  Phone,
  Mail,
  Briefcase,
} from "lucide-react";
import { getCountries, isValidPhoneNumber, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { isExcludedCountry } from "@/lib/countries";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const ALLOWED_COUNTRIES: Country[] = getCountries().filter((c) => !isExcludedCountry(c));

type ImageConfig = {
  id: number;
  channel_id: number;
  image_type: "product" | "banner" | "logo";
  width_px: number;
  height_px: number;
  output_format: "jpeg" | "png" | "webp";
  created_at: string;
};

type ChannelContact = {
  id: number;
  channel_id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type ChannelDetail = {
  id: number;
  name: string;
  has_cover_photo: boolean;
  cover_photo_width: number | null;
  cover_photo_height: number | null;
  has_logo: boolean;
  created_at: string;
  image_configs: ImageConfig[];
  contacts: ChannelContact[];
};

type ChannelDetailResponse = { channel: ChannelDetail };

const IMAGE_TYPE_LABELS: Record<string, string> = {
  product: "Product Image",
  banner: "Banner Image",
  logo: "Logo Image",
};

const OUTPUT_FORMAT_OPTIONS = [
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WEBP" },
];

function formatDimensions(cfg: ImageConfig | undefined): string {
  if (!cfg) return "Not configured";
  return `${cfg.width_px} × ${cfg.height_px} · ${cfg.output_format.toUpperCase()}`;
}

function validatePositiveInt(value: string): string | null {
  const n = Number(value.trim());
  if (!value.trim()) return "Required";
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return "Must be a positive integer";
  return null;
}

type ImageConfigFormState = {
  width_px: string;
  height_px: string;
  output_format: "jpeg" | "png" | "webp";
};

function ImageDimensionSection({
  channelId,
  imageType,
  config,
  canManage,
  onRefresh,
}: {
  channelId: number;
  imageType: "product" | "banner" | "logo";
  config: ImageConfig | undefined;
  canManage: boolean;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<ImageConfigFormState>({
    width_px: config ? String(config.width_px) : "",
    height_px: config ? String(config.height_px) : "",
    output_format: config?.output_format ?? "jpeg",
  });
  const [widthTouched, setWidthTouched] = useState(false);
  const [heightTouched, setHeightTouched] = useState(false);

  function openEdit() {
    setForm({
      width_px: config ? String(config.width_px) : "",
      height_px: config ? String(config.height_px) : "",
      output_format: config?.output_format ?? "jpeg",
    });
    setWidthTouched(false);
    setHeightTouched(false);
    setEditing(true);
  }

  const createMutation = useMutation({
    mutationFn: (body: { image_type: string; width_px: number; height_px: number; output_format: string }) =>
      apiFetch(`/api/channels/${channelId}/image-configs`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      onRefresh();
      setEditing(false);
      toast({ title: `${IMAGE_TYPE_LABELS[imageType]} dimensions saved` });
    },
    onError: (e: Error) =>
      toast({ title: "Could not save dimensions", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { width_px: number; height_px: number; output_format: string }) =>
      apiFetch(`/api/channels/${channelId}/image-configs/${config!.id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      onRefresh();
      setEditing(false);
      toast({ title: `${IMAGE_TYPE_LABELS[imageType]} dimensions updated` });
    },
    onError: (e: Error) =>
      toast({ title: "Could not update dimensions", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/channels/${channelId}/image-configs/${config!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      onRefresh();
      toast({ title: `${IMAGE_TYPE_LABELS[imageType]} dimensions removed` });
    },
    onError: (e: Error) =>
      toast({ title: "Could not remove dimensions", description: e.message, variant: "destructive" }),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const widthError = validatePositiveInt(form.width_px);
  const heightError = validatePositiveInt(form.height_px);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setWidthTouched(true);
    setHeightTouched(true);
    if (widthError || heightError) return;
    const body = {
      image_type: imageType,
      width_px: parseInt(form.width_px, 10),
      height_px: parseInt(form.height_px, 10),
      output_format: form.output_format,
    };
    if (config) {
      updateMutation.mutate(body);
    } else {
      createMutation.mutate(body);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{IMAGE_TYPE_LABELS[imageType]} Dimensions</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatDimensions(config)}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={openEdit}
              data-testid={`btn-edit-${imageType}-config`}
            >
              {config ? <Pencil size={11} /> : <Plus size={11} />}
              {config ? "Edit" : "Add"}
            </Button>
            {config && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                data-testid={`btn-delete-${imageType}-config`}
              >
                <Trash2 size={11} className="text-destructive" />
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={handleSubmit} className="rounded-md border border-border p-3 space-y-3 bg-muted/20">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Width (px)</Label>
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="e.g. 1920"
                value={form.width_px}
                onChange={(e) => { setForm(f => ({ ...f, width_px: e.target.value })); setWidthTouched(true); }}
                onBlur={() => setWidthTouched(true)}
                className={`h-8 text-sm${widthTouched && widthError ? " border-destructive" : ""}`}
                data-testid={`input-${imageType}-width`}
              />
              {widthTouched && widthError && (
                <p className="text-xs text-destructive">{widthError}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Height (px)</Label>
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="e.g. 1080"
                value={form.height_px}
                onChange={(e) => { setForm(f => ({ ...f, height_px: e.target.value })); setHeightTouched(true); }}
                onBlur={() => setHeightTouched(true)}
                className={`h-8 text-sm${heightTouched && heightError ? " border-destructive" : ""}`}
                data-testid={`input-${imageType}-height`}
              />
              {heightTouched && heightError && (
                <p className="text-xs text-destructive">{heightError}</p>
              )}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Output Format</Label>
            <Select
              value={form.output_format}
              onValueChange={(v) => setForm(f => ({ ...f, output_format: v as "jpeg" | "png" | "webp" }))}
            >
              <SelectTrigger className="h-8 text-sm" data-testid={`select-${imageType}-format`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OUTPUT_FORMAT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              className="h-7 text-xs"
              disabled={isPending || (widthTouched && !!widthError) || (heightTouched && !!heightError)}
              data-testid={`btn-submit-${imageType}-config`}
            >
              {isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

type ContactFormState = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  title: string;
};

const EMPTY_CONTACT_FORM: ContactFormState = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  title: "",
};

function contactToForm(c: ChannelContact): ContactFormState {
  return {
    first_name: c.first_name,
    last_name: c.last_name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    title: c.title ?? "",
  };
}

function ContactFormDialog({
  open,
  onClose,
  channelId,
  editContact,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  channelId: number;
  editContact: ChannelContact | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = editContact !== null;
  const [form, setForm] = useState<ContactFormState>(editContact ? contactToForm(editContact) : EMPTY_CONTACT_FORM);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [firstNameError, setFirstNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  function set<K extends keyof ContactFormState>(k: K, v: string) {
    setForm(f => ({ ...f, [k]: v }));
    if (k === "phone" && phoneError) setPhoneError(null);
    if (k === "first_name" && firstNameError) setFirstNameError(null);
    if (k === "email" && emailError) setEmailError(null);
  }

  const mutation = useMutation({
    mutationFn: (body: Record<string, string | null>) => {
      if (isEdit) {
        return apiFetch(`/api/channels/${channelId}/contacts/${editContact!.id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      }
      return apiFetch(`/api/channels/${channelId}/contacts`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast({ title: isEdit ? "Contact updated" : "Contact added" });
    },
    onError: (e: Error) =>
      toast({ title: isEdit ? "Could not update contact" : "Could not add contact", description: e.message, variant: "destructive" }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let valid = true;
    if (!form.first_name.trim()) {
      setFirstNameError("First name is required");
      valid = false;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setEmailError("Invalid email address");
      valid = false;
    }
    if (form.phone.trim() && !isValidPhoneNumber(form.phone.trim())) {
      setPhoneError("Invalid phone number");
      valid = false;
    }
    if (!valid) return;

    mutation.mutate({
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      title: form.title.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Contact" : "Add Contact"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update contact information." : "Add a new contact to this channel."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-first-name">
                First name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cc-first-name"
                value={form.first_name}
                onChange={(e) => set("first_name", e.target.value)}
                placeholder="e.g. John"
                className={firstNameError ? "border-destructive" : ""}
                data-testid="input-contact-first-name"
              />
              {firstNameError && <p className="text-xs text-destructive">{firstNameError}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-last-name">Last name</Label>
              <Input
                id="cc-last-name"
                value={form.last_name}
                onChange={(e) => set("last_name", e.target.value)}
                placeholder="e.g. Smith"
                data-testid="input-contact-last-name"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-title">Title / Role</Label>
            <Input
              id="cc-title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. Account Manager"
              data-testid="input-contact-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-email">Email</Label>
            <Input
              id="cc-email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="e.g. john@example.com"
              className={emailError ? "border-destructive" : ""}
              data-testid="input-contact-email"
            />
            {emailError && <p className="text-xs text-destructive">{emailError}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-phone">Phone</Label>
            <PhoneInputField
              id="cc-phone"
              international
              countryCallingCodeEditable={false}
              defaultCountry="LB"
              countries={ALLOWED_COUNTRIES}
              value={form.phone || undefined}
              onChange={(val) => set("phone", val ?? "")}
              data-testid="input-contact-phone"
            />
            {phoneError && <p className="text-xs text-destructive" data-testid="contact-phone-error">{phoneError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-save-contact">
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ChannelDetailPage() {
  const { channelId } = useParams<{ channelId: string }>();
  const id = parseInt(channelId ?? "", 10);
  const { toast } = useToast();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("channels.manage") ?? false);

  const { data, isLoading, error, refetch } = useQuery<ChannelDetailResponse>({
    queryKey: ["channel-detail", id],
    queryFn: () => apiFetch(`/api/channels/${id}`),
    enabled: !Number.isNaN(id),
  });

  const channel = data?.channel;

  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ChannelContact | null>(null);
  const [deletingContact, setDeletingContact] = useState<ChannelContact | null>(null);

  const deleteContactMutation = useMutation({
    mutationFn: (contactId: number) =>
      apiFetch(`/api/channels/${id}/contacts/${contactId}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeletingContact(null);
      refetch();
      queryClient.invalidateQueries({ queryKey: ["channel-detail", id] });
      toast({ title: "Contact removed" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not remove contact", description: e.message, variant: "destructive" }),
  });

  function handleRefresh() {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["channel-detail", id] });
  }

  if (Number.isNaN(id)) {
    return (
      <div className="space-y-6">
        <p className="text-destructive">Invalid channel ID.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/channels">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ArrowLeft size={15} />
              Channels
            </Button>
          </Link>
        </div>
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (error || !channel) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/channels">
            <Button variant="ghost" size="sm" className="gap-1.5">
              <ArrowLeft size={15} />
              Channels
            </Button>
          </Link>
        </div>
        <div className="py-12 text-center text-muted-foreground">
          {error ? "Failed to load channel." : "Channel not found."}
        </div>
      </div>
    );
  }

  const getConfig = (type: "product" | "banner" | "logo") =>
    channel.image_configs.find((c) => c.image_type === type);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link href="/channels">
          <Button variant="ghost" size="sm" className="gap-1.5 mb-4 -ml-2">
            <ArrowLeft size={15} />
            Channels
          </Button>
        </Link>
        <div className="flex items-center gap-4">
          {channel.has_logo ? (
            <WorkspaceImage
              src={`/api/channels/${channel.id}/logo`}
              alt={`${channel.name} logo`}
              className="w-12 h-12 rounded-lg border border-border object-cover shrink-0"
              data-testid="channel-detail-logo"
            />
          ) : (
            <div className="w-12 h-12 rounded-lg border border-dashed border-border bg-muted flex items-center justify-center shrink-0 text-lg font-semibold text-muted-foreground uppercase">
              {channel.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-bold tracking-tight" data-testid="channel-detail-name">
              {channel.name}
            </h1>
            {channel.has_cover_photo && channel.cover_photo_width && channel.cover_photo_height && (
              <p className="text-muted-foreground text-sm mt-0.5">
                Cover photo: {channel.cover_photo_width} × {channel.cover_photo_height} px
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Contacts Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users size={16} />
              Contacts
              {channel.contacts.length > 0 && (
                <span className="text-muted-foreground font-normal text-sm">({channel.contacts.length})</span>
              )}
            </CardTitle>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8 text-xs"
                onClick={() => { setEditingContact(null); setContactFormOpen(true); }}
                data-testid="btn-add-contact"
              >
                <Plus size={12} />
                Add contact
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {channel.contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No contacts yet. {canManage && "Add a contact to get started."}
            </p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border">
              {channel.contacts.map((contact) => (
                <div key={contact.id} className="flex items-start gap-3 px-4 py-3" data-testid={`contact-row-${contact.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">
                        {contact.first_name}{contact.last_name ? ` ${contact.last_name}` : ""}
                      </p>
                      {contact.title && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Briefcase size={10} />
                          {contact.title}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-3 mt-1">
                      {contact.email && (
                        <a
                          href={`mailto:${contact.email}`}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Mail size={11} />
                          {contact.email}
                        </a>
                      )}
                      {contact.phone && (
                        <a
                          href={`tel:${contact.phone}`}
                          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Phone size={11} />
                          {contact.phone}
                        </a>
                      )}
                    </div>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => { setEditingContact(contact); setContactFormOpen(true); }}
                        data-testid={`btn-edit-contact-${contact.id}`}
                      >
                        <Pencil size={12} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => setDeletingContact(contact)}
                        data-testid={`btn-delete-contact-${contact.id}`}
                      >
                        <Trash2 size={12} className="text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Image Dimensions Sections */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon size={16} />
            Image Dimensions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {(["product", "banner"] as const).map((type, idx) => (
            <div key={type}>
              {idx > 0 && <div className="border-t border-border -mx-6 mb-6" />}
              <ImageDimensionSection
                channelId={channel.id}
                imageType={type}
                config={getConfig(type)}
                canManage={canManage}
                onRefresh={handleRefresh}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Contact Form Dialog */}
      {contactFormOpen && (
        <ContactFormDialog
          open={contactFormOpen}
          onClose={() => { setContactFormOpen(false); setEditingContact(null); }}
          channelId={channel.id}
          editContact={editingContact}
          onSaved={handleRefresh}
        />
      )}

      {/* Delete Contact Confirm Dialog */}
      <Dialog
        open={deletingContact !== null}
        onOpenChange={(open) => { if (!open && !deleteContactMutation.isPending) setDeletingContact(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove contact?</DialogTitle>
            <DialogDescription>
              {deletingContact && (
                <>
                  Remove <strong>{deletingContact.first_name}{deletingContact.last_name ? ` ${deletingContact.last_name}` : ""}</strong> from this channel?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingContact(null)}
              disabled={deleteContactMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deletingContact && deleteContactMutation.mutate(deletingContact.id)}
              disabled={deleteContactMutation.isPending}
              data-testid="btn-confirm-delete-contact"
            >
              {deleteContactMutation.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
