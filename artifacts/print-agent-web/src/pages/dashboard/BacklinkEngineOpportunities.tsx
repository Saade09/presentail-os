import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { Search, ChevronLeft, ChevronRight, HelpCircle, ExternalLink } from "lucide-react";

interface ScoreComponents {
  domainAuthority?: number;
  spamPenalty?: number;
  traffic?: number;
  marketFit?: number;
  marketFitAssessment?: string;
  [key: string]: number | string | undefined;
}

interface Opportunity {
  id: number;
  domain: string;
  page_url: string;
  opportunity_type: string | null;
  market: string;
  source: string | null;
  ai_score: string | null;
  ai_explanation: string | null;
  ai_score_components: ScoreComponents | null;
  status: string;
  domain_authority: string | null;
  estimated_traffic: number | null;
  spam_score: string | null;
  destination_url: string | null;
  created_at: string;
}

interface OpportunitiesResponse {
  opportunities: Opportunity[];
  total: number;
  page: number;
  limit: number;
}

const STATUS_OPTIONS = ["discovered", "qualified", "approved", "rejected", "archived"];
const MARKET_OPTIONS = ["uae", "lb", "global"];

function scoreColor(score: number): string {
  if (score >= 70) return "text-green-600";
  if (score >= 40) return "text-amber-600";
  return "text-muted-foreground";
}

function DetailDrawer({ opp, onClose, onUpdate }: { opp: Opportunity; onClose: () => void; onUpdate: (id: number, body: Record<string, unknown>) => void }) {
  const { t } = useTranslation();

  const score = opp.ai_score ? parseFloat(opp.ai_score) : null;

  return (
    <SheetContent className="w-full sm:max-w-md overflow-y-auto">
      <SheetHeader>
        <SheetTitle>{t("backlinkEngine.opportunities.drawerTitle")}</SheetTitle>
      </SheetHeader>

      <div className="mt-6 space-y-5">
        <div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">
            {t("backlinkEngine.opportunities.detailDomain")}
          </p>
          <a
            href={opp.page_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold hover:underline flex items-center gap-1"
          >
            {opp.domain}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          <p className="text-xs text-muted-foreground break-all mt-0.5">{opp.page_url}</p>
        </div>

        <div className="grid grid-cols-3 gap-3 text-sm">
          {opp.opportunity_type && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailType")}</p>
              <p className="font-medium">{opp.opportunity_type}</p>
            </div>
          )}
          {opp.source && (
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailSource")}</p>
              <p className="font-medium">{opp.source}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailMarket")}</p>
            <p className="font-medium uppercase">{opp.market}</p>
          </div>
        </div>

        <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
            {t("backlinkEngine.fields.aiScore")}
          </p>
          {score !== null ? (
            <p className={`text-3xl font-bold tabular-nums ${scoreColor(score)}`}>
              {score.toFixed(0)}
              <span className="text-base font-normal text-muted-foreground">/100</span>
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">—</p>
          )}

          <div>
            <p className="text-xs text-muted-foreground font-medium mb-1">
              {t("backlinkEngine.opportunities.detailExplanation")}
            </p>
            {opp.ai_explanation ? (
              <p className="text-sm leading-relaxed">{opp.ai_explanation}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                {t("backlinkEngine.opportunities.noReason")}
              </p>
            )}
          </div>

          {opp.ai_score_components?.marketFitAssessment && (
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
              <p className="text-xs text-muted-foreground font-medium mb-0.5">
                {t("backlinkEngine.opportunities.detailMarketFit")}
              </p>
              <p className="text-sm font-medium">{opp.ai_score_components.marketFitAssessment}</p>
            </div>
          )}

          {(() => {
            const numericComponents = opp.ai_score_components
              ? Object.entries(opp.ai_score_components).filter(([, val]) => typeof val === "number")
              : [];
            return numericComponents.length > 0 ? (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-2">
                  {t("backlinkEngine.opportunities.detailComponents")}
                </p>
                <div className="space-y-1.5">
                  {numericComponents.map(([key, val]) => (
                    <div key={key}>
                      <div className="flex justify-between mb-0.5">
                        <span className="text-xs capitalize">{key.replace(/([A-Z])/g, " $1").trim()}</span>
                        <span className="text-xs font-medium tabular-nums">{(val as number).toFixed(0)}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all"
                          style={{ width: `${Math.min(100, Math.max(0, val as number))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })()}
        </div>

        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailAuthority")}</p>
            <p className="font-medium">{opp.domain_authority ? parseFloat(opp.domain_authority).toFixed(0) : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailTraffic")}</p>
            <p className="font-medium">{opp.estimated_traffic ? opp.estimated_traffic.toLocaleString() : "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">{t("backlinkEngine.opportunities.detailSpam")}</p>
            <p className="font-medium">{opp.spam_score ? parseFloat(opp.spam_score).toFixed(0) : "—"}</p>
          </div>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("backlinkEngine.fields.status")}</p>
          <Badge variant={opp.status === "approved" || opp.status === "qualified" ? "default" : opp.status === "rejected" || opp.status === "archived" ? "destructive" : "secondary"}>
            {t(`backlinkEngine.status.${opp.status}`, { defaultValue: opp.status })}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-2 pt-2 border-t">
          {opp.status === "discovered" && (
            <Button size="sm" variant="outline" onClick={() => { onUpdate(opp.id, { status: "qualified" }); onClose(); }}>
              {t("backlinkEngine.actions.qualify")}
            </Button>
          )}
          {opp.status === "qualified" && (
            <Button size="sm" onClick={() => { onUpdate(opp.id, { status: "approved" }); onClose(); }}>
              {t("backlinkEngine.actions.approve")}
            </Button>
          )}
          {!["rejected", "archived"].includes(opp.status) && (
            <Button size="sm" variant="ghost" onClick={() => { onUpdate(opp.id, { status: "rejected" }); onClose(); }}>
              {t("backlinkEngine.actions.reject")}
            </Button>
          )}
        </div>
      </div>
    </SheetContent>
  );
}

export default function BacklinkEngineOpportunities() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [market, setMarket] = useState<string>("all");
  const [selected, setSelected] = useState<Opportunity | null>(null);

  const params = new URLSearchParams({ page: String(page), limit: "20" });
  if (q) params.set("q", q);
  if (status !== "all") params.set("status", status);
  if (market !== "all") params.set("market", market);

  const { data, isLoading } = useQuery({
    queryKey: ["backlink-engine", "opportunities", page, q, status, market],
    queryFn: () => apiFetch<OpportunitiesResponse>(`/api/backlink-engine/opportunities?${params}`),
    staleTime: 30_000,
  });

  const opportunities = data?.opportunities ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / 20);

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/backlink-engine/opportunities/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "opportunities"] });
    },
    onError: () => toast({ variant: "destructive", title: t("common.error"), description: t("common.somethingWentWrong") }),
  });

  function statusBadgeVariant(s: string): "default" | "secondary" | "outline" | "destructive" {
    if (s === "approved" || s === "qualified") return "default";
    if (s === "rejected" || s === "archived") return "destructive";
    return "secondary";
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backlinkEngine.opportunities.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.opportunities.subtitle")}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="ps-9"
            placeholder={t("backlinkEngine.opportunities.search")}
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("backlinkEngine.fields.status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>{t(`backlinkEngine.status.${s}`, { defaultValue: s })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={market} onValueChange={(v) => { setMarket(v); setPage(1); }}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder={t("backlinkEngine.fields.market")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            {MARKET_OPTIONS.map((m) => (
              <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
          ) : opportunities.length === 0 ? (
            <p className="p-8 text-center text-muted-foreground text-sm">{t("backlinkEngine.opportunities.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.domain")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.fields.domainAuthority")}</th>
                  <th className="p-3 text-start font-medium hidden lg:table-cell">{t("backlinkEngine.fields.estimatedTraffic")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.aiScore")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.status")}</th>
                  <th className="p-3 text-start font-medium">{t("common.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opp) => {
                  const score = opp.ai_score ? parseFloat(opp.ai_score) : null;
                  return (
                    <tr
                      key={opp.id}
                      className="border-b last:border-0 hover:bg-muted/20 cursor-pointer"
                      onClick={() => setSelected(opp)}
                    >
                      <td className="p-3">
                        <a
                          href={opp.page_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {opp.domain}
                        </a>
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{opp.page_url}</p>
                        {opp.source && <p className="text-xs text-muted-foreground">{opp.source}</p>}
                      </td>
                      <td className="p-3 hidden md:table-cell">{opp.domain_authority ? parseFloat(opp.domain_authority).toFixed(0) : "—"}</td>
                      <td className="p-3 hidden lg:table-cell">{opp.estimated_traffic ? opp.estimated_traffic.toLocaleString() : "—"}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          {score !== null ? (
                            <span className={`font-bold ${scoreColor(score)}`}>
                              {score.toFixed(0)}
                            </span>
                          ) : "—"}
                          {opp.ai_explanation && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  className="text-muted-foreground hover:text-foreground transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label={t("backlinkEngine.opportunities.aiReasonTitle")}
                                >
                                  <HelpCircle className="h-3.5 w-3.5" />
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-72 text-sm" side="top">
                                <p className="font-medium mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                                  {t("backlinkEngine.opportunities.aiReasonTitle")}
                                </p>
                                <p className="leading-relaxed">{opp.ai_explanation}</p>
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge variant={statusBadgeVariant(opp.status)}>
                          {t(`backlinkEngine.status.${opp.status}`, { defaultValue: opp.status })}
                        </Badge>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
                          {opp.status === "discovered" && (
                            <Button size="sm" variant="outline" onClick={() => updateMutation.mutate({ id: opp.id, body: { status: "qualified" } })}>
                              {t("backlinkEngine.actions.qualify")}
                            </Button>
                          )}
                          {opp.status === "qualified" && (
                            <Button size="sm" onClick={() => updateMutation.mutate({ id: opp.id, body: { status: "approved" } })}>
                              {t("backlinkEngine.actions.approve")}
                            </Button>
                          )}
                          {!["rejected", "archived"].includes(opp.status) && (
                            <Button size="sm" variant="ghost" onClick={() => updateMutation.mutate({ id: opp.id, body: { status: "rejected" } })}>
                              {t("backlinkEngine.actions.reject")}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{t("common.showingOf", { count: opportunities.length, total })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-3 py-1">{page} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        {selected && (
          <DetailDrawer
            opp={selected}
            onClose={() => setSelected(null)}
            onUpdate={(id, body) => updateMutation.mutate({ id, body })}
          />
        )}
      </Sheet>
    </div>
  );
}
