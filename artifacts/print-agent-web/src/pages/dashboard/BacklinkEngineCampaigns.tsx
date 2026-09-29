import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus } from "lucide-react";

interface Campaign {
  id: number;
  name: string;
  market: string | null;
  opportunity_type: string | null;
  status: string;
  cooling_period_days: number;
  max_followups: number;
  created_at: string;
  draft_count: string;
  approved_count: string;
  sent_count: string;
}

export default function BacklinkEngineCampaigns() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [market, setMarket] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["backlink-engine", "campaigns"],
    queryFn: () => apiFetch<{ campaigns: Campaign[] }>("/api/backlink-engine/campaigns"),
    staleTime: 30_000,
  });

  const campaigns = data?.campaigns ?? [];

  const createMutation = useMutation({
    mutationFn: (body: { name: string; market?: string }) =>
      apiFetch("/api/backlink-engine/campaigns", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "campaigns"] });
      setShowCreate(false);
      setName("");
      toast({ title: t("backlinkEngine.campaigns.created") });
    },
    onError: () => toast({ variant: "destructive", title: t("common.error") }),
  });

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backlinkEngine.campaigns.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.campaigns.subtitle")}</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 me-2" />
          {t("backlinkEngine.campaigns.new")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
          ) : campaigns.length === 0 ? (
            <p className="p-8 text-center text-muted-foreground text-sm">{t("backlinkEngine.campaigns.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.name")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.fields.market")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.campaigns.messages")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.status")}</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3">
                      <p className="font-medium">{c.name}</p>
                      {c.opportunity_type && <p className="text-xs text-muted-foreground">{c.opportunity_type}</p>}
                    </td>
                    <td className="p-3 hidden md:table-cell">
                      {c.market ? <Badge variant="outline">{c.market.toUpperCase()}</Badge> : "—"}
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2 flex-wrap text-xs">
                        <span className="text-muted-foreground">{t("backlinkEngine.campaigns.draft")}: {c.draft_count}</span>
                        <span className="text-amber-600">{t("backlinkEngine.campaigns.approved")}: {c.approved_count}</span>
                        <span className="text-green-600">{t("backlinkEngine.campaigns.sent")}: {c.sent_count}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      <Badge variant={c.status === "active" ? "default" : "secondary"}>
                        {t(`backlinkEngine.status.${c.status}`, { defaultValue: c.status })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backlinkEngine.campaigns.newTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>{t("backlinkEngine.fields.name")}</Label>
              <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("backlinkEngine.campaigns.namePlaceholder")} />
            </div>
            <div>
              <Label>{t("backlinkEngine.fields.market")} ({t("common.optional")})</Label>
              <Input className="mt-1" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="uae, lb, global" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>{t("common.cancel")}</Button>
            <Button
              onClick={() => createMutation.mutate({ name: name.trim(), market: market.trim() || undefined })}
              disabled={!name.trim() || createMutation.isPending}
            >
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
