import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { ArrowLeft, Link2, CheckCircle2 } from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLinkDriverToClerk } from "@workspace/api-client-react";
import type { FleetDriver } from "@workspace/api-client-react";

type Driver = FleetDriver & {
  country_code?: string | null;
  onboarding_status?: string;
  availability_status?: string;
};

type OrderRow = {
  id: number;
  order_id: string | null;
  customer_name: string | null;
  total: string | null;
  currency: string | null;
  delivery_status: string | null;
  scheduled_at: string | null;
  delivered_at: string | null;
};

type EventRow = {
  id: number;
  event_type: string;
  notes: string | null;
  occurred_at: string;
  assignment_id: number;
};

export default function FleetDriverDetailPage() {
  const params = useParams<{ id: string }>();
  const driverId = Number(params.id);
  const { realIsOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const [linkingClerk, setLinkingClerk] = useState(false);

  const { data: driverData, isLoading } = useQuery<{ driver: Driver }>({
    queryKey: ["fleet-driver", driverId],
    queryFn: () => apiFetch(`/api/fleet/drivers/${driverId}`),
    enabled: Number.isFinite(driverId),
  });

  const { data: ordersData } = useQuery<{ orders: OrderRow[] }>({
    queryKey: ["fleet-driver-orders", driverId],
    queryFn: () => apiFetch(`/api/fleet/orders?driver_id=${driverId}&limit=200`),
    enabled: Number.isFinite(driverId),
  });

  const { data: eventsData } = useQuery<{ events: EventRow[] }>({
    queryKey: ["fleet-driver-events", driverId],
    queryFn: async () => {
      const ords = await apiFetch<{ orders: OrderRow[] }>(
        `/api/fleet/orders?driver_id=${driverId}&limit=200`,
      );
      const assignmentIds = (ords.orders ?? [])
        .map((o: OrderRow & { assignment_id?: number }) => o.assignment_id)
        .filter((x): x is number => Number.isFinite(x));
      if (assignmentIds.length === 0) return { events: [] };
      const all: EventRow[] = [];
      for (const aid of assignmentIds.slice(0, 25)) {
        const res = await apiFetch<{ events: EventRow[] }>(
          `/api/fleet/delivery-events?assignment_id=${aid}`,
        );
        for (const e of res.events ?? []) all.push({ ...e, assignment_id: aid });
      }
      all.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
      return { events: all.slice(0, 25) };
    },
    enabled: Number.isFinite(driverId),
  });

  const linkClerkMutation = useLinkDriverToClerk({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ["fleet-driver", driverId] });
        toast({
          title: "Clerk user linked",
          description: `Linked to Clerk user ${data.clerk_user_id}`,
        });
        setLinkingClerk(false);
      },
      onError: () => {
        toast({ title: "Failed to link Clerk user", variant: "destructive" });
        setLinkingClerk(false);
      },
    },
  });

  if (isLoading) {
    return <div className="text-muted-foreground">Loading…</div>;
  }
  const d = driverData?.driver;
  if (!d) {
    return (
      <div>
        <Link to="/fleet">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4 mr-1.5" /> Back to Fleet
          </Button>
        </Link>
        <p className="mt-4 text-muted-foreground">Driver not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link to="/fleet">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="size-4 mr-1.5" /> Back to Fleet
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {d.first_name} {d.last_name}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground text-xs uppercase">Onboarding</div>
            <Badge variant="outline">{d.onboarding_status ?? "—"}</Badge>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase">Availability</div>
            <Badge variant="outline">{d.availability_status ?? "—"}</Badge>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase">Status</div>
            <Badge variant="outline">{d.status}</Badge>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase">Phone</div>
            <div>{d.phone ?? "—"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase">Taxi Company</div>
            <div>{d.taxi_company ?? "—"}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase">Vehicle</div>
            <div>{d.vehicle_type}</div>
          </div>
        </CardContent>
      </Card>

      {realIsOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Link2 className="size-4" />
              Clerk Link
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {d.clerk_user_id ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-green-600" />
                <span className="text-muted-foreground">Linked to Clerk user</span>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                  {d.clerk_user_id}
                </code>
              </div>
            ) : (
              <p className="text-muted-foreground">
                Not linked. The driver cannot log in to the driver app yet.
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={linkClerkMutation.isPending}
              onClick={() => {
                setLinkingClerk(true);
                linkClerkMutation.mutate({ id: driverId });
              }}
            >
              <Link2 className="size-3.5 mr-1.5" />
              {d.clerk_user_id ? "Re-link Clerk User" : "Link Clerk User"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assigned orders</CardTitle>
        </CardHeader>
        <CardContent>
          {(ordersData?.orders?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No orders assigned to this driver.</p>
          ) : (
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2">Order</th>
                    <th className="text-left px-3 py-2">Customer</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-left px-3 py-2">Scheduled</th>
                    <th className="text-left px-3 py-2">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {(ordersData?.orders ?? []).map((o) => (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">#{o.order_id ?? o.id}</td>
                      <td className="px-3 py-2">{o.customer_name ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{o.delivery_status ?? "unassigned"}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {o.scheduled_at ? new Date(o.scheduled_at).toLocaleString() : "—"}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {o.delivered_at ? new Date(o.delivered_at).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent events</CardTitle>
        </CardHeader>
        <CardContent>
          {(eventsData?.events?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No recent delivery events.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {(eventsData?.events ?? []).map((e) => (
                <li key={e.id} className="flex items-baseline gap-3">
                  <span className="text-xs text-muted-foreground tabular-nums w-40">
                    {new Date(e.occurred_at).toLocaleString()}
                  </span>
                  <Badge variant="outline">{e.event_type}</Badge>
                  {e.notes && <span className="text-muted-foreground">{e.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
