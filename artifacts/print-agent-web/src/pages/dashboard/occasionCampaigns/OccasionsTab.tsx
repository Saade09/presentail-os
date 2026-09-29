import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, MoreHorizontal, Eye, Edit2, Copy, Archive, Trash2, Settings } from "lucide-react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { type Occasion, type OccasionType, TYPE_COLOR, PRIORITY_COLOR, PhaseBadge } from "../OccasionCampaignCalendarPage";
import { OccasionTypesModal } from "./OccasionTypesModal";

type Props = {
  occasions: Occasion[];
  plans: unknown[];
  summary: unknown;
};

export function OccasionsTab({ occasions }: Props) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { realIsOwner } = useWorkspaceRole();

  const [q, setQ] = useState("");
  const [marketFilter, setMarketFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [typesModalOpen, setTypesModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Occasion | null>(null);

  const typesQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/types"],
    queryFn: () => apiFetch<{ types: OccasionType[] }>("/api/occasion-campaigns/types"),
  });
  const types = typesQuery.data?.types ?? [];

  const allOccasionsQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/occasions", { include_archived: statusFilter === "archived" }],
    queryFn: () => {
      const url = statusFilter === "archived"
        ? "/api/occasion-campaigns/occasions?include_archived=true&status=archived"
        : "/api/occasion-campaigns/occasions";
      return apiFetch<{ occasions: Occasion[] }>(url);
    },
  });
  const allOccasions = allOccasionsQuery.data?.occasions ?? occasions;

  const archiveMutation = useMutation({
    mutationFn: ({ id, archive }: { id: number; archive: boolean }) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: archive ? "archived" : "active" }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Occasion updated" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      toast({ title: "Occasion duplicated" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Occasion deleted" });
      setDeleteTarget(null);
    },
    onError: (e: Error) => {
      toast({ title: e.message, variant: "destructive" });
      setDeleteTarget(null);
    },
  });

  const filtered = allOccasions.filter((occ) => {
    if (q && !occ.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (marketFilter !== "all" && !occ.markets.includes(marketFilter)) return false;
    if (typeFilter !== "all" && occ.type !== typeFilter) return false;
    if (priorityFilter !== "all" && occ.priority !== priorityFilter) return false;
    return true;
  });

  const allMarkets = Array.from(new Set(allOccasions.flatMap((o) => o.markets))).sort();

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search occasions…" value={q} onChange={(e) => setQ(e.target.value)}
              className="pl-8 h-8 w-48 text-xs" />
          </div>
          <Select value={marketFilter} onValueChange={setMarketFilter}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="Market" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All markets</SelectItem>
              {allMarkets.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {types.map((t) => <SelectItem key={t.id} value={t.name.toLowerCase()}>{t.name}</SelectItem>)}
              <SelectItem value="religious">Religious</SelectItem>
              <SelectItem value="seasonal">Seasonal</SelectItem>
              <SelectItem value="promotional">Promotional</SelectItem>
              <SelectItem value="personal">Personal</SelectItem>
              <SelectItem value="corporate">Corporate</SelectItem>
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="h-8 w-24 text-xs"><SelectValue placeholder="Priority" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          {realIsOwner && (
            <Button variant="outline" size="sm" onClick={() => setTypesModalOpen(true)}>
              <Settings size={14} className="mr-1.5" /> Manage types
            </Button>
          )}
          {realIsOwner && (
            <Button size="sm" onClick={() => setLocation("/occasion-campaigns/occasions/new")}>
              <Plus size={14} className="mr-1.5" /> Create occasion
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">No occasions found.</p>
              {realIsOwner && (
                <Button variant="outline" size="sm" className="mt-4"
                  onClick={() => setLocation("/occasion-campaigns/occasions/new")}>
                  <Plus size={14} className="mr-1.5" /> Create your first occasion
                </Button>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Type</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Priority</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Markets</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Phase</th>
                  <th className="w-8 px-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((occ) => (
                  <tr key={occ.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <button className="text-left" onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}>
                        <div className="font-medium hover:underline">{occ.name}</div>
                        {occ.status === "archived" && (
                          <span className="text-xs text-muted-foreground">(archived)</span>
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <Badge variant="outline" className={cn("text-xs capitalize", TYPE_COLOR[occ.type])}>
                        {occ.type.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <Badge variant="outline" className={cn("text-xs capitalize", PRIORITY_COLOR[occ.priority])}>
                        {occ.priority}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-muted-foreground text-xs">
                      {occ.next_occurrence ?? "—"}
                      {occ.days_until !== null && <span className="ml-1">({occ.days_until}d)</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {occ.markets.slice(0, 3).map((m) => (
                          <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>
                        ))}
                        {occ.markets.length > 3 && (
                          <span className="text-xs text-muted-foreground">+{occ.markets.length - 3}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <PhaseBadge phase={occ.campaign_phase} />
                    </td>
                    <td className="px-2 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}>
                            <Eye size={14} className="mr-2" /> View
                          </DropdownMenuItem>
                          {realIsOwner && (
                            <DropdownMenuItem onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}/edit`)}>
                              <Edit2 size={14} className="mr-2" /> Edit
                            </DropdownMenuItem>
                          )}
                          {realIsOwner && (
                            <DropdownMenuItem onClick={() => duplicateMutation.mutate(occ.id)}>
                              <Copy size={14} className="mr-2" /> Duplicate
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {realIsOwner && (
                            <DropdownMenuItem onClick={() => archiveMutation.mutate({ id: occ.id, archive: occ.status !== "archived" })}>
                              <Archive size={14} className="mr-2" />
                              {occ.status === "archived" ? "Unarchive" : "Archive"}
                            </DropdownMenuItem>
                          )}
                          {realIsOwner && occ.status === "archived" && (
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(occ)}>
                              <Trash2 size={14} className="mr-2" /> Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Occasion Types Modal */}
      <OccasionTypesModal open={typesModalOpen} onClose={() => setTypesModalOpen(false)} />

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete occasion</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete &ldquo;{deleteTarget?.name}&rdquo;?
              This cannot be undone. If this occasion has campaign plans, it cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
