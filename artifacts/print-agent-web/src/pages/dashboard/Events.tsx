import { useRef, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { formatUSD } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  useListOccasions,
  getListOccasionsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  Plus,
  CalendarDays,
  ImageIcon,
  X,
  Upload,
  Loader2,
  Search,
  GripHorizontal,
  MoreHorizontal,
  Pencil,
  Archive,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─── Types ────────────────────────────────────────────────────────────────────

type Event = {
  id: number;
  name: string;
  description: string | null;
  starting_price_usd: string | null;
  starting_price_aed: string | null;
  status: string;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_public_path: string | null;
  additional_image_public_paths: string[];
  occasions: { id: number; name: string; slug: string }[];
  is_archived: boolean;
  created_at: string;
};

type EventsResponse = {
  events: Event[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type PublishingChannel = {
  id: number;
  name: string;
  slug: string;
};

type EventPublication = {
  id: number;
  event_id: number;
  channel_id: number;
  channel_name: string;
  channel_slug: string;
  publication_status: string;
  public_slug: string | null;
  price_override: string | null;
  sale_price_override: string | null;
};

type EventFormState = {
  name: string;
  description: string;
  starting_price_usd: string;
  starting_price_aed: string;
  status: string;
  main_image_url: string;
  occasion_ids: number[];
};

const DEFAULT_EVENT_FORM: EventFormState = {
  name: "",
  description: "",
  starting_price_usd: "",
  starting_price_aed: "",
  status: "available",
  main_image_url: "",
  occasion_ids: [],
};

const EVENT_STATUS_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "unavailable", label: "Unavailable" },
] as const;

const DEFAULT_PAGE_SIZE = 25;
const MAX_ADDITIONAL_IMAGES = 10;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function eventStatusBadge(status: string) {
  switch (status) {
    case "available":
      return (
        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">
          Available
        </Badge>
      );
    case "unavailable":
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">
          Unavailable
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

// ─── Additional images uploader (edit-only, uses /api/events/:id/images) ─────

function SortableImageItem({
  id,
  url,
  onRemove,
}: {
  id: string;
  url: string;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const display = imageUrl(url);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted shrink-0"
    >
      {display && <img src={display} alt="" className="w-full h-full object-cover" />}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-background/80 flex items-center justify-center hover:bg-background z-10"
      >
        <X size={8} />
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-white/80 hover:text-white cursor-grab active:cursor-grabbing touch-none"
        title="Drag to reorder"
      >
        <GripHorizontal size={12} />
      </button>
    </div>
  );
}

/** Upload additional images for an existing event via POST /api/events/:id/images */
function AdditionalImagesUploader({
  eventId,
  urls,
  onUrlsChange,
}: {
  eventId: number;
  urls: string[];
  onUrlsChange: (urls: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const token = await getClerkToken();
      const res = await fetch(`/api/events/${eventId}/images`, {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      onUrlsChange([...urls, json.url!]);
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const items = urls.map((url, idx) => ({ id: `${idx}:${url}`, url }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((it) => it.id === active.id);
      const newIndex = items.findIndex((it) => it.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onUrlsChange(arrayMove(urls, oldIndex, newIndex));
      }
    }
  }

  const atLimit = urls.length >= MAX_ADDITIONAL_IMAGES;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Additional Images</Label>
        <span className="text-xs text-muted-foreground">{urls.length} / {MAX_ADDITIONAL_IMAGES}</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((it) => it.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-wrap gap-2">
            {items.map(({ id, url }, idx) => (
              <SortableImageItem
                key={id}
                id={id}
                url={url}
                onRemove={() => onUrlsChange(urls.filter((_, i) => i !== idx))}
              />
            ))}
            {!atLimit && (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="w-16 h-16 border-2 border-dashed border-border rounded-md flex flex-col items-center justify-center hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50"
              >
                {uploading ? (
                  <Loader2 size={14} className="animate-spin text-muted-foreground" />
                ) : (
                  <Upload size={14} className="text-muted-foreground" />
                )}
              </button>
            )}
          </div>
        </SortableContext>
      </DndContext>
      {urls.length > 0 && (
        <p className="text-xs text-muted-foreground">Drag images to reorder. Changes to order are saved with the form.</p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ─── Occasions multi-select ───────────────────────────────────────────────────

function OccasionMultiSelect({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const occasionsQuery = useListOccasions(
    { pageSize: 100 },
    { query: { queryKey: getListOccasionsQueryKey({ pageSize: 100 }) } },
  );
  const occasions = occasionsQuery.data?.items ?? [];
  const filtered = occasions.filter((o) =>
    o.name.toLowerCase().includes(search.toLowerCase()),
  );
  const selectedNames = occasions.filter((o) => value.includes(o.id)).map((o) => o.name);

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center gap-1.5 flex-wrap min-h-9 rounded-md border border-input bg-background px-3 py-2 text-sm text-left hover:bg-accent/30 transition-colors"
        >
          {selectedNames.length === 0 ? (
            <span className="text-muted-foreground">Select occasions…</span>
          ) : (
            selectedNames.map((name) => (
              <span key={name} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-primary/10 text-primary text-xs">
                {name}
              </span>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2 space-y-2" align="start">
        <Input
          placeholder="Search occasions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
          autoFocus
        />
        <div className="max-h-48 overflow-y-auto space-y-0.5">
          {occasionsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground px-2 py-1">Loading…</p>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-1">No occasions found.</p>
          ) : (
            filtered.map((o) => (
              <label key={o.id} className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-muted/50 text-sm">
                <Checkbox checked={value.includes(o.id)} onCheckedChange={() => toggle(o.id)} />
                {o.name}
              </label>
            ))
          )}
        </div>
        {value.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="w-full h-7 text-xs" onClick={() => onChange([])}>
            Clear all
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Channel publication panel ────────────────────────────────────────────────

type PubLocalState = {
  publication_status: string;
  public_slug: string;
  price_override: string;
};

function EventPublicationPanel({ eventId }: { eventId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Load all publishing channels
  const channelsQuery = useQuery({
    queryKey: ["publishing-channels"],
    queryFn: () =>
      apiFetch<{ channels: PublishingChannel[] }>("/api/publishing-channels"),
  });

  // Load existing publications for this event
  const publicationsQuery = useQuery({
    queryKey: ["event-publications", eventId],
    queryFn: () =>
      apiFetch<{ publications: EventPublication[] }>(
        `/api/events/${eventId}/publications`,
      ),
    enabled: !!eventId,
  });

  const channels = channelsQuery.data?.channels ?? [];
  const publications = publicationsQuery.data?.publications ?? [];
  const pubByChannel = new Map(publications.map((p) => [p.channel_id, p]));

  const [localState, setLocalState] = useState<Record<number, PubLocalState>>({});

  // Seed from API data whenever channels or publications load
  useEffect(() => {
    if (!channelsQuery.data || !publicationsQuery.data) return;
    const next: Record<number, PubLocalState> = {};
    for (const ch of channels) {
      const pub = pubByChannel.get(ch.id);
      next[ch.id] = {
        publication_status: pub?.publication_status ?? "draft",
        public_slug: pub?.public_slug ?? "",
        price_override: pub?.price_override ?? "",
      };
    }
    setLocalState(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsQuery.data, publicationsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (channelId: number) => {
      const state = localState[channelId];
      return apiFetch(`/api/events/${eventId}/publications`, {
        method: "POST",
        body: JSON.stringify({
          channel_id: channelId,
          publication_status: state.publication_status,
          public_slug: state.public_slug || null,
          price_override: state.price_override ? parseFloat(state.price_override) : null,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["event-publications", eventId] });
      toast({ title: "Publication saved" });
    },
    onError: () => {
      toast({ title: "Failed to save publication", variant: "destructive" });
    },
  });

  if (channelsQuery.isLoading || publicationsQuery.isLoading) {
    return (
      <div className="flex items-center gap-1.5 py-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        Loading channels…
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No publishing channels configured yet. Add channels from the Channels page.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {channels.map((ch) => {
        const state = localState[ch.id] ?? { publication_status: "draft", public_slug: "", price_override: "" };
        const pub = pubByChannel.get(ch.id);

        return (
          <div key={ch.id} className="rounded-md border p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{ch.name}</p>
                <p className="text-xs text-muted-foreground">/{ch.slug}</p>
              </div>
              <div className="flex items-center gap-2">
                {pub && (
                  <Badge
                    className={
                      pub.publication_status === "published"
                        ? "bg-green-100 text-green-700 border-0"
                        : "bg-muted text-muted-foreground border-0"
                    }
                  >
                    {pub.publication_status === "published" ? "Published" : pub.publication_status}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Status</Label>
              <Select
                value={state.publication_status}
                onValueChange={(v) =>
                  setLocalState((prev) => ({ ...prev, [ch.id]: { ...state, publication_status: v } }))
                }
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="unpublished">Unpublished</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Public Slug</Label>
              <Input
                className="h-8 text-sm"
                placeholder="e.g. valentines-floral-workshop"
                value={state.public_slug}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, [ch.id]: { ...state, public_slug: e.target.value } }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Price Override (USD)</Label>
              <Input
                className="h-8 text-sm"
                type="number"
                min="0"
                step="0.01"
                placeholder="Leave blank to use starting price"
                value={state.price_override}
                onChange={(e) =>
                  setLocalState((prev) => ({ ...prev, [ch.id]: { ...state, price_override: e.target.value } }))
                }
              />
            </div>

            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => saveMutation.mutate(ch.id)}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
              Save
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Create / Edit dialog ─────────────────────────────────────────────────────

type DialogTab = "details" | "images" | "occasions" | "publish";

function CreateEditEventDialog({
  open,
  onClose,
  event,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  event?: Event | null;
  onSubmit: (data: EventFormState & { additional_image_urls: string[] }) => void;
  isPending: boolean;
}) {
  const isEdit = !!event;
  const [form, setForm] = useState<EventFormState>({ ...DEFAULT_EVENT_FORM });
  const [additionalUrls, setAdditionalUrls] = useState<string[]>([]);
  const [tab, setTab] = useState<DialogTab>("details");

  useEffect(() => {
    if (open) {
      if (event) {
        setForm({
          name: event.name,
          description: event.description ?? "",
          starting_price_usd: event.starting_price_usd ?? "",
          starting_price_aed: event.starting_price_aed ?? "",
          status: event.status,
          main_image_url: event.main_image_url ?? "",
          occasion_ids: (event.occasions ?? []).map((o) => o.id),
        });
        setAdditionalUrls(event.additional_image_urls ?? []);
      } else {
        setForm({ ...DEFAULT_EVENT_FORM });
        setAdditionalUrls([]);
      }
      setTab("details");
    }
  }, [open, event]);

  function set<K extends keyof EventFormState>(key: K, value: EventFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const canSubmit = form.name.trim().length > 0 && !isPending;

  const tabs: { id: DialogTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "images", label: "Images" },
    { id: "occasions", label: "Occasions" },
    ...(isEdit ? [{ id: "publish" as DialogTab, label: "Publish" }] : []),
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Event" : "Create Event"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the details for this event."
              : "Fill in the details for the new event."}
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex gap-0.5 border-b -mx-1 px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-sm rounded-t-md border-b-2 transition-colors ${
                tab === t.id
                  ? "border-primary text-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-4 py-2">
          {/* Details tab */}
          {tab === "details" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="event-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="event-name"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Valentine's Floral Workshop"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="event-desc">Description</Label>
                <Textarea
                  id="event-desc"
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder="Optional event description…"
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="event-price-usd">Starting Price (USD)</Label>
                  <Input
                    id="event-price-usd"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.starting_price_usd}
                    onChange={(e) => set("starting_price_usd", e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="event-price-aed">Starting Price (AED)</Label>
                  <Input
                    id="event-price-aed"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.starting_price_aed}
                    onChange={(e) => set("starting_price_aed", e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => set("status", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_STATUS_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {/* Images tab */}
          {tab === "images" && (
            <div className="space-y-4">
              {/* Main image — URL input */}
              <div className="space-y-1.5">
                <Label htmlFor="event-main-image">Main Image URL</Label>
                <Input
                  id="event-main-image"
                  value={form.main_image_url}
                  onChange={(e) => set("main_image_url", e.target.value)}
                  placeholder="https://… or /objects/…"
                />
                {form.main_image_url && imageUrl(form.main_image_url) && (
                  <div className="relative w-20 h-20 rounded-md border border-border overflow-hidden bg-muted mt-1.5">
                    <img
                      src={imageUrl(form.main_image_url)!}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => set("main_image_url", "")}
                      className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 flex items-center justify-center hover:bg-background"
                    >
                      <X size={10} />
                    </button>
                  </div>
                )}
              </div>

              {/* Additional images — upload only in edit mode */}
              {isEdit && event ? (
                <AdditionalImagesUploader
                  eventId={event.id}
                  urls={additionalUrls}
                  onUrlsChange={setAdditionalUrls}
                />
              ) : (
                <div className="rounded-md border border-dashed p-4 text-center">
                  <p className="text-xs text-muted-foreground">
                    Additional image uploads are available after the event is created.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Occasions tab */}
          {tab === "occasions" && (
            <div className="space-y-1.5">
              <Label>Occasions</Label>
              <OccasionMultiSelect
                value={form.occasion_ids}
                onChange={(ids) => set("occasion_ids", ids)}
              />
            </div>
          )}

          {/* Publish tab — edit only */}
          {tab === "publish" && isEdit && event && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Control where this event is published on your channels.
              </p>
              <EventPublicationPanel eventId={event.id} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          {tab !== "publish" && (
            <Button
              onClick={() => onSubmit({ ...form, additional_image_urls: additionalUrls })}
              disabled={!canSubmit}
            >
              {isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" />
                  {isEdit ? "Saving…" : "Creating…"}
                </>
              ) : isEdit ? (
                "Save Changes"
              ) : (
                "Create Event"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EventsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner } = useWorkspaceRole();
  // Mutations are owner-only on the server
  const canManageEvents = isOwner;

  // Filters & pagination
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, statusFilter]);

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [editEvent, setEditEvent] = useState<Event | null>(null);
  const [archiveEvent, setArchiveEvent] = useState<Event | null>(null);

  // Build API URL
  function buildUrl() {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (statusFilter && statusFilter !== "all") params.set("status", statusFilter);
    params.set("page", String(page));
    params.set("pageSize", String(DEFAULT_PAGE_SIZE));
    const qs = params.toString();
    return qs ? `/api/events?${qs}` : `/api/events`;
  }

  const eventsQueryKey = ["events-catalog", { q: debouncedQ, statusFilter, page }];

  const eventsQuery = useQuery({
    queryKey: eventsQueryKey,
    queryFn: () => apiFetch<EventsResponse>(buildUrl()),
  });

  const events = eventsQuery.data?.events ?? [];
  const total = eventsQuery.data?.total ?? 0;
  const totalPages = eventsQuery.data?.totalPages ?? 1;

  // Mutations
  type SubmitData = EventFormState & { additional_image_urls: string[] };

  const createMutation = useMutation({
    mutationFn: (data: SubmitData) =>
      apiFetch("/api/events", {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          description: data.description || null,
          starting_price_usd: data.starting_price_usd ? parseFloat(data.starting_price_usd) : 0,
          starting_price_aed: data.starting_price_aed ? parseFloat(data.starting_price_aed) : 0,
          status: data.status,
          main_image_url: data.main_image_url || null,
          additional_image_urls: data.additional_image_urls,
          occasion_ids: data.occasion_ids,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events-catalog"] });
      setCreateOpen(false);
      toast({ title: "Event created" });
    },
    onError: () => {
      toast({ title: "Failed to create event", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: SubmitData }) =>
      apiFetch(`/api/events/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: data.name,
          description: data.description || null,
          starting_price_usd: data.starting_price_usd ? parseFloat(data.starting_price_usd) : 0,
          starting_price_aed: data.starting_price_aed ? parseFloat(data.starting_price_aed) : 0,
          status: data.status,
          main_image_url: data.main_image_url || null,
          additional_image_urls: data.additional_image_urls,
          occasion_ids: data.occasion_ids,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events-catalog"] });
      setEditEvent(null);
      toast({ title: "Event updated" });
    },
    onError: () => {
      toast({ title: "Failed to update event", variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/events/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events-catalog"] });
      setArchiveEvent(null);
      toast({ title: "Event archived" });
    },
    onError: () => {
      toast({ title: "Failed to archive event", variant: "destructive" });
    },
  });

  // Pagination UI
  function renderPagination() {
    if (totalPages <= 1) return null;
    return (
      <div className="flex items-center justify-between mt-4">
        <p className="text-sm text-muted-foreground">
          {total} event{total !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setPage(1)} disabled={page <= 1}>
            <ChevronsLeft size={14} />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-sm px-2">{page} / {totalPages}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            <ChevronRight size={14} />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setPage(totalPages)} disabled={page >= totalPages}>
            <ChevronsRight size={14} />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays size={22} className="text-primary" />
            Events
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage bookable and scheduled events for your workspace.
          </p>
        </div>
        {canManageEvents && (
          <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus size={16} />
            New Event
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8 h-9 text-sm"
            placeholder="Search events…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36 h-9 text-sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="available">Available</SelectItem>
            <SelectItem value="unavailable">Unavailable</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      {eventsQuery.isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">Loading events…</span>
        </div>
      ) : eventsQuery.isError ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <p className="text-sm text-destructive">Failed to load events.</p>
          <Button variant="outline" size="sm" onClick={() => eventsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <CalendarDays size={28} className="text-muted-foreground" />
          </div>
          <div>
            <p className="text-base font-semibold">No events yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              {debouncedQ || statusFilter !== "all"
                ? "No events match your current filters."
                : "Create your first event to get started."}
            </p>
          </div>
          {canManageEvents && !debouncedQ && statusFilter === "all" && (
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus size={16} />
              New Event
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">Event</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs hidden sm:table-cell">Price (USD)</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs hidden md:table-cell">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs hidden lg:table-cell">Occasions</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs hidden xl:table-cell">Created</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((ev) => {
                  const thumbUrl = ev.image_public_path ?? ev.main_image_url;
                  const thumb = imageUrl(thumbUrl);
                  return (
                    <tr key={ev.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-md border border-border overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                            {thumb ? (
                              <img src={thumb} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <ImageIcon size={16} className="text-muted-foreground" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium leading-tight">{ev.name}</p>
                            {ev.description && (
                              <p className="text-xs text-muted-foreground line-clamp-1 max-w-xs mt-0.5">
                                {ev.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">
                        {ev.starting_price_usd ? formatUSD(parseFloat(ev.starting_price_usd)) : "—"}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {eventStatusBadge(ev.status)}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(ev.occasions ?? []).slice(0, 3).map((o) => (
                            <Badge key={o.id} variant="secondary" className="text-xs px-1.5 py-0">
                              {o.name}
                            </Badge>
                          ))}
                          {(ev.occasions ?? []).length > 3 && (
                            <Badge variant="secondary" className="text-xs px-1.5 py-0">
                              +{(ev.occasions ?? []).length - 3}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden xl:table-cell text-muted-foreground text-xs">
                        {new Date(ev.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canManageEvents && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-7 w-7">
                                <MoreHorizontal size={14} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditEvent(ev)}>
                                <Pencil size={14} className="mr-2" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setArchiveEvent(ev)}
                              >
                                <Archive size={14} className="mr-2" />
                                Archive
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {renderPagination()}
        </>
      )}

      {/* Create dialog */}
      <CreateEditEventDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={(data) => createMutation.mutate(data)}
        isPending={createMutation.isPending}
      />

      {/* Edit dialog */}
      <CreateEditEventDialog
        open={!!editEvent}
        onClose={() => setEditEvent(null)}
        event={editEvent}
        onSubmit={(data) => updateMutation.mutate({ id: editEvent!.id, data })}
        isPending={updateMutation.isPending}
      />

      {/* Archive confirmation */}
      <AlertDialog open={!!archiveEvent} onOpenChange={(o) => !o && setArchiveEvent(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive event?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{archiveEvent?.name}&rdquo; will be archived and removed from all active
              listings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => archiveEvent && archiveMutation.mutate(archiveEvent.id)}
              disabled={archiveMutation.isPending}
            >
              {archiveMutation.isPending ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" />
                  Archiving…
                </>
              ) : (
                "Archive"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
