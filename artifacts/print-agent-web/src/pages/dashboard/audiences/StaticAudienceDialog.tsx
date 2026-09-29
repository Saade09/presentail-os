import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateAudience,
  useAddAudienceMembers,
  useSnapshotAudienceMembers,
  useListAudiences,
  useListContacts,
  getListAudiencesQueryKey,
  getListContactsQueryKey,
  type Audience,
  type ContactListItem,
} from "@workspace/api-client-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDebounced } from "./useDebounced";

function contactLabel(c: ContactListItem): string {
  const display = (c.display_name ?? "").trim();
  if (display) return display;
  const n = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return n || c.email || c.phone || "Unnamed contact";
}

export default function StaticAudienceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (audience: Audience) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"contacts" | "snapshot">("contacts");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [snapshotFrom, setSnapshotFrom] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput, 300);
  const [busy, setBusy] = useState(false);

  const contactParams = { page: 1, limit: 25, ...(search ? { search } : {}) };
  const { data: contactsData, isLoading: contactsLoading } = useListContacts(contactParams, {
    query: {
      enabled: open && source === "contacts",
      queryKey: getListContactsQueryKey(contactParams),
    },
  });
  const dynParams = { kind: "dynamic" as const, limit: 100 };
  const { data: dynamicAudiences } = useListAudiences(dynParams, {
    query: {
      enabled: open && source === "snapshot",
      queryKey: getListAudiencesQueryKey(dynParams),
    },
  });
  const snapshotOptions = useMemo(
    () => (dynamicAudiences?.audiences ?? []).filter((a) => a.status !== "archived"),
    [dynamicAudiences],
  );

  const createMutation = useCreateAudience();
  const addMembers = useAddAudienceMembers();
  const snapshot = useSnapshotAudienceMembers();

  const reset = () => {
    setName("");
    setDescription("");
    setSelected(new Set());
    setSnapshotFrom("");
    setSearchInput("");
    setSource("contacts");
  };

  async function handleCreate() {
    if (!name.trim()) {
      toast({ title: "Give the audience a name first.", variant: "destructive" });
      return;
    }
    if (source === "contacts" && selected.size === 0) {
      toast({ title: "Select at least one contact.", variant: "destructive" });
      return;
    }
    if (source === "snapshot" && !snapshotFrom) {
      toast({ title: "Choose a dynamic audience to snapshot.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await createMutation.mutateAsync({
        data: { name: name.trim(), description: description.trim() || undefined, kind: "static", status: "active" },
      });
      const audience = res.audience;
      if (source === "contacts") {
        await addMembers.mutateAsync({ id: audience.id, data: { contact_ids: [...selected] } });
      } else {
        await snapshot.mutateAsync({ id: audience.id, data: { from_audience_id: snapshotFrom } });
      }
      void qc.invalidateQueries({ queryKey: [getListAudiencesQueryKey()[0]] });
      toast({ title: "Static audience created" });
      onCreated?.(audience);
      reset();
      onClose();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : "Failed to create audience", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto" data-testid="static-audience-dialog">
        <DialogHeader>
          <DialogTitle>New static audience</DialogTitle>
          <DialogDescription>
            A static audience is a fixed list — it never changes on its own. Snapshotting a dynamic
            audience copies its current members without converting the original.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="static-name">Name *</Label>
            <Input
              id="static-name"
              data-testid="input-static-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Event attendees — March"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="static-description">Description</Label>
            <Textarea
              id="static-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Start from</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSource("contacts")}
                className={cn(
                  "text-xs px-3 py-1.5 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  source === "contacts"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-secondary",
                )}
                data-testid="button-source-contacts"
              >
                Select contacts
              </button>
              <button
                type="button"
                onClick={() => setSource("snapshot")}
                className={cn(
                  "text-xs px-3 py-1.5 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  source === "snapshot"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-secondary",
                )}
                data-testid="button-source-snapshot"
              >
                Snapshot a dynamic audience
              </button>
            </div>
          </div>

          {source === "contacts" ? (
            <div className="space-y-2">
              <div className="relative">
                <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="ps-8"
                  placeholder="Search contacts…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  data-testid="input-static-contact-search"
                />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border divide-y">
                {contactsLoading ? (
                  <div className="flex justify-center py-6"><Spinner className="size-5" /></div>
                ) : (contactsData?.contacts ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No contacts found.</p>
                ) : (
                  (contactsData?.contacts ?? []).map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                    >
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(v) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(c.id);
                            else next.delete(c.id);
                            return next;
                          })
                        }
                        aria-label={`Select ${contactLabel(c)}`}
                      />
                      <span className="flex-1">{contactLabel(c)}</span>
                      <span className="text-xs text-muted-foreground">{c.email ?? c.phone ?? ""}</span>
                    </label>
                  ))
                )}
              </div>
              <p className="text-xs text-muted-foreground">{selected.size} selected</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Dynamic audience to snapshot</Label>
              <Select value={snapshotFrom} onValueChange={setSnapshotFrom}>
                <SelectTrigger data-testid="select-snapshot-source">
                  <SelectValue placeholder="Choose an audience…" />
                </SelectTrigger>
                <SelectContent>
                  {snapshotOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The dynamic audience keeps updating — only this new static copy is frozen.
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void handleCreate()} disabled={busy} data-testid="button-create-static">
            {busy ? "Creating…" : "Create static audience"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
