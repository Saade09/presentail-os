import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, ChevronLeft, ChevronRight, ExternalLink, CheckCircle, XCircle, AlertCircle } from "lucide-react";

interface BacklinkLink {
  id: number;
  source_url: string;
  destination_url: string;
  anchor_text: string | null;
  rel_type: string;
  status: string;
  http_status: number | null;
  first_seen_at: string;
  last_checked_at: string | null;
}

interface LinksResponse {
  links: BacklinkLink[];
  total: number;
  page: number;
  limit: number;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "live") return <CheckCircle className="h-4 w-4 text-green-500" />;
  if (status === "lost") return <XCircle className="h-4 w-4 text-red-500" />;
  return <AlertCircle className="h-4 w-4 text-amber-500" />;
}

export default function BacklinkEngineMonitor() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [relType, setRelType] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [destUrl, setDestUrl] = useState("");
  const [anchor, setAnchor] = useState("");

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (status !== "all") params.set("status", status);
  if (relType !== "all") params.set("relType", relType);

  const { data, isLoading } = useQuery({
    queryKey: ["backlink-engine", "links", page, status, relType],
    queryFn: () => apiFetch<LinksResponse>(`/api/backlink-engine/links?${params}`),
    staleTime: 30_000,
  });

  const links = data?.links ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  const addMutation = useMutation({
    mutationFn: (body: { sourceUrl: string; destinationUrl: string; anchorText?: string; relType: string }) =>
      apiFetch("/api/backlink-engine/links", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "links"] });
      setShowAdd(false);
      setSourceUrl(""); setDestUrl(""); setAnchor("");
      toast({ title: t("backlinkEngine.monitor.linkAdded") });
    },
    onError: () => toast({ variant: "destructive", title: t("common.error") }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiFetch(`/api/backlink-engine/links/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["backlink-engine", "links"] }),
    onError: () => toast({ variant: "destructive", title: t("common.error") }),
  });

  const liveCount = links.filter((l) => l.status === "live").length;
  const lostCount = links.filter((l) => l.status === "lost").length;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backlinkEngine.monitor.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.monitor.subtitle")}</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("backlinkEngine.monitor.addLink")}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <div>
              <p className="text-xl font-bold">{total}</p>
              <p className="text-xs text-muted-foreground">{t("backlinkEngine.monitor.totalTracked")}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <div>
              <p className="text-xl font-bold text-green-600">{liveCount}</p>
              <p className="text-xs text-muted-foreground">{t("backlinkEngine.monitor.live")}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <XCircle className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-xl font-bold text-red-600">{lostCount}</p>
              <p className="text-xs text-muted-foreground">{t("backlinkEngine.monitor.lost")}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            <SelectItem value="live">{t("backlinkEngine.monitor.live")}</SelectItem>
            <SelectItem value="lost">{t("backlinkEngine.monitor.lost")}</SelectItem>
            <SelectItem value="redirected">{t("backlinkEngine.monitor.redirected")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={relType} onValueChange={(v) => { setRelType(v); setPage(1); }}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            <SelectItem value="follow">Dofollow</SelectItem>
            <SelectItem value="nofollow">Nofollow</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : links.length === 0 ? (
            <p className="p-8 text-center text-muted-foreground text-sm">{t("backlinkEngine.monitor.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.monitor.sourceUrl")}</th>
                  <th className="p-3 text-start font-medium hidden lg:table-cell">{t("backlinkEngine.monitor.anchorText")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.monitor.relType")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.status")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.monitor.lastChecked")}</th>
                  <th className="p-3 text-start font-medium">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3">
                      <a href={link.source_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:underline max-w-[200px] truncate">
                        {link.source_url.replace(/^https?:\/\//, "").slice(0, 40)}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </td>
                    <td className="p-3 hidden lg:table-cell text-muted-foreground">{link.anchor_text ?? "—"}</td>
                    <td className="p-3 hidden md:table-cell">
                      <Badge variant="outline">{link.rel_type}</Badge>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={link.status} />
                        <span className={link.status === "live" ? "text-green-700" : link.status === "lost" ? "text-red-700" : "text-amber-700"}>
                          {link.status}
                        </span>
                      </div>
                    </td>
                    <td className="p-3 hidden md:table-cell text-muted-foreground text-xs">
                      {link.last_checked_at ? new Date(link.last_checked_at).toLocaleDateString() : t("backlinkEngine.competitors.never")}
                    </td>
                    <td className="p-3">
                      {link.status === "live" && (
                        <Button size="sm" variant="ghost" onClick={() => updateMutation.mutate({ id: link.id, status: "lost" })}>
                          {t("backlinkEngine.monitor.markLost")}
                        </Button>
                      )}
                      {link.status === "lost" && (
                        <Button size="sm" variant="ghost" onClick={() => updateMutation.mutate({ id: link.id, status: "live" })}>
                          {t("backlinkEngine.monitor.markLive")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t("common.showingOf", { count: links.length, total })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="px-3 py-1">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backlinkEngine.monitor.addLinkTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>{t("backlinkEngine.monitor.sourceUrl")}</Label>
              <Input className="mt-1" placeholder="https://example.com/page" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
            </div>
            <div>
              <Label>{t("backlinkEngine.monitor.destinationUrl")}</Label>
              <Input className="mt-1" placeholder="https://presentail.com/..." value={destUrl} onChange={(e) => setDestUrl(e.target.value)} />
            </div>
            <div>
              <Label>{t("backlinkEngine.monitor.anchorText")} ({t("common.optional")})</Label>
              <Input className="mt-1" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => addMutation.mutate({ sourceUrl: sourceUrl.trim(), destinationUrl: destUrl.trim(), anchorText: anchor.trim() || undefined, relType: "follow" })}
              disabled={!sourceUrl.trim() || !destUrl.trim() || addMutation.isPending}
            >
              {t("backlinkEngine.monitor.trackLink")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
