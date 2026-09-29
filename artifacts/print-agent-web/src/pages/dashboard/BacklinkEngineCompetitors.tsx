import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

interface Competitor {
  id: number;
  domain: string;
  market: string;
  active: boolean;
  last_synced_at: string | null;
  created_at: string;
}

export default function BacklinkEngineCompetitors() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [domain, setDomain] = useState("");
  const [market, setMarket] = useState("uae");
  const [syncingId, setSyncingId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["backlink-engine", "competitors"],
    queryFn: () => apiFetch<{ competitors: Competitor[] }>("/api/backlink-engine/competitors"),
    staleTime: 30_000,
  });

  const competitors = data?.competitors ?? [];

  const addMutation = useMutation({
    mutationFn: (body: { domain: string; market: string }) =>
      apiFetch("/api/backlink-engine/competitors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "competitors"] });
      setShowAdd(false);
      setDomain("");
      toast({ title: t("backlinkEngine.competitors.added") });
    },
    onError: (err: { message?: string }) => {
      toast({ variant: "destructive", title: t("common.error"), description: err?.message ?? t("common.somethingWentWrong") });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/backlink-engine/competitors/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "competitors"] });
      toast({ title: t("backlinkEngine.competitors.deleted") });
    },
    onError: () => toast({ variant: "destructive", title: t("common.error") }),
  });

  async function handleSync(id: number) {
    setSyncingId(id);
    try {
      const r = await apiFetch<{ ok: boolean; discovered: number }>(`/api/backlink-engine/competitors/${id}/sync`, { method: "POST" });
      toast({ title: t("backlinkEngine.competitors.synced", { count: r.discovered }) });
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "competitors"] });
    } catch {
      toast({ variant: "destructive", title: t("common.error") });
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backlinkEngine.competitors.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.competitors.subtitle")}</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("backlinkEngine.competitors.add")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : competitors.length === 0 ? (
            <p className="p-8 text-center text-muted-foreground text-sm">{t("backlinkEngine.competitors.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.domain")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.market")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.competitors.lastSynced")}</th>
                  <th className="p-3 text-start font-medium">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {competitors.map((comp) => (
                  <tr key={comp.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3 font-medium">{comp.domain}</td>
                    <td className="p-3"><Badge variant="outline">{comp.market.toUpperCase()}</Badge></td>
                    <td className="p-3 text-muted-foreground hidden md:table-cell">
                      {comp.last_synced_at ? new Date(comp.last_synced_at).toLocaleDateString() : t("backlinkEngine.competitors.never")}
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => handleSync(comp.id)} disabled={syncingId === comp.id}>
                          <RefreshCw className={`h-3 w-3 me-1 ${syncingId === comp.id ? "animate-spin" : ""}`} />
                          {t("backlinkEngine.competitors.sync")}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(comp.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Add dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backlinkEngine.competitors.addTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>{t("backlinkEngine.fields.domain")}</Label>
              <Input
                className="mt-1"
                placeholder="example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("backlinkEngine.fields.market")}</Label>
              <Select value={market} onValueChange={setMarket}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="uae">UAE</SelectItem>
                  <SelectItem value="lb">Lebanon</SelectItem>
                  <SelectItem value="global">Global</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => addMutation.mutate({ domain: domain.trim().toLowerCase().replace(/^https?:\/\//, ""), market })}
              disabled={!domain.trim() || addMutation.isPending}
            >
              {t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
