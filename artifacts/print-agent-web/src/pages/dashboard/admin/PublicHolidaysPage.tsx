import { useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  useListPublicHolidayCalendars,
  useCreatePublicHolidayCalendar,
  useUpdatePublicHolidayCalendar,
  useDeletePublicHolidayCalendar,
  useListPublicHolidays,
  useCreatePublicHoliday,
  useUpdatePublicHoliday,
  useDeletePublicHoliday,
  useAssignPublicHolidayCalendar,
  getListPublicHolidayCalendarsQueryKey,
  getListPublicHolidaysQueryKey,
} from "@workspace/api-client-react";
import type { PublicHolidayCalendar, PublicHolidayItem, NormalizedHolidayItem } from "@workspace/api-client-react";
import {
  Star,
  Plus,
  ChevronDown,
  ChevronUp,
  Edit,
  Trash2,
  UserCheck,
  Calendar,
  Download,
  Upload,
  Globe,
  Users,
  MapPin,
  CheckCircle2,
  SkipForward,
  AlertCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CountryCombobox } from "@/components/CountryCombobox";
import { getCountryMetadataByCode } from "@/lib/countries";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string) {
  const bare = dateStr.includes("T") ? dateStr.split("T")[0] : dateStr;
  return new Date(bare + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SourceBadge({ source }: { source?: string | null }) {
  if (!source || source === "Manual") return null;
  const cls =
    source === "Imported"
      ? "bg-blue-100 text-blue-700"
      : source === "CSV"
        ? "bg-purple-100 text-purple-700"
        : "bg-orange-100 text-orange-700";
  return (
    <Badge variant="secondary" className={`text-xs py-0 h-4 ${cls}`}>
      {source}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// HolidayRow — inline edit + delete for a single holiday
// ---------------------------------------------------------------------------

function HolidayRow({
  holiday,
  calendarId,
}: {
  holiday: PublicHolidayItem;
  calendarId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [name, setName] = useState(holiday.name);
  const [date, setDate] = useState(holiday.date);
  const [endDate, setEndDate] = useState(holiday.end_date ?? "");
  const [isPaid, setIsPaid] = useState(holiday.is_paid ?? true);

  const updateMutation = useUpdatePublicHoliday({
    mutation: {
      onSuccess: () => {
        toast({ title: "Holiday updated" });
        setEditOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidaysQueryKey(calendarId) });
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to update holiday";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeletePublicHoliday({
    mutation: {
      onSuccess: () => {
        toast({ title: "Holiday deleted" });
        setDeleteOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidaysQueryKey(calendarId) });
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to delete holiday";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const h = holiday as PublicHolidayItem & { type?: string; source?: string; status?: string };

  return (
    <>
      <div className="flex items-center gap-3 py-2 border-b last:border-0 hover:bg-muted/20 px-2 -mx-2 rounded group">
        <Star size={12} className="text-amber-500 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm">{holiday.name}</span>
          <span className="text-xs text-muted-foreground ml-2">
            {formatDate(holiday.date)}
            {holiday.end_date && holiday.end_date !== holiday.date && ` – ${formatDate(holiday.end_date)}`}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {holiday.is_paid && (
            <Badge variant="secondary" className="text-xs text-amber-700 bg-amber-100 py-0 h-4">
              paid
            </Badge>
          )}
          <SourceBadge source={h.source} />
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setEditOpen(true)}>
            <Edit size={11} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 size={11} />
          </Button>
        </div>
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit Holiday</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Date *</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>End date</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={date} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="edit-paid" checked={isPaid} onCheckedChange={setIsPaid} />
              <Label htmlFor="edit-paid">Paid holiday</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              onClick={() =>
                updateMutation.mutate({
                  id: calendarId,
                  holidayId: holiday.id,
                  data: { name, date, end_date: endDate || null, is_paid: isPaid },
                })
              }
              disabled={updateMutation.isPending || !name.trim() || !date}
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete holiday?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{holiday.name}</strong>. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate({ id: calendarId, holidayId: holiday.id })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// ImportDialog — 3-step: configure → preview/select → approve
// ---------------------------------------------------------------------------

interface SupportedCountry { code: string; name: string }
interface SupportedRegion  { code: string; name: string }

type ImportStep = "configure" | "preview" | "done";

function ImportDialog({
  open,
  onOpenChange,
  calendar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  calendar: PublicHolidayCalendar;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<ImportStep>("configure");
  const [countryCode, setCountryCode] = useState("");
  const [regionCode, setRegionCode] = useState("all");
  const [year, setYear] = useState(new Date().getFullYear());
  const [selectedTypes, setSelectedTypes] = useState<string[]>(["public"]);
  const [countries, setCountries] = useState<SupportedCountry[]>([]);
  const [regions, setRegions] = useState<SupportedRegion[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [previewHolidays, setPreviewHolidays] = useState<(NormalizedHolidayItem & { already_exists: boolean; _selected: boolean })[]>([]);
  const [insertedCount, setInsertedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);

  useEffect(() => {
    if (!open) return;
    loadCountries();
    const code = calendar.country_code;
    if (code) {
      const upper = code.toUpperCase();
      setCountryCode(upper);
      loadRegions(upper);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const TYPES = ["public", "bank", "school", "optional", "observance"];

  function toggleType(t: string) {
    setSelectedTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function loadCountries() {
    setLoadingCountries(true);
    try {
      const res = await apiFetch<{ countries: SupportedCountry[] }>("/api/public-holidays/import/countries");
      setCountries(res.countries ?? []);
    } catch {
      toast({ title: "Error", description: "Failed to load countries", variant: "destructive" });
    } finally {
      setLoadingCountries(false);
    }
  }

  async function loadRegions(cc: string) {
    setRegions([]);
    if (!cc) return;
    try {
      const res = await apiFetch<{ regions: SupportedRegion[] }>(
        `/api/public-holidays/import/regions/${cc}`,
      );
      setRegions(res.regions ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load regions";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      const res = await apiFetch<{ holidays: (NormalizedHolidayItem & { already_exists: boolean })[] }>(
        `/api/public-holidays/calendars/${calendar.id}/import/preview`,
        {
          method: "POST",
          body: JSON.stringify({
            countryCode,
            year,
            regionCode: regionCode === "all" ? null : regionCode || null,
            types: selectedTypes.length > 0 ? selectedTypes : null,
          }),
        },
      );
      setPreviewHolidays(
        (res.holidays ?? []).map((h) => ({ ...h, _selected: !h.already_exists })),
      );
      setStep("preview");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load preview";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  }

  async function handleApprove() {
    const toImport = previewHolidays.filter((h) => h._selected && !h.already_exists);
    if (toImport.length === 0) {
      toast({ title: "Nothing to import", description: "No new holidays selected." });
      return;
    }
    setApproving(true);
    try {
      const res = await apiFetch<{ inserted: number; skipped: number }>(
        `/api/public-holidays/calendars/${calendar.id}/import/approve`,
        {
          method: "POST",
          body: JSON.stringify({ holidays: toImport }),
        },
      );
      setInsertedCount(res.inserted ?? toImport.length);
      setSkippedCount(res.skipped ?? 0);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to import";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setApproving(false);
    }
  }

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      setStep("configure");
      setCountryCode("");
      setRegionCode("all");
      setYear(new Date().getFullYear());
      setSelectedTypes(["public"]);
      setPreviewHolidays([]);
      setCountries([]);
      setRegions([]);
    }, 300);
  }

  function toggleAll(val: boolean) {
    setPreviewHolidays((prev) =>
      prev.map((h) => ({ ...h, _selected: h.already_exists ? false : val })),
    );
  }

  const allNew = previewHolidays.filter((h) => !h.already_exists);
  const allSelected = allNew.length > 0 && allNew.every((h) => h._selected);
  const selectedCount = previewHolidays.filter((h) => h._selected && !h.already_exists).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe size={16} />
            Auto-Import Holidays — {calendar.name}
          </DialogTitle>
        </DialogHeader>

        {step === "configure" && (
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Country *</Label>
                <Select
                  value={countryCode}
                  onValueChange={(v) => {
                    setCountryCode(v);
                    setRegionCode("");
                    loadRegions(v);
                  }}
                  onOpenChange={(open) => {
                    if (open && countries.length === 0) loadCountries();
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={loadingCountries ? "Loading…" : "Select country…"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {countries.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Region / State</Label>
                <Select
                  value={regionCode}
                  onValueChange={setRegionCode}
                  disabled={regions.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={regions.length === 0 ? "None available" : "All regions"} />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="all">All regions</SelectItem>
                    {regions.map((r) => (
                      <SelectItem key={r.code} value={r.code}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Year</Label>
              <Input
                type="number"
                value={year}
                onChange={(e) => setYear(parseInt(e.target.value, 10))}
                min={2000}
                max={2100}
                className="w-32"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Holiday types to include</Label>
              <div className="flex flex-wrap gap-2">
                {TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleType(t)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      selectedTypes.includes(t)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {previewHolidays.length} holiday{previewHolidays.length !== 1 ? "s" : ""} found
                {allNew.length < previewHolidays.length && (
                  <span className="text-amber-600 ml-2">
                    ({previewHolidays.length - allNew.length} already exist)
                  </span>
                )}
              </span>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) => toggleAll(!!v)}
                />
                <span>Select all new</span>
              </label>
            </div>
            <ScrollArea className="h-72 border rounded-md">
              <div className="p-2 space-y-0.5">
                {previewHolidays.map((h, i) => (
                  <label
                    key={i}
                    className={`flex items-center gap-3 px-2 py-1.5 rounded cursor-pointer hover:bg-muted/40 ${
                      h.already_exists ? "opacity-50" : ""
                    }`}
                  >
                    <Checkbox
                      checked={h._selected}
                      disabled={h.already_exists}
                      onCheckedChange={(v) =>
                        setPreviewHolidays((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, _selected: !!v } : x,
                          ),
                        )
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{h.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">{formatDate(h.date)}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Badge variant="secondary" className="text-xs py-0 h-4 capitalize">
                        {h.type}
                      </Badge>
                      {h.already_exists && (
                        <Badge variant="secondary" className="text-xs py-0 h-4 bg-muted text-muted-foreground">
                          exists
                        </Badge>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </ScrollArea>
            <p className="text-xs text-muted-foreground">
              {selectedCount} of {allNew.length} new holidays selected for import.
            </p>
          </div>
        )}

        {step === "done" && (
          <div className="py-6 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 size={40} className="text-green-500" />
            <p className="font-semibold text-lg">Import complete</p>
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1.5 text-green-700">
                <CheckCircle2 size={14} />
                {insertedCount} imported
              </span>
              {skippedCount > 0 && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <SkipForward size={14} />
                  {skippedCount} skipped
                </span>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "configure" && (
            <>
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={handlePreview}
                disabled={!countryCode || previewing || selectedTypes.length === 0}
              >
                {previewing ? "Loading…" : "Preview Holidays"}
              </Button>
            </>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("configure")}>Back</Button>
              <Button onClick={handleApprove} disabled={approving || selectedCount === 0}>
                {approving ? "Importing…" : `Import ${selectedCount} Holiday${selectedCount !== 1 ? "s" : ""}`}
              </Button>
            </>
          )}
          {step === "done" && (
            <Button onClick={handleClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CsvImportDialog — upload CSV → preview → approve
// ---------------------------------------------------------------------------

function CsvImportDialog({
  open,
  onOpenChange,
  calendar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  calendar: PublicHolidayCalendar;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  type CsvRow = { name: string; date: string; type: string | null; is_paid: boolean; notes: string | null; already_exists: boolean; _selected: boolean };

  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const [uploading, setUploading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [inserted, setInserted] = useState(0);
  const [skipped, setSkipped] = useState(0);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await apiFetch<{ holidays: CsvRow[]; errors: string[] }>(
        `/api/public-holidays/calendars/${calendar.id}/import-csv`,
        { method: "POST", body: form },
      );
      setRows((res.holidays ?? []).map((r) => ({ ...r, _selected: !r.already_exists })));
      setErrors(res.errors ?? []);
      setStep("preview");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleApprove() {
    const toImport = rows.filter((r) => r._selected && !r.already_exists);
    if (toImport.length === 0) { toast({ title: "Nothing to import" }); return; }
    setApproving(true);
    try {
      const res = await apiFetch<{ inserted: number; skipped: number }>(
        `/api/public-holidays/calendars/${calendar.id}/import/approve`,
        { method: "POST", body: JSON.stringify({ holidays: toImport.map((r) => ({ ...r, source: "CSV" })) }) },
      );
      setInserted(res.inserted ?? toImport.length);
      setSkipped(res.skipped ?? 0);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Import failed";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setApproving(false);
    }
  }

  function handleClose() {
    onOpenChange(false);
    setTimeout(() => {
      setStep("upload");
      setRows([]);
      setErrors([]);
    }, 300);
  }

  const allNew = rows.filter((r) => !r.already_exists);
  const selectedCount = rows.filter((r) => r._selected && !r.already_exists).length;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload size={16} />
            Import from CSV — {calendar.name}
          </DialogTitle>
        </DialogHeader>

        {step === "upload" && (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Upload a CSV file with columns: <code className="bg-muted px-1 rounded">holiday_name</code>,{" "}
              <code className="bg-muted px-1 rounded">date</code> (YYYY-MM-DD). Optional:{" "}
              <code className="bg-muted px-1 rounded">observed_date</code>,{" "}
              <code className="bg-muted px-1 rounded">type</code>,{" "}
              <code className="bg-muted px-1 rounded">is_paid</code>,{" "}
              <code className="bg-muted px-1 rounded">notes</code>.
            </p>
            <div
              className="border-2 border-dashed rounded-lg p-8 flex flex-col items-center gap-3 cursor-pointer hover:border-primary/60 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={28} className="text-muted-foreground" />
              <p className="text-sm font-medium">{uploading ? "Uploading…" : "Click to select CSV file"}</p>
              <p className="text-xs text-muted-foreground">Max 5 MB</p>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {step === "preview" && (
          <div className="space-y-3">
            {errors.length > 0 && (
              <div className="bg-destructive/10 rounded p-3 space-y-1">
                <p className="text-xs font-semibold text-destructive flex items-center gap-1">
                  <AlertCircle size={12} /> Parse warnings
                </p>
                {errors.map((e, i) => (
                  <p key={i} className="text-xs text-destructive">{e}</p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {rows.length} row{rows.length !== 1 ? "s" : ""} found
              </span>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={allNew.length > 0 && allNew.every((r) => r._selected)}
                  onCheckedChange={(v) => setRows((prev) => prev.map((r) => ({ ...r, _selected: r.already_exists ? false : !!v })))}
                />
                <span>Select all new</span>
              </label>
            </div>
            <ScrollArea className="h-64 border rounded-md">
              <div className="p-2 space-y-0.5">
                {rows.map((r, i) => (
                  <label key={i} className={`flex items-center gap-3 px-2 py-1.5 rounded cursor-pointer hover:bg-muted/40 ${r.already_exists ? "opacity-50" : ""}`}>
                    <Checkbox
                      checked={r._selected}
                      disabled={r.already_exists}
                      onCheckedChange={(v) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, _selected: !!v } : x))}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">{formatDate(r.date)}</span>
                    </div>
                    {r.already_exists && (
                      <Badge variant="secondary" className="text-xs py-0 h-4 text-muted-foreground">exists</Badge>
                    )}
                  </label>
                ))}
              </div>
            </ScrollArea>
            <p className="text-xs text-muted-foreground">{selectedCount} of {allNew.length} new rows selected.</p>
          </div>
        )}

        {step === "done" && (
          <div className="py-6 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 size={40} className="text-green-500" />
            <p className="font-semibold text-lg">CSV import complete</p>
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1.5 text-green-700"><CheckCircle2 size={14} />{inserted} imported</span>
              {skipped > 0 && <span className="flex items-center gap-1.5 text-muted-foreground"><SkipForward size={14} />{skipped} skipped</span>}
            </div>
          </div>
        )}

        <DialogFooter>
          {step === "upload" && <Button variant="outline" onClick={handleClose}>Cancel</Button>}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => { setStep("upload"); setRows([]); setErrors([]); }}>Back</Button>
              <Button onClick={handleApprove} disabled={approving || selectedCount === 0}>
                {approving ? "Importing…" : `Import ${selectedCount} row${selectedCount !== 1 ? "s" : ""}`}
              </Button>
            </>
          )}
          {step === "done" && <Button onClick={handleClose}>Done</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// AssignDialog — scope selector + dry-run
// ---------------------------------------------------------------------------

type AssignScope = "all" | "individual" | "by_location" | "by_country" | "by_department";

function AssignDialog({
  open,
  onOpenChange,
  calendar,
  calendarCountryCode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  calendar: PublicHolidayCalendar;
  calendarCountryCode?: string; // ISO alpha-2 uppercase — locked source of truth for by_country
}) {
  const { toast } = useToast();

  const assignMutation = useAssignPublicHolidayCalendar({
    mutation: {
      onSuccess: (data) => {
        const res = data as { ok: boolean; assigned?: number; dry_run?: boolean; affected_count?: number };
        if (res.dry_run) {
          toast({
            title: "Dry run complete",
            description: `${res.affected_count ?? 0} member${res.affected_count !== 1 ? "s" : ""} would be assigned.`,
          });
        } else {
          toast({ title: `Assigned to ${res.assigned ?? 0} member${res.assigned !== 1 ? "s" : ""}` });
          onOpenChange(false);
        }
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to assign";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const [scope, setScope] = useState<AssignScope>("all");
  const [filterValue, setFilterValue] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  // Auto-wire by_country scope: lock filterValue to the calendar's stored country code
  useEffect(() => {
    if (scope === "by_country" && calendarCountryCode) {
      setFilterValue(calendarCountryCode);
    }
  }, [scope, calendarCountryCode]); // eslint-disable-line react-hooks/exhaustive-deps

  function getScopeApiValue(): "all" | "individual" | "by_location" | "by_country" | "by_department" {
    return scope;
  }

  const scopeNeedsFilter = scope !== "all";

  function handleAssign(dry = false) {
    assignMutation.mutate({
      id: calendar.id,
      data: {
        scope: getScopeApiValue(),
        effectiveFrom,
        filterValue: scopeNeedsFilter ? filterValue || undefined : undefined,
        dryRun: dry,
      },
    });
  }

  const scopeIcons: Record<AssignScope, React.ReactNode> = {
    all: <Users size={14} />,
    individual: <UserCheck size={14} />,
    by_location: <MapPin size={14} />,
    by_country: <Globe size={14} />,
    by_department: <Users size={14} />,
  };

  const scopeLabels: Record<AssignScope, string> = {
    all: "All members",
    individual: "Specific member IDs",
    by_location: "By location",
    by_country: "By country",
    by_department: "By department",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck size={16} />
            Assign Calendar
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            Assign <strong>{calendar.name}</strong> to members so they see these holidays on their calendar.
          </p>

          <div className="space-y-1.5">
            <Label>Assign scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => {
                const newScope = v as AssignScope;
                setScope(newScope);
                // Lock by_country to the calendar's stored country code; clear for all other scopes
                setFilterValue(newScope === "by_country" && calendarCountryCode ? calendarCountryCode : "");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(scopeLabels) as AssignScope[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      {scopeIcons[s]}
                      {scopeLabels[s]}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {scope === "individual" && (
            <div className="space-y-1.5">
              <Label>Member IDs (comma-separated)</Label>
              <Input
                value={filterValue}
                onChange={(e) => setFilterValue(e.target.value)}
                placeholder="e.g. 12, 34, 56"
              />
            </div>
          )}
          {scope === "by_location" && (
            <div className="space-y-1.5">
              <Label>Location ID</Label>
              <Input value={filterValue} onChange={(e) => setFilterValue(e.target.value)} placeholder="e.g. 3" />
            </div>
          )}
          {scope === "by_country" && (
            <div className="space-y-1.5">
              <Label>Country</Label>
              {calendarCountryCode ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
                  <span aria-hidden>
                    {calendarCountryCode.toUpperCase().split("").map((c) =>
                      String.fromCodePoint(0x1f1e6 - 0x41 + c.charCodeAt(0))
                    ).join("")}
                  </span>
                  <span>{getCountryMetadataByCode(calendarCountryCode)?.name ?? calendarCountryCode}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{calendarCountryCode}</span>
                </div>
              ) : (
                <Input
                  value={filterValue}
                  onChange={(e) => setFilterValue(e.target.value)}
                  placeholder="Country code (e.g. LB)"
                />
              )}
            </div>
          )}
          {scope === "by_department" && (
            <div className="space-y-1.5">
              <Label>Department name</Label>
              <Input value={filterValue} onChange={(e) => setFilterValue(e.target.value)} placeholder="e.g. Engineering" />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Effective from</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="secondary" onClick={() => handleAssign(true)} disabled={assignMutation.isPending}>
            Dry run
          </Button>
          <Button onClick={() => handleAssign(false)} disabled={assignMutation.isPending}>
            {assignMutation.isPending ? "Assigning…" : "Assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// HolidaysPanel — the expanded section below a calendar card
// ---------------------------------------------------------------------------

function HolidaysPanel({ calendar }: { calendar: PublicHolidayCalendar }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useListPublicHolidays(calendar.id);
  const holidays: PublicHolidayItem[] = data?.holidays ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isPaid, setIsPaid] = useState(true);

  const addMutation = useCreatePublicHoliday({
    mutation: {
      onSuccess: () => {
        toast({ title: "Holiday added" });
        setAddOpen(false);
        setName(""); setDate(""); setEndDate(""); setIsPaid(true);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidaysQueryKey(calendar.id) });
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to add holiday";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Holidays ({holidays.length})
        </p>
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-1" onClick={() => setAddOpen(true)}>
          <Plus size={11} />
          Add holiday
        </Button>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!isLoading && holidays.length === 0 && (
        <p className="text-sm text-muted-foreground italic">No holidays added yet. Add manually or use Import above.</p>
      )}
      {!isLoading && holidays.length > 0 && (
        <div>{holidays.map((h) => <HolidayRow key={h.id} holiday={h} calendarId={calendar.id} />)}</div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add Holiday</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Year's Day" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Date *</Label>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>End date</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={date} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="add-paid" checked={isPaid} onCheckedChange={setIsPaid} />
              <Label htmlFor="add-paid">Paid holiday</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addMutation.mutate({ id: calendar.id, data: { name, date, end_date: endDate || null, is_paid: isPaid } })}
              disabled={addMutation.isPending || !name.trim() || !date}
            >
              {addMutation.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarCard — enriched stats + Import / CSV / Assign / Export actions
// ---------------------------------------------------------------------------

type EnrichedCalendar = PublicHolidayCalendar & {
  holiday_count?: number;
  assigned_count?: number;
  next_holiday?: { name: string; date: string | null } | null;
  source?: string | null;
};

function CalendarCard({ calendar }: { calendar: EnrichedCalendar }) {
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner } = useWorkspaceRole();

  const [editName, setEditName] = useState(calendar.name);
  const [editIsActive, setEditIsActive] = useState(calendar.is_active ?? true);

  const updateMutation = useUpdatePublicHolidayCalendar({
    mutation: {
      onSuccess: () => {
        toast({ title: "Calendar updated" });
        setEditOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to update calendar";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeletePublicHolidayCalendar({
    mutation: {
      onSuccess: () => {
        toast({ title: "Calendar deleted" });
        setDeleteOpen(false);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to delete calendar";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  function handleExport() {
    window.open(`/api/public-holidays/calendars/${calendar.id}/export-csv`, "_blank");
    toast({ title: "CSV download started" });
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-start gap-4 p-4 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
      >
        <Calendar size={16} className="text-muted-foreground flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{calendar.name}</span>
            {calendar.country_code && (() => {
              const meta = getCountryMetadataByCode(calendar.country_code);
              return (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {meta?.flagEmoji && <span aria-hidden>{meta.flagEmoji}</span>}
                  <span>{meta?.name ?? calendar.country_code}</span>
                </span>
              );
            })()}
            {!(calendar.is_active ?? true) && (
              <Badge variant="secondary" className="text-xs text-muted-foreground py-0 h-4">Inactive</Badge>
            )}
            <SourceBadge source={calendar.source} />
          </div>
          {/* Stats row */}
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            {calendar.location_name && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin size={10} />{calendar.location_name}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {calendar.holiday_count ?? 0} holiday{(calendar.holiday_count ?? 0) !== 1 ? "s" : ""} this year
            </span>
            <span className="text-xs text-muted-foreground">
              {calendar.assigned_count ?? 0} member{(calendar.assigned_count ?? 0) !== 1 ? "s" : ""} assigned
            </span>
            {calendar.next_holiday && (
              <span className="text-xs text-muted-foreground">
                Next: <span className="font-medium">{calendar.next_holiday.name}</span>
                {calendar.next_holiday.date && ` (${formatDate(calendar.next_holiday.date)})`}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => { setEditName(calendar.name); setEditIsActive(calendar.is_active ?? true); setEditOpen(true); }}>
            <Edit size={11} className="mr-1" />Edit
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setImportOpen(true)}>
            <Globe size={11} className="mr-1" />Import
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCsvOpen(true)}>
            <Upload size={11} className="mr-1" />CSV
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={handleExport}>
            <Download size={11} className="mr-1" />Export
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAssignOpen(true)}>
            <UserCheck size={11} className="mr-1" />Assign
          </Button>
          {isOwner && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteOpen(true)}
              title="Delete calendar"
            >
              <Trash2 size={13} />
            </Button>
          )}
          {expanded ? <ChevronUp size={14} className="ml-1" /> : <ChevronDown size={14} className="ml-1" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t px-4 py-4">
          <HolidaysPanel calendar={calendar} />
        </div>
      )}

      {/* Edit Calendar dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit Calendar</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="edit-active" checked={editIsActive} onCheckedChange={setEditIsActive} />
              <Label htmlFor="edit-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              onClick={() => updateMutation.mutate({ id: calendar.id, data: { name: editName, is_active: editIsActive } })}
              disabled={updateMutation.isPending || !editName.trim()}
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} calendar={calendar} />
      <CsvImportDialog open={csvOpen} onOpenChange={setCsvOpen} calendar={calendar} />
      <AssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        calendar={calendar}
        calendarCountryCode={calendar.country_code?.toUpperCase() ?? undefined}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete calendar?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This will permanently delete <strong>{calendar.name}</strong> along with all its
                  holidays and member assignments.
                </p>
                {(calendar.assigned_count ?? 0) > 0 && (
                  <p className="text-amber-700 font-medium">
                    {calendar.assigned_count} member{(calendar.assigned_count ?? 0) !== 1 ? "s are" : " is"} currently
                    assigned to this calendar and will lose their assignment.
                  </p>
                )}
                <p>This action cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteMutation.mutate({ id: calendar.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete Calendar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PublicHolidaysPage — main page
// ---------------------------------------------------------------------------

export default function PublicHolidaysPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useListPublicHolidayCalendars();
  const calendars = (data?.calendars ?? []) as EnrichedCalendar[];

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCountryCode, setCreateCountryCode] = useState(""); // ISO alpha-2 lowercase
  const [nameAutoFilled, setNameAutoFilled] = useState(false);
  const [createCountryTouched, setCreateCountryTouched] = useState(false);

  // Auto-fill calendar name when country is selected (preserve manual edits)
  useEffect(() => {
    if (!createOpen) return;
    if (createCountryCode) {
      const meta = getCountryMetadataByCode(createCountryCode);
      if (meta) {
        const autoName = `${meta.name} Public Holidays`;
        if (!createName || nameAutoFilled) {
          setCreateName(autoName);
          setNameAutoFilled(true);
        }
      }
    } else if (nameAutoFilled) {
      setCreateName("");
      setNameAutoFilled(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createCountryCode]);

  // Check for an existing calendar with the same country
  const duplicateCalendar = createCountryCode
    ? calendars.find(
        (c) =>
          c.country_code &&
          c.country_code.toLowerCase() === createCountryCode.toLowerCase(),
      )
    : null;

  const createMutation = useCreatePublicHolidayCalendar({
    mutation: {
      onSuccess: () => {
        toast({ title: "Calendar created" });
        setCreateOpen(false);
        setCreateName("");
        setCreateCountryCode("");
        setNameAutoFilled(false);
        queryClient.invalidateQueries({ queryKey: getListPublicHolidayCalendarsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to create calendar";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const totalHolidays = calendars.reduce((s, c) => s + (c.holiday_count ?? 0), 0);
  const totalAssigned = calendars.reduce((s, c) => s + (c.assigned_count ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Star size={22} />
            Public Holidays
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage holiday calendars and assign them to your team.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2">
          <Plus size={15} />
          New Calendar
        </Button>
      </div>

      {/* Stats cards — only when we have data */}
      {!isLoading && calendars.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Calendar size={20} className="text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{calendars.length}</p>
                <p className="text-xs text-muted-foreground">Calendar{calendars.length !== 1 ? "s" : ""}</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Star size={20} className="text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{totalHolidays}</p>
                <p className="text-xs text-muted-foreground">Holidays this year</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <Users size={20} className="text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{totalAssigned}</p>
                <p className="text-xs text-muted-foreground">Member assignments</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Content */}
      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">Loading calendars…</div>
      )}
      {error && (
        <div className="text-center py-12 text-destructive">Failed to load calendars</div>
      )}
      {!isLoading && !error && calendars.length === 0 && (
        <Card>
          <CardContent className="py-14 flex flex-col items-center gap-4 text-muted-foreground">
            <Star size={40} className="text-amber-400" />
            <div className="text-center">
              <p className="font-semibold text-foreground text-lg">No holiday calendars yet</p>
              <p className="text-sm mt-1">Create a calendar, import from 100+ countries, or upload a CSV.</p>
            </div>
            <div className="flex items-center gap-3 mt-2">
              <Button onClick={() => setCreateOpen(true)} className="gap-2">
                <Plus size={14} />
                Create Calendar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {!isLoading && calendars.length > 0 && (
        <div className="space-y-3">
          {calendars.map((c) => (
            <CalendarCard key={c.id} calendar={c} />
          ))}
        </div>
      )}

      {/* Create Calendar dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateName("");
            setCreateCountryCode("");
            setNameAutoFilled(false);
            setCreateCountryTouched(false);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Holiday Calendar</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Country *</Label>
              <CountryCombobox
                value={createCountryCode}
                onChange={(v) => {
                  setCreateCountryCode(v);
                  setCreateCountryTouched(true);
                }}
              />
              {createCountryTouched && !createCountryCode && (
                <p className="text-xs text-destructive">Please select a country.</p>
              )}
            </div>
            {duplicateCalendar && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-600" />
                <span>
                  A holiday calendar for this country already exists:{" "}
                  <strong>{duplicateCalendar.name}</strong>
                </span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Calendar name *</Label>
              <Input
                value={createName}
                onChange={(e) => {
                  setCreateName(e.target.value);
                  setNameAutoFilled(false);
                }}
                placeholder="e.g. Lebanon Public Holidays"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={() =>
                createMutation.mutate({
                  data: {
                    name: createName,
                    country_code: createCountryCode.toUpperCase(),
                    is_active: true,
                  },
                })
              }
              disabled={
                createMutation.isPending ||
                !createName.trim() ||
                !createCountryCode ||
                !!duplicateCalendar
              }
            >
              {createMutation.isPending ? "Creating…" : "Create Calendar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
