import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, Plus, Pencil, Power, PowerOff, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { CASH_DESK_CURRENCIES } from "@workspace/payment-constants";

const CURRENCIES = CASH_DESK_CURRENCIES;
const NONE = "none";

type CashDrawer = {
  id: number;
  name: string;
  code: string;
  location_id: number | null;
  location_name: string | null;
  currency: string;
  secondary_currency: string | null;
  is_active: boolean;
  notes: string | null;
  open_session_id: number | null;
};

type LocationRow = { id: number; name: string };

export default function CashDrawers() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, role, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);
  const isAdminOrOwner = isOwner || role === "admin";

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CashDrawer | null>(null);
  const [form, setForm] = useState({ name: "", code: "", location_id: "", currency: "AED", secondary_currency: NONE, notes: "" });

  const { data, isLoading } = useQuery<{ drawers: CashDrawer[] }>({
    queryKey: ["cash-drawers"],
    queryFn: () => apiFetch("/api/cash-drawers?include_inactive=true"),
  });
  const { data: locData } = useQuery<{ locations: LocationRow[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
  });

  const drawers = data?.drawers ?? [];
  const locations = locData?.locations ?? [];

  function openCreate() {
    setEditing(null);
    setForm({ name: "", code: "", location_id: "", currency: "AED", secondary_currency: NONE, notes: "" });
    setDialogOpen(true);
  }
  function openEdit(d: CashDrawer) {
    setEditing(d);
    setForm({
      name: d.name,
      code: d.code,
      location_id: d.location_id != null ? String(d.location_id) : "",
      currency: d.currency,
      secondary_currency: d.secondary_currency ?? NONE,
      notes: d.notes ?? "",
    });
    setDialogOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        location_id: form.location_id ? Number(form.location_id) : null,
        currency: form.currency,
        secondary_currency: form.secondary_currency === NONE ? null : form.secondary_currency,
        notes: form.notes.trim() || null,
      };
      if (editing) {
        return apiFetch(`/api/cash-drawers/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      return apiFetch("/api/cash-drawers", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      toast({ title: editing ? "Drawer updated" : "Drawer created" });
      setDialogOpen(false);
      qc.invalidateQueries({ queryKey: ["cash-drawers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to save drawer", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: (d: CashDrawer) =>
      apiFetch(`/api/cash-drawers/${d.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !d.is_active }) }),
    onSuccess: () => {
      toast({ title: "Drawer updated" });
      qc.invalidateQueries({ queryKey: ["cash-drawers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to update drawer", variant: "destructive" }),
  });

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CreditCard className="h-6 w-6" /> Cash Drawers
          </h1>
          <p className="text-sm text-muted-foreground">Configure the cash drawers used for shift cash sessions.</p>
        </div>
        {isAdminOrOwner && (
          <Button onClick={openCreate} className="gap-1.5">
            <Plus className="h-4 w-4" /> New Drawer
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All Drawers</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : drawers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No cash drawers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Code</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Currency</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {drawers.map((d) => (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{d.name}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{d.code}</td>
                      <td className="py-2 pr-4">{d.location_name ?? "—"}</td>
                      <td className="py-2 pr-4">{d.secondary_currency ? `${d.currency} / ${d.secondary_currency}` : d.currency}</td>
                      <td className="py-2 pr-4">
                        {d.is_active ? (
                          <Badge variant="default">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Inactive</Badge>
                        )}
                        {d.open_session_id ? <Badge variant="outline" className="ml-1">Open session</Badge> : null}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex justify-end gap-1.5">
                          {can("cash_drawers.edit") && (
                            <Button size="sm" variant="outline" onClick={() => openEdit(d)} className="gap-1">
                              <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                          )}
                          {isAdminOrOwner && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={toggleMutation.isPending || Boolean(d.is_active && d.open_session_id)}
                              onClick={() => toggleMutation.mutate(d)}
                              className="gap-1"
                            >
                              {d.is_active ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                              {d.is_active ? "Deactivate" : "Activate"}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Drawer" : "New Drawer"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Front Desk Drawer" />
            </div>
            <div className="space-y-1.5">
              <Label>Code</Label>
              <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="FD1" />
            </div>
            <div className="space-y-1.5">
              <Label>Location</Label>
              <Select value={form.location_id || "none"} onValueChange={(v) => setForm((f) => ({ ...f, location_id: v === "none" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No location</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select
                value={form.currency}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    currency: v,
                    // Clear the second currency if it now matches the main one.
                    secondary_currency: f.secondary_currency === v ? NONE : f.secondary_currency,
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Second currency</Label>
              <Select value={form.secondary_currency} onValueChange={(v) => setForm((f) => ({ ...f, secondary_currency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c} disabled={c === form.currency}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Optionally hold a second currency on this desk (e.g. USD / LBP). Staff pick which one each session tracks.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={saveMutation.isPending || !form.name.trim() || !form.code.trim()}
              onClick={() => saveMutation.mutate()}
              className="gap-1.5"
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
