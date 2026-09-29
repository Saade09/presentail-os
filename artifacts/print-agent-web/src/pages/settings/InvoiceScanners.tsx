import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  MoreHorizontal,
  Copy,
  Check,
  RefreshCw,
  Loader2,
  Pencil,
  PowerOff,
  Power,
  ScanBarcode,
  Wifi,
  WifiOff,
  Clock,
  AlertTriangle,
  Unplug,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";

// ─── Types ───────────────────────────────────────────────────────────────────

type ScannerStation = {
  id: number;
  name: string;
  default_entity_id: number | null;
  default_entity_name: string | null;
  default_entity_active: boolean | null;
  location: string | null;
  status: string; // 'active' | 'disabled' | 'unpaired' | 'never_connected'
  last_seen_at: string | null;
  agent_version: string | null;
  queued_count: number;
  created_at: string;
};

type FinanceEntityOption = {
  id: number;
  legal_name: string;
  display_name: string | null;
  is_active: boolean;
};

type PairingCode = {
  code: string;
  expires_at: string;
};

type ScannerAgentRelease = {
  available: boolean;
  version: string | null;
  filename: string | null;
  sha256: string | null;
  reason?: string;
};

type StationForm = {
  name: string;
  default_entity_id: string; // string for select
  location: string;
};

const EMPTY_FORM: StationForm = {
  name: "",
  default_entity_id: "",
  location: "",
};

export function buildScannerStationPayload(form: StationForm) {
  return {
    name: form.name.trim(),
    default_entity_id: Number(form.default_entity_id),
    location: form.location.trim() || null,
  };
}

export function ScannerCommissioningGuide() {
  return (
    <ol className="list-decimal pl-5 space-y-1">
      <li>Create an enabled station and select an active default entity.</li>
      <li>Download and launch the Windows agent. Reopen it from the Start menu if its setup window is hidden.</li>
      <li>Generate a fresh one-time code and enter the exact OS URL and code shown in the dialog.</li>
      <li>Wait for the green tray icon and <span className="font-medium">Connected</span> status and confirm the station&apos;s last-seen time.</li>
      <li>Save a PDF, JPG, or PNG to <code>C:\PresentailScanner\Inbox</code> and verify it in Recent Imports.</li>
    </ol>
  );
}

// ─── Connection status helpers ────────────────────────────────────────────────

type ConnectionStatus = "connected" | "recent" | "offline" | "never";

function getConnectionStatus(lastSeenAt: string | null): ConnectionStatus {
  if (!lastSeenAt) return "never";
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 5 * 60 * 1000) return "connected";
  if (diffMs < 30 * 60 * 1000) return "recent";
  return "offline";
}

function ConnectionBadge({ lastSeenAt }: { lastSeenAt: string | null }) {
  const status = getConnectionStatus(lastSeenAt);
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
        <Wifi className="h-3 w-3" />
        Connected
      </span>
    );
  }
  if (status === "recent") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
        <Clock className="h-3 w-3" />
        Recently seen
      </span>
    );
  }
  if (status === "offline") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <WifiOff className="h-3 w-3" />
        Offline
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <AlertTriangle className="h-3 w-3" />
      Never connected
    </span>
  );
}

function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never";
  return new Date(lastSeenAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function WindowsAgentDownloadAction({
  available,
  loading,
}: {
  available: boolean;
  loading: boolean;
}) {
  if (available) {
    return (
      <Button variant="outline" asChild>
        <a
          href="/api/download/scanner-agent"
          data-testid="download-windows-scanner-agent"
        >
          <Download className="h-4 w-4 mr-1.5" />
          Download Windows Agent
        </a>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      disabled
      data-testid="download-windows-scanner-agent"
    >
      {loading ? (
        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-1.5" />
      )}
      {loading ? "Checking Windows Agent…" : "Windows Agent unavailable"}
    </Button>
  );
}

function StationStatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <Badge variant="default" className="text-xs bg-green-600 hover:bg-green-600">
        Active
      </Badge>
    );
  }
  if (status === "disabled") {
    return (
      <Badge variant="secondary" className="text-xs">
        Disabled
      </Badge>
    );
  }
  // unpaired / never_connected / unknown
  return (
    <Badge variant="outline" className="text-xs">
      Unpaired
    </Badge>
  );
}

export function getScannerStationRecoveryGuidance(station: {
  status: string;
  default_entity_id: number | null;
  default_entity_active?: boolean | null;
}): string | null {
  if (station.status === "disabled") {
    return "This station is disabled. Enable it in Presentail OS before generating a fresh pairing code.";
  }
  if (!station.default_entity_id || station.default_entity_active === false) {
    return "Select an active default entity in Edit, then generate a fresh pairing code and re-pair the agent.";
  }
  return null;
}

// ─── Pairing Code Modal ───────────────────────────────────────────────────────

function PairingCodeModal({
  station,
  open,
  onClose,
  onRefresh,
}: {
  station: ScannerStation;
  open: boolean;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const isExpired = secondsLeft !== null && secondsLeft <= 0;
  const osUrl = window.location.origin;

  const generateCode = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch<{ pairing_code: PairingCode }>(
        `/api/scanner/stations/${station.id}/pairing-code`,
        { method: "POST" },
      );
      setPairingCode(result.pairing_code);
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to generate pairing code",
        description: String(err instanceof Error ? err.message : err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [station.id, toast, onRefresh]);

  // Generate a code when the modal opens
  useEffect(() => {
    if (open) {
      setPairingCode(null);
      setSecondsLeft(null);
      setCopied(false);
      void generateCode();
    }
  }, [open, generateCode]);

  // Countdown timer
  useEffect(() => {
    if (!pairingCode) return;
    const updateCountdown = () => {
      const remaining = Math.max(
        0,
        Math.floor((new Date(pairingCode.expires_at).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [pairingCode]);

  useEffect(() => {
    if (!open || !pairingCode) return;
    const interval = setInterval(onRefresh, 3_000);
    return () => clearInterval(interval);
  }, [open, pairingCode, onRefresh]);

  const handleCopy = async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Could not copy to clipboard", variant: "destructive" });
    }
  };

  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pairing Code — {station.name}</DialogTitle>
          <DialogDescription>
            Complete these steps on the Windows scanner PC. The code is
            single-use and expires after 15 minutes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <ol className="space-y-2 text-sm">
             <li><strong>1. Open the agent.</strong> Launch <span className="font-medium">Presentail Scanner Agent</span> from the Windows Start menu. If it is already running, find its icon under the taskbar&apos;s hidden-icons arrow; choose <span className="font-medium">Re-pair station…</span> when the tray says the credential was rejected, the station is disabled, or setup is required.</li>
            <li><strong>2. Enter the Presentail OS URL:</strong> <code className="rounded bg-muted px-1.5 py-0.5 select-all">{osUrl}</code></li>
            <li><strong>3. Enter this one-time code:</strong></li>
          </ol>
          {loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">Generating code…</span>
            </div>
          )}

          {!loading && pairingCode && (
            <>
              <div
                className={`rounded-xl border-2 px-8 py-4 text-center transition-colors ${
                  isExpired
                    ? "border-muted bg-muted/30"
                    : "border-primary/30 bg-primary/5"
                }`}
              >
                <p
                  className={`font-mono text-4xl font-bold tracking-[0.25em] ${
                    isExpired ? "text-muted-foreground" : "text-foreground"
                  }`}
                >
                  {pairingCode.code}
                </p>
              </div>

              {isExpired ? (
                <p className="text-sm text-destructive font-medium">
                  Code expired
                </p>
              ) : (
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    Expires in{" "}
                    <span className="font-medium text-foreground">
                      {secondsLeft !== null ? formatCountdown(secondsLeft) : "…"}
                    </span>
                  </span>
                </div>
              )}

              <div className="flex gap-2 w-full">
                {!isExpired && (
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4 mr-1.5 text-green-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-1.5" />
                        Copy code
                      </>
                    )}
                  </Button>
                )}
                <Button
                  variant={isExpired ? "default" : "outline"}
                  className={isExpired ? "flex-1" : ""}
                  onClick={() => void generateCode()}
                  disabled={loading}
                >
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                  {isExpired ? "Generate new code" : "Regenerate"}
                </Button>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
                <p><strong>4. Wait for connection.</strong> The station should change from <span className="font-medium">Never connected</span> to <span className="font-medium text-green-700">Connected</span> after the first heartbeat, and its last-seen time should update. This page refreshes automatically.</p>
                <p><strong>5. Test the first upload.</strong> Save a PDF, JPG, or PNG to <code>C:\PresentailScanner\Inbox</code>, then confirm it appears in <span className="font-medium">Recent Imports</span> and moves to <code>Uploaded</code>. Permanent failures move to <code>Failed</code> with an <code>.error.json</code> file.</p>
                <p className="text-muted-foreground">Still not connected? Amber means the network is unavailable and queued files will retry. Red means the credential was rejected and requires a fresh code. A disabled or setup-required message must be fixed in Presentail OS before re-pairing.</p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add / Edit Station Dialog ────────────────────────────────────────────────

function StationDialog({
  mode,
  station,
  entities,
  open,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  station?: ScannerStation;
  entities: FinanceEntityOption[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<StationForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (mode === "edit" && station) {
        setForm({
          name: station.name,
          default_entity_id: station.default_entity_id
            ? String(station.default_entity_id)
            : "",
          location: station.location ?? "",
        });
      } else {
        setForm(EMPTY_FORM);
      }
    }
  }, [open, mode, station]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ title: "Station name is required", variant: "destructive" });
      return;
    }
    if (!form.default_entity_id) {
      toast({ title: "Default entity is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = buildScannerStationPayload(form);
      if (mode === "add") {
        await apiFetch("/api/scanner/stations", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast({ title: "Scanner station created" });
      } else if (station) {
        await apiFetch(`/api/scanner/stations/${station.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast({ title: "Station updated" });
      }
      onSaved();
      onClose();
    } catch (err) {
      toast({
        title: mode === "add" ? "Failed to create station" : "Failed to update station",
        description: String(err instanceof Error ? err.message : err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const activeEntities = entities.filter((e) => e.is_active);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add Scanner Station" : "Edit Station"}
          </DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? "Register a new invoice scanner station for this workspace."
              : "Update station details."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label>Station Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Reception Scanner"
            />
          </div>
          <div>
            <Label>Default Entity *</Label>
            <Select
              value={form.default_entity_id}
              onValueChange={(v) => setForm({ ...form, default_entity_id: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select an active entity" />
              </SelectTrigger>
              <SelectContent>
                {activeEntities.map((e) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.display_name ?? e.legal_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Required for pairing and uploads. Scans are imported into this entity.
            </p>
          </div>
          <div>
            <Label>Location / Branch</Label>
            <Input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              placeholder="e.g. Head Office, Dubai"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : mode === "add" ? "Create Station" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Revoke Confirm Dialog ────────────────────────────────────────────────────

function RevokeDialog({
  station,
  open,
  onClose,
  onRevoked,
}: {
  station: ScannerStation;
  open: boolean;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const { toast } = useToast();
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await apiFetch(`/api/scanner/stations/${station.id}/revoke`, {
        method: "POST",
      });
      toast({ title: "Device revoked", description: "The station must be re-paired to reconnect." });
      onRevoked();
      onClose();
    } catch (err) {
      toast({
        title: "Failed to revoke device",
        description: String(err instanceof Error ? err.message : err),
        variant: "destructive",
      });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke Device — {station.name}?</DialogTitle>
          <DialogDescription>
            Revoking disconnects the currently paired agent. The station status
            will become &ldquo;Unpaired&rdquo; until you generate a new pairing
            code and pair it again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={revoking}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void handleRevoke()}
            disabled={revoking}
          >
            {revoking ? "Revoking…" : "Revoke device"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Station Row ──────────────────────────────────────────────────────────────

function StationRow({
  station,
  entities,
  onRefresh,
}: {
  station: ScannerStation;
  entities: FinanceEntityOption[];
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

  const handleToggleActive = async () => {
    setToggling(true);
    try {
      const isActive = station.status === "active";
      await apiFetch(`/api/scanner/stations/${station.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: isActive ? "disabled" : "active" }),
      });
      toast({
        title: isActive ? "Station disabled" : "Station enabled",
      });
      onRefresh();
    } catch (err) {
      toast({
        title: "Failed to update station",
        description: String(err instanceof Error ? err.message : err),
        variant: "destructive",
      });
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <PairingCodeModal
        station={station}
        open={pairingOpen}
        onClose={() => setPairingOpen(false)}
        onRefresh={onRefresh}
      />
      <StationDialog
        mode="edit"
        station={station}
        entities={entities}
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSaved={onRefresh}
      />
      <RevokeDialog
        station={station}
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onRevoked={onRefresh}
      />

      <div className="flex items-start justify-between gap-3 py-3 border-b last:border-b-0">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{station.name}</span>
            <StationStatusBadge status={station.status} />
            {station.queued_count > 0 && (
              <Badge variant="secondary" className="text-xs">
                {station.queued_count} queued
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {station.default_entity_name && (
              <span>{station.default_entity_name}</span>
            )}
            {station.location && <span>{station.location}</span>}
            {station.agent_version && (
              <span className="font-mono">v{station.agent_version}</span>
            )}
          </div>
           {getScannerStationRecoveryGuidance(station) && (
            <div className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
               <span>{getScannerStationRecoveryGuidance(station)}</span>
            </div>
          )}

          <div className="flex items-center gap-3 text-xs mt-0.5">
            <ConnectionBadge lastSeenAt={station.last_seen_at} />
            {station.last_seen_at && (
              <span className="text-muted-foreground">
                Last seen: {formatLastSeen(station.last_seen_at)}
              </span>
            )}
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => setPairingOpen(true)}
              disabled={
                !station.default_entity_id ||
                station.default_entity_active !== true ||
                station.status !== "active"
              }
            >
              <ScanBarcode className="h-4 w-4 mr-2" />
              Generate pairing code
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void handleToggleActive()}
              disabled={toggling}
            >
              {station.status === "active" ? (
                <>
                  <PowerOff className="h-4 w-4 mr-2" />
                  Disable station
                </>
              ) : (
                <>
                  <Power className="h-4 w-4 mr-2" />
                  Enable station
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => setRevokeOpen(true)}
            >
              <Unplug className="h-4 w-4 mr-2" />
              Revoke device
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function InvoiceScannersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const { data: stationsData, isLoading: stationsLoading, refetch: refetchStations } = useQuery({
    queryKey: ["scanner-stations"],
    queryFn: () => apiFetch<{ stations: ScannerStation[] }>("/api/scanner/stations"),
    refetchInterval: 10_000,
  });

  const { data: entitiesData } = useQuery({
    queryKey: ["finance-entities"],
    queryFn: () =>
      apiFetch<{ entities: FinanceEntityOption[] }>("/api/finance/entities"),
    staleTime: 60_000,
  });

  const {
    data: agentRelease,
    isLoading: agentReleaseLoading,
    isError: agentReleaseError,
  } = useQuery({
    queryKey: ["scanner-agent-release"],
    queryFn: () =>
      apiFetch<ScannerAgentRelease>("/api/download/scanner-agent/version"),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const stations = stationsData?.stations ?? [];
  const entities = entitiesData?.entities ?? [];
  const agentAvailable = agentRelease?.available === true;

  const handleRefresh = useCallback(() => {
    void refetchStations();
    qc.invalidateQueries({ queryKey: ["scanner-stations"] });
  }, [refetchStations, qc]);

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto py-6 px-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Invoice Scanners</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage scanner stations, generate pairing codes, and monitor
            connection health.
          </p>
          {!agentReleaseLoading && !agentAvailable && (
            <p
              className="text-xs text-amber-700 mt-2"
              data-testid="scanner-agent-unavailable"
            >
              {agentReleaseError
                ? "Windows Agent availability could not be checked."
                : agentRelease?.reason ?? "Windows Agent is not available yet."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <WindowsAgentDownloadAction
            available={agentAvailable}
            loading={agentReleaseLoading}
          />
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add Scanner Station
          </Button>
        </div>
      </div>

      <StationDialog
        mode="add"
        entities={entities}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => {
          handleRefresh();
          setAddOpen(false);
        }}
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Scanner Stations</CardTitle>
              {!stationsLoading && (
                <CardDescription>
                  {stations.length === 0
                    ? "No scanner stations configured yet."
                    : `${stations.length} station${stations.length !== 1 ? "s" : ""} registered`}
                </CardDescription>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleRefresh}
              disabled={stationsLoading}
            >
              <RefreshCw
                className={`h-4 w-4 ${stationsLoading ? "animate-spin" : ""}`}
              />
              <span className="sr-only">Refresh</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {stationsLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading stations…
            </div>
          )}

          {!stationsLoading && stations.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ScanBarcode className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">
                No scanner stations yet
              </p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Add a scanner station and generate a pairing code to connect a
                Presentail Scanner Agent installation.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Add Scanner Station
              </Button>
            </div>
          )}

          {!stationsLoading && stations.length > 0 && (
            <div>
              {stations.map((station) => (
                <StationRow
                  key={station.id}
                  station={station}
                  entities={entities}
                  onRefresh={handleRefresh}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-muted bg-muted/20">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-3">
            <ScanBarcode className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">Commission a scanner in five steps</p>
              <ScannerCommissioningGuide />
              <p>The agent watches files saved by scanner software; it does not control the scanner or install its drivers.</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
