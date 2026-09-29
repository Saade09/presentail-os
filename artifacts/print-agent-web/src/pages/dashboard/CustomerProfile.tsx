import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { orderStatusBadgeClass } from "@/lib/orderStatus";

type Customer = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  notes: string | null;
  total_orders: number;
  total_spent: string;
  last_order_at: string | null;
  created_at: string;
  marketing_opt_in: boolean;
  gender: string | null;
  date_of_birth: string | null;
  website_user_id: string | null;
  source: string | null;
  saved_addresses: unknown[];
  deleted_at: string | null;
};

type OrderRow = {
  id: string;
  display_order_number: string | null;
  status: string;
  source: string;
  created_at: string | null;
  ordered_at: string | null;
  totals: { total?: string; currency?: string } | null;
  express_delivery_selected: boolean;
  express_delivery_fee: string | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function formatAmount(total: string | null, currency: string | null): string {
  if (!total) return "—";
  const curr = currency ?? "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: curr }).format(parseFloat(total));
  } catch {
    return `${total} ${curr}`;
  }
}

export default function CustomerProfile() {
  const [, params] = useRoute("/customers/:id");
  // The route param may be a numeric customers.id OR a contact-pool UUID
  // (from the Customers dashboard); the API resolves both.
  const id = params?.id ?? "";
  const validId = /^\d+$/.test(id) || /^[0-9a-f-]{36}$/i.test(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [mergeOpen, setMergeOpen] = useState(false);

  const { data, isLoading, error } = useQuery<{ customer: Customer }>({
    queryKey: ["customer", id],
    queryFn: () => apiFetch(`/api/customers/${id}`),
    enabled: validId,
  });

  const { data: ordersData, isLoading: loadingOrders } = useQuery<{ orders: OrderRow[]; total: number }>({
    queryKey: ["customer-orders", id],
    queryFn: () => apiFetch(`/api/customers/${id}/orders?limit=100`),
    enabled: validId,
  });

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{
    firstName: string; lastName: string; phone: string; city: string; country: string; notes: string;
    gender: string; dateOfBirth: string; marketingOptIn: boolean;
  }>({
    firstName: "",
    lastName: "",
    phone: "",
    city: "",
    country: "",
    notes: "",
    gender: "",
    dateOfBirth: "",
    marketingOptIn: false,
  });

  useEffect(() => {
    if (data?.customer) {
      setForm({
        firstName: data.customer.first_name ?? "",
        lastName: data.customer.last_name ?? "",
        phone: data.customer.phone ?? "",
        city: data.customer.city ?? "",
        country: data.customer.country ?? "",
        notes: data.customer.notes ?? "",
        gender: data.customer.gender ?? "",
        dateOfBirth: data.customer.date_of_birth ?? "",
        marketingOptIn: data.customer.marketing_opt_in,
      });
    }
  }, [data?.customer]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/customers/${data?.customer?.id ?? id}`, {
        method: "PATCH",
        body: JSON.stringify({
          first_name: form.firstName,
          last_name: form.lastName,
          phone: form.phone,
          city: form.city,
          country: form.country,
          notes: form.notes,
          gender: form.gender || null,
          date_of_birth: form.dateOfBirth || null,
          marketing_opt_in: form.marketingOptIn,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer", id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      setEditing(false);
      toast({ title: "Saved", description: "Customer updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  if (!validId) return <div className="p-6">Invalid customer.</div>;
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }
  if (error || !data?.customer) {
    return <div className="p-6 text-muted-foreground">Customer not found.</div>;
  }
  const c = data.customer;
  const orders = ordersData?.orders ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/customers" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ChevronLeft size={14} />
          Back to customers
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(unnamed customer)"}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Customer since {formatDate(c.created_at)} · {c.total_orders} order{c.total_orders !== 1 ? "s" : ""} · {formatAmount(c.total_spent, orders[0]?.totals?.currency ?? null)} total
          </p>
        </div>
        {!editing ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setMergeOpen(true)} data-testid="button-merge-customer">
              Merge into…
            </Button>
            <Button onClick={() => setEditing(true)} data-testid="button-edit-customer">Edit</Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setEditing(false)} disabled={saveMut.isPending}>Cancel</Button>
            <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} data-testid="button-save-customer">
              {saveMut.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>

      {c.deleted_at && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          This customer was deleted on {formatDate(c.deleted_at)}.
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-md border p-5 space-y-4">
          <h2 className="font-semibold">Contact</h2>
          <div className="space-y-3 text-sm">
            <Field label="Email" value={c.email ?? "—"} readOnly hint="Email is read-only to avoid duplicate records." />
            {editing ? (
              <>
                <FieldInput label="First name" value={form.firstName} onChange={(v) => setForm({ ...form, firstName: v })} />
                <FieldInput label="Last name" value={form.lastName} onChange={(v) => setForm({ ...form, lastName: v })} />
                <FieldInput label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
                <FieldInput label="Country" value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
                <FieldInput label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
              </>
            ) : (
              <>
                <Field label="Phone" value={c.phone ?? "—"} />
                <Field label="Country" value={c.country ?? "—"} />
                <Field label="City" value={c.city ?? "—"} />
              </>
            )}
          </div>
        </div>

        <div className="rounded-md border p-5 space-y-4">
          <h2 className="font-semibold">Profile</h2>
          <div className="space-y-3 text-sm">
            {editing ? (
              <>
                <div className="space-y-1">
                  <Label className="text-xs uppercase tracking-wide">Gender</Label>
                  <select
                    value={form.gender}
                    onChange={(e) => setForm({ ...form, gender: e.target.value })}
                    className="w-full border rounded-md px-3 py-2 text-sm"
                  >
                    <option value="">— not specified —</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <FieldInput label="Date of birth" value={form.dateOfBirth} onChange={(v) => setForm({ ...form, dateOfBirth: v })} />
                <div className="flex items-center gap-2">
                  <input
                    id="chk-marketing"
                    type="checkbox"
                    checked={form.marketingOptIn}
                    onChange={(e) => setForm({ ...form, marketingOptIn: e.target.checked })}
                    className="accent-primary"
                  />
                  <label htmlFor="chk-marketing" className="text-sm cursor-pointer">Marketing opt-in</label>
                </div>
              </>
            ) : (
              <>
                <Field label="Gender" value={c.gender ?? "—"} />
                <Field label="Date of birth" value={c.date_of_birth ? formatDate(c.date_of_birth) : "—"} />
                <Field label="Source" value={c.source ?? "—"} />
                {c.website_user_id && <Field label="Website user ID" value={c.website_user_id} />}
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wide">Marketing opt-in</div>
                  <div className="mt-0.5">
                    {c.marketing_opt_in
                      ? <span className="inline-block bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">Opted in</span>
                      : <span className="text-muted-foreground">—</span>
                    }
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-md border p-5 space-y-4">
        <h2 className="font-semibold">Internal notes</h2>
        {editing ? (
          <Textarea
            data-testid="input-customer-notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Add notes about this customer…"
            rows={6}
          />
        ) : (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground min-h-[6rem]">
            {c.notes?.trim() || "No notes yet."}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="font-semibold">Order history</h2>
        {loadingOrders ? (
          <div className="flex justify-center py-8"><Spinner className="size-6 text-primary" /></div>
        ) : orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No linked orders yet.</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-sm">
                      {o.display_order_number ?? `#${o.id}`}
                    </TableCell>
                    <TableCell className="text-sm">{formatDate(o.ordered_at ?? o.created_at)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={orderStatusBadgeClass(o.status)}>{o.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {o.express_delivery_selected ? (
                        <Badge className="bg-orange-100 text-orange-800 text-xs">Express</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">Standard</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatAmount(o.totals?.total ?? null, o.totals?.currency ?? null)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <MergeCustomerDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        sourceId={c.id}
        sourceName={`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || c.email || c.phone || `#${c.id}`}
        onMerged={(targetId) => {
          setMergeOpen(false);
          qc.invalidateQueries({ queryKey: ["customers"] });
          qc.invalidateQueries({ queryKey: ["customer", targetId] });
          toast({ title: "Merged", description: "Customer records were combined." });
          navigate(`/customers/${targetId}`);
        }}
      />
    </div>
  );
}

type CustomerSearchRow = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  total_orders: number;
};

function MergeCustomerDialog({
  open,
  onOpenChange,
  sourceId,
  sourceName,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceId: number;
  sourceName: string;
  onMerged: (targetId: number) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<CustomerSearchRow | null>(null);

  useEffect(() => {
    if (!open) {
      setSearch("");
      setTarget(null);
    }
  }, [open]);

  const trimmed = search.trim();
  const { data, isFetching } = useQuery<{ customers: CustomerSearchRow[] }>({
    queryKey: ["customer-search", trimmed],
    queryFn: () =>
      apiFetch(`/api/customers?limit=10&search=${encodeURIComponent(trimmed)}`),
    enabled: open && trimmed.length >= 2,
  });

  const candidates = useMemo(
    () => (data?.customers ?? []).filter((c) => c.id !== sourceId),
    [data, sourceId],
  );

  const mergeMut = useMutation({
    mutationFn: (targetId: number) =>
      apiFetch<{ customer: { id: number } }>(`/api/customers/${sourceId}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      }),
    onSuccess: (res) => {
      onMerged(res.customer.id);
    },
    onError: (err: Error) => {
      toast({ title: "Merge failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="dialog-merge-customer">
        <DialogHeader>
          <DialogTitle>Merge customer into…</DialogTitle>
          <DialogDescription>
            Pick the customer to keep. All orders from <span className="font-medium">{sourceName}</span> will move to the
            chosen customer, notes will be combined, and this profile will be deleted. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs uppercase tracking-wide">Search by name, email, or phone</Label>
            <Input
              autoFocus
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setTarget(null);
              }}
              placeholder="Type at least 2 characters…"
              data-testid="input-merge-search"
            />
          </div>

          <div className="rounded-md border max-h-64 overflow-y-auto">
            {trimmed.length < 2 ? (
              <div className="p-4 text-sm text-muted-foreground">Start typing to find a customer.</div>
            ) : isFetching ? (
              <div className="p-4 flex justify-center"><Spinner className="size-5 text-primary" /></div>
            ) : candidates.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No matching customers.</div>
            ) : (
              <ul className="divide-y">
                {candidates.map((c) => {
                  const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "(unnamed)";
                  const isSelected = target?.id === c.id;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setTarget(c)}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-muted ${isSelected ? "bg-muted" : ""}`}
                        data-testid={`merge-candidate-${c.id}`}
                      >
                        <div className="font-medium">{name}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.email ?? "no email"} · {c.phone ?? "no phone"} · {c.total_orders} order{c.total_orders !== 1 ? "s" : ""}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mergeMut.isPending}>Cancel</Button>
          <Button
            onClick={() => target && mergeMut.mutate(target.id)}
            disabled={!target || mergeMut.isPending}
            data-testid="button-confirm-merge"
          >
            {mergeMut.isPending ? "Merging…" : target ? `Merge into ${`${target.first_name ?? ""} ${target.last_name ?? ""}`.trim() || target.email || `#${target.id}`}` : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, readOnly, hint }: { label: string; value: string; readOnly?: boolean; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}{readOnly ? " (read-only)" : ""}</div>
      <div className="text-sm mt-0.5">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function FieldInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs uppercase tracking-wide">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
