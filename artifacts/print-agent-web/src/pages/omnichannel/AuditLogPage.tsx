import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Shield, ChevronLeft, ChevronRight } from "lucide-react";
import { format } from "date-fns";

interface AuditEvent {
  id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
}

interface AuditLogResponse {
  success: boolean;
  events: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
  available_actions: string[];
}

const PAGE_SIZE = 50;

function ActionBadge({ action }: { action: string }) {
  const isCreate = action.includes("create") || action.includes("add");
  const isDelete = action.includes("delete") || action.includes("remove") || action.includes("anonymize");
  const isUpdate = action.includes("update") || action.includes("patch") || action.includes("resolve") || action.includes("assign");

  const classes = isCreate
    ? "bg-green-100 text-green-800"
    : isDelete
      ? "bg-red-100 text-red-800"
      : isUpdate
        ? "bg-blue-100 text-blue-800"
        : "bg-muted text-muted-foreground";

  return (
    <span className={`text-[11px] px-2 py-0.5 rounded font-mono font-medium ${classes}`}>
      {action}
    </span>
  );
}

export default function AuditLogPage() {
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [page, setPage] = useState(0);

  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  if (actionFilter && actionFilter !== "all") params.set("action", actionFilter);

  const { data, isLoading, isError } = useQuery<AuditLogResponse>({
    queryKey: ["omnichannel-audit-log", actionFilter, page],
    queryFn: () => apiFetch(`/api/omnichannel/audit-log?${params}`),
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Shield className="w-6 h-6" />
            Audit Log
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Immutable record of all omnichannel operations
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Select
          value={actionFilter}
          onValueChange={(v) => { setActionFilter(v); setPage(0); }}
        >
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Filter by action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {data?.available_actions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <span className="text-sm text-muted-foreground">
            {data.total.toLocaleString()} events
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            Failed to load audit log.
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          {data.events.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center">
                <Shield className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">No audit events found</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Time</th>
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Actor</th>
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Action</th>
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Resource</th>
                      <th className="px-4 py-2.5 text-xs font-semibold text-muted-foreground">Metadata</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.events.map((event) => (
                      <tr key={event.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-muted-foreground">
                          {format(new Date(event.occurred_at), "MMM d, HH:mm:ss")}
                        </td>
                        <td className="px-4 py-2.5 max-w-[140px]">
                          <div>
                            <p className="text-xs font-mono truncate" title={event.actor_id ?? undefined}>
                              {event.actor_id ? event.actor_id.slice(0, 16) + "…" : "—"}
                            </p>
                            <p className="text-[10px] text-muted-foreground capitalize">
                              {event.actor_type}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <ActionBadge action={event.action} />
                        </td>
                        <td className="px-4 py-2.5">
                          <div>
                            <p className="text-xs capitalize">{event.resource_type}</p>
                            {event.resource_id && (
                              <p className="text-[10px] text-muted-foreground font-mono truncate max-w-[100px]">
                                {event.resource_id}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 max-w-[200px]">
                          {event.metadata ? (
                            <p className="text-[10px] text-muted-foreground font-mono truncate" title={JSON.stringify(event.metadata)}>
                              {JSON.stringify(event.metadata)}
                            </p>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {data.offset + 1}–{Math.min(data.offset + data.limit, data.total)} of{" "}
                {data.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
