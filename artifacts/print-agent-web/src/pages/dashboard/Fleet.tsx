import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Truck, Plus, Pencil, Ban, RefreshCw, KeyRound, Copy, CheckCircle2, Settings as SettingsIcon, ChevronsUpDown } from "lucide-react";
import { Link } from "wouter";
import { getCountries, isValidPhoneNumber, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { isExcludedCountry } from "@/lib/countries";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Vehicle type strings — the controlled list now lives in the
// `fleet_vehicle_types` DB table and is fetched at runtime via
// `GET /api/fleet/vehicle-types`. The hardcoded fallback below is only used
// before the API call resolves.
const VEHICLE_TYPE_FALLBACK = [
  "Motorcycle",
  "Car",
  "Van",
  "Truck",
  "Bicycle",
  "Walking/Other",
] as const;
type VehicleType = string;

const DRIVER_STATUSES = ["active", "inactive", "on_duty", "off_duty"] as const;
type DriverStatus = (typeof DRIVER_STATUSES)[number];

const STATUS_LABELS: Record<DriverStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  on_duty: "On Duty",
  off_duty: "Off Duty",
};

const ALLOWED_COUNTRIES: Country[] = getCountries().filter((c) => !isExcludedCountry(c));

const STATUS_VARIANTS: Record<DriverStatus, "default" | "secondary" | "destructive" | "outline"> =
  {
    active: "default",
    on_duty: "default",
    off_duty: "secondary",
    inactive: "outline",
  };

type Driver = {
  id: number;
  first_name: string;
  last_name: string;
  phone: string | null;
  taxi_company: string | null;
  vehicle_type: VehicleType;
  license_number: string | null;
  status: DriverStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  onboarding_status?: "pending" | "approved" | "rejected" | "deactivated";
  availability_status?: "online" | "offline" | "busy";
};

function TokenRevealDialog({
  token,
  onClose,
}: {
  token: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!token} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Driver API token</DialogTitle>
          <DialogDescription>
            This token is shown only once. The driver uses it to sign in to the Fleet App.
            Copy and share it through a secure channel — we cannot show it again.
          </DialogDescription>
        </DialogHeader>
        {token && (
          <div className="space-y-3">
            <pre className="bg-muted/50 border rounded-md p-3 text-xs font-mono break-all whitespace-pre-wrap">
              {token}
            </pre>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(token);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <CheckCircle2 className="size-3.5 mr-1.5" /> : <Copy className="size-3.5 mr-1.5" />}
              {copied ? "Copied" : "Copy token"}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type DriverForm = {
  first_name: string;
  last_name: string;
  phone: string;
  country_code: string;
  taxi_company: string;
  vehicle_type: VehicleType;
  license_number: string;
  notes: string;
  status: DriverStatus;
};

const EMPTY_FORM: DriverForm = {
  first_name: "",
  last_name: "",
  phone: "",
  country_code: "+961",
  taxi_company: "",
  vehicle_type: "Car",
  license_number: "",
  notes: "",
  status: "active",
};

function TaxiCompanyCombobox({
  value,
  onChange,
  open: dialogOpen,
}: {
  value: string;
  onChange: (val: string) => void;
  open: boolean;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);

  const { data } = useQuery<{ taxi_companies: string[] }>({
    queryKey: ["fleet-taxi-companies"],
    queryFn: () => apiFetch("/api/fleet/taxi-companies"),
    enabled: dialogOpen,
  });

  const suggestions = data?.taxi_companies ?? [];

  const trimmed = inputValue.trim();
  const hasExactMatch = suggestions.some(
    (s) => s.toLowerCase() === trimmed.toLowerCase(),
  );
  const showAddOption = trimmed.length > 0 && !hasExactMatch;

  const filtered = suggestions.filter((s) =>
    s.toLowerCase().includes(trimmed.toLowerCase()),
  );

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const select = (val: string) => {
    onChange(val);
    setInputValue(val);
    setPopoverOpen(false);
  };

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={popoverOpen}
          className="w-full justify-between font-normal h-9 px-3"
          type="button"
        >
          <span className={value ? "text-foreground" : "text-muted-foreground"}>
            {value || "Search or add…"}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Type to search or add…"
            value={inputValue}
            onValueChange={(v) => {
              setInputValue(v);
              onChange(v);
            }}
          />
          <CommandList>
            {filtered.length === 0 && !showAddOption && (
              <CommandEmpty>No taxi companies found.</CommandEmpty>
            )}
            {filtered.length > 0 && (
              <CommandGroup>
                {filtered.map((s) => (
                  <CommandItem key={s} value={s} onSelect={() => select(s)}>
                    {s}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showAddOption && (
              <CommandGroup>
                <CommandItem
                  value={`__add__${trimmed}`}
                  onSelect={() => select(trimmed)}
                >
                  Add &ldquo;{trimmed}&rdquo;
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^+0-9]/g, "");
}

function DriverFormDialog({
  open,
  onClose,
  editDriver,
  existingDrivers,
}: {
  open: boolean;
  onClose: () => void;
  editDriver: Driver | null;
  existingDrivers: Driver[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<DriverForm>(
    editDriver
      ? {
          first_name: editDriver.first_name,
          last_name: editDriver.last_name,
          phone: editDriver.phone ?? "",
          country_code: (editDriver as Driver & { country_code?: string }).country_code ?? "+961",
          taxi_company: editDriver.taxi_company ?? "",
          vehicle_type: editDriver.vehicle_type,
          license_number: editDriver.license_number ?? "",
          notes: editDriver.notes ?? "",
          status: editDriver.status,
        }
      : EMPTY_FORM,
  );
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const isEdit = editDriver !== null;

  // Vehicle types come from the controlled DB list, with a fallback so the
  // dropdown is always populated.
  const { data: vehicleTypesData } = useQuery<{
    vehicle_types: { id: number; name: string; is_active: boolean }[];
  }>({
    queryKey: ["fleet-vehicle-types"],
    queryFn: () => apiFetch("/api/fleet/vehicle-types"),
    enabled: open,
  });
  const vehicleTypeOptions =
    vehicleTypesData?.vehicle_types?.filter((t) => t.is_active).map((t) => t.name) ??
    [...VEHICLE_TYPE_FALLBACK];

  useEffect(() => {
    if (!open) return;
    setForm(
      editDriver
        ? {
            first_name: editDriver.first_name,
            last_name: editDriver.last_name,
            phone: editDriver.phone ?? "",
            country_code:
              (editDriver as Driver & { country_code?: string }).country_code ?? "+961",
            taxi_company: editDriver.taxi_company ?? "",
            vehicle_type: editDriver.vehicle_type,
            license_number: editDriver.license_number ?? "",
            notes: editDriver.notes ?? "",
            status: editDriver.status,
          }
        : EMPTY_FORM,
    );
    setPhoneError(null);
  }, [open, editDriver]);

  const { mutate, isPending } = useMutation({
    mutationFn: async (data: DriverForm) => {
      const body = {
        first_name: data.first_name.trim(),
        last_name: data.last_name.trim(),
        phone: data.phone.trim(),
        country_code: data.country_code || "+961",
        taxi_company: data.taxi_company.trim() || null,
        vehicle_type: data.vehicle_type,
        license_number: data.license_number.trim() || null,
        notes: data.notes.trim() || null,
        ...(isEdit ? { status: data.status } : {}),
      };
      if (isEdit) {
        return apiFetch(`/api/fleet/drivers/${editDriver!.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      }
      return apiFetch("/api/fleet/drivers", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fleet-drivers"] });
      queryClient.invalidateQueries({ queryKey: ["fleet-taxi-companies"] });
      toast({
        title: isEdit ? "Driver updated" : "Driver created",
        description: isEdit
          ? `${form.first_name} ${form.last_name} has been updated.`
          : "Driver created successfully. They can now log in to the driver app using their phone number.",
      });
      onClose();
    },
    onError: (err: unknown) => {
      const apiErr = err as Error & { status?: number; code?: string };
      if (apiErr.status === 409 || apiErr.code === "DUPLICATE_PHONE") {
        setPhoneError("A driver with this phone number already exists.");
        return;
      }
      toast({
        title: isEdit ? "Failed to update driver" : "Failed to create driver",
        variant: "destructive",
      });
    },
  });

  const field = (key: keyof DriverForm) => ({
    value: form[key] as string,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const canSubmit = form.first_name.trim() && form.last_name.trim() && form.phone.trim();

  const handleSubmit = () => {
    const trimmedPhone = form.phone.trim();
    if (!trimmedPhone) {
      setPhoneError("Phone is required.");
      return;
    }
    if (!isValidPhoneNumber(trimmedPhone)) {
      setPhoneError("Please enter a valid phone number.");
      return;
    }
    // Client-side duplicate phone check (fast feedback before hitting the server).
    // For edits, exclude the driver currently being edited.
    if (trimmedPhone) {
      const normalized = normalizePhone(trimmedPhone);
      const duplicate = existingDrivers.find(
        (d) =>
          d.phone &&
          normalizePhone(d.phone) === normalized &&
          (!editDriver || d.id !== editDriver.id),
      );
      if (duplicate) {
        setPhoneError("A driver with this phone number already exists.");
        return;
      }
    }
    setPhoneError(null);
    mutate(form);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Driver" : "Add Driver"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update driver information." : "Add a new driver to the fleet."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fleet-first-name">First name *</Label>
              <Input id="fleet-first-name" placeholder="e.g. Ahmed" {...field("first_name")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fleet-last-name">Last name *</Label>
              <Input id="fleet-last-name" placeholder="e.g. Hassan" {...field("last_name")} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fleet-phone">Phone *</Label>
              <PhoneInputField
                id="fleet-phone"
                international
                countryCallingCodeEditable={false}
                defaultCountry={form.phone ? undefined : "LB"}
                countries={ALLOWED_COUNTRIES}
                value={form.phone || undefined}
                onChange={(val) => {
                  setForm((f) => ({ ...f, phone: val ?? "" }));
                  if (phoneError) setPhoneError(null);
                }}
                data-testid="input-fleet-phone"
              />
              {phoneError && (
                <p className="text-xs text-destructive" data-testid="phone-error">{phoneError}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Taxi Company</Label>
              <TaxiCompanyCombobox
                value={form.taxi_company}
                onChange={(val) => setForm((f) => ({ ...f, taxi_company: val }))}
                open={open}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Vehicle type *</Label>
              <Select
                value={form.vehicle_type}
                onValueChange={(v) => setForm((f) => ({ ...f, vehicle_type: v as VehicleType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vehicleTypeOptions.map((vt) => (
                    <SelectItem key={vt} value={vt}>
                      {vt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fleet-license">License number</Label>
              <Input
                id="fleet-license"
                placeholder="e.g. DXB-12345"
                {...field("license_number")}
              />
            </div>
          </div>
          {isEdit && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v as DriverStatus }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DRIVER_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="fleet-notes">Notes</Label>
            <Input id="fleet-notes" placeholder="Any additional notes…" {...field("notes")} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save changes" : "Add driver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeactivateDialog({
  driver,
  onClose,
}: {
  driver: Driver | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { mutate, isPending } = useMutation({
    mutationFn: () => apiFetch(`/api/fleet/drivers/${driver!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fleet-drivers"] });
      toast({ title: "Driver deactivated" });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to deactivate driver", variant: "destructive" });
    },
  });

  return (
    <Dialog
      open={!!driver}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate driver?</DialogTitle>
          <DialogDescription>
            {driver
              ? `${driver.first_name} ${driver.last_name} will be marked as inactive and removed from future assignments.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => mutate()} disabled={isPending}>
            {isPending ? "Deactivating…" : "Deactivate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FleetPage() {
  const { realIsOwner } = useWorkspaceRole();
  const [formOpen, setFormOpen] = useState(false);
  const [editDriver, setEditDriver] = useState<Driver | null>(null);
  const [deactivateDriver, setDeactivateDriver] = useState<Driver | null>(null);
  const [statusFilter, setStatusFilter] = useState<DriverStatus | "all">("all");
  const [taxiCompanyFilter, setTaxiCompanyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const { toast } = useToast();

  const approveMutation = useMutation({
    mutationFn: async (id: number) =>
      apiFetch<{ success: boolean; token: string | null }>(
        `/api/fleet/drivers/${id}/onboarding-status`,
        { method: "PATCH", body: JSON.stringify({ onboarding_status: "approved" }) },
      ),
    onSuccess: (resp) => {
      queryClient.invalidateQueries({ queryKey: ["fleet-drivers"] });
      if (resp?.token) setRevealedToken(resp.token);
      else toast({ title: "Driver approved" });
    },
    onError: () => toast({ title: "Failed to approve driver", variant: "destructive" }),
  });

  const rotateTokenMutation = useMutation({
    mutationFn: async (id: number) =>
      apiFetch<{ success: boolean; token: string }>(
        `/api/fleet/drivers/${id}/rotate-token`,
        { method: "POST" },
      ),
    onSuccess: (resp) => {
      if (resp?.token) setRevealedToken(resp.token);
    },
    onError: () => toast({ title: "Failed to issue token", variant: "destructive" }),
  });

  const { data: taxiCompaniesData } = useQuery<{ taxi_companies: string[] }>({
    queryKey: ["fleet-taxi-companies"],
    queryFn: () => apiFetch("/api/fleet/taxi-companies"),
  });
  const taxiCompanies = taxiCompaniesData?.taxi_companies ?? [];

  const params = new URLSearchParams();
  if (statusFilter !== "all") params.set("status", statusFilter);
  if (taxiCompanyFilter !== "all") params.set("taxi_company", taxiCompanyFilter);
  if (search.trim()) params.set("search", search.trim());

  const { data, isLoading, isError, refetch } = useQuery<{ drivers: Driver[] }>({
    queryKey: ["fleet-drivers", statusFilter, taxiCompanyFilter, search],
    queryFn: () => apiFetch(`/api/fleet/drivers?${params}`),
  });

  const drivers = data?.drivers ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Truck className="size-6" />
            Fleet
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage drivers, vehicle assignments, and deliveries.
          </p>
        </div>
        {realIsOwner && (
          <div className="flex items-center gap-2">
            <Link to="/fleet/vehicle-types">
              <Button variant="outline">
                <SettingsIcon className="size-4 mr-1.5" />
                Vehicle Types
              </Button>
            </Link>
            <Button
              onClick={() => {
                setEditDriver(null);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4 mr-1.5" />
              Add Driver
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
        <Input
          placeholder="Search by name, taxi company or phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        {taxiCompanies.length > 0 && (
          <Select
            value={taxiCompanyFilter}
            onValueChange={(v) => setTaxiCompanyFilter(v)}
          >
            <SelectTrigger className="sm:max-w-[200px]">
              <SelectValue placeholder="Filter by taxi company" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All taxi companies</SelectItem>
              {taxiCompanies.map((tc) => (
                <SelectItem key={tc} value={tc}>
                  {tc}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as DriverStatus | "all")}
        >
          <SelectTrigger className="sm:max-w-[180px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {DRIVER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && (
        <div className="text-center text-muted-foreground py-12">Loading drivers…</div>
      )}

      {isError && (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground mb-4">Failed to load drivers.</p>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="size-4 mr-1.5" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && drivers.length === 0 && (
        <Card>
          <CardHeader className="text-center">
            <CardTitle>No drivers yet</CardTitle>
            <CardDescription>
              {realIsOwner
                ? "Add your first driver to get started."
                : "No drivers have been added to the fleet."}
            </CardDescription>
          </CardHeader>
          {realIsOwner && (
            <CardContent className="flex justify-center pb-8">
              <Button
                onClick={() => {
                  setEditDriver(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4 mr-1.5" />
                Add Driver
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {!isLoading && !isError && drivers.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">
                  Phone
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">
                  Taxi Company
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">
                  Vehicle
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                {realIsOwner && (
                  <th className="text-right px-4 py-3 font-medium text-muted-foreground">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    {d.first_name} {d.last_name}
                    {d.license_number && (
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {d.license_number}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                    {d.phone ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {d.taxi_company ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">
                    {d.vehicle_type}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={STATUS_VARIANTS[d.status]}>{STATUS_LABELS[d.status]}</Badge>
                  </td>
                  {realIsOwner && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditDriver(d);
                            setFormOpen(true);
                          }}
                        >
                          <Pencil className="size-3.5 mr-1" />
                          Edit
                        </Button>
                        <Link to={`/fleet/drivers/${d.id}`}>
                          <Button size="sm" variant="ghost">
                            View
                          </Button>
                        </Link>
                        {d.onboarding_status !== "approved" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => approveMutation.mutate(d.id)}
                            disabled={approveMutation.isPending}
                          >
                            <CheckCircle2 className="size-3.5 mr-1" />
                            Approve
                          </Button>
                        )}
                        {d.onboarding_status === "approved" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => rotateTokenMutation.mutate(d.id)}
                            disabled={rotateTokenMutation.isPending}
                          >
                            <KeyRound className="size-3.5 mr-1" />
                            Rotate token
                          </Button>
                        )}
                        {d.status !== "inactive" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeactivateDriver(d)}
                          >
                            <Ban className="size-3.5 mr-1" />
                            Deactivate
                          </Button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <DriverFormDialog
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditDriver(null);
        }}
        editDriver={editDriver}
        existingDrivers={drivers}
      />
      <DeactivateDialog
        driver={deactivateDriver}
        onClose={() => setDeactivateDriver(null)}
      />
      <TokenRevealDialog token={revealedToken} onClose={() => setRevealedToken(null)} />
    </div>
  );
}
