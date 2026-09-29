import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Receipt, Loader2, FileText, Coins } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type BillRow = {
  id: number;
  cash_session_id: number | null;
  session_number: string | null;
  drawer_id: number | null;
  drawer_name: string | null;
  drawer_code: string | null;
  location_id: number | null;
  location_name: string | null;
  currency: string;
  amount: string;
  description: string | null;
  attachment_url: string | null;
  transaction_date: string;
  created_by_name: string | null;
};

type CurrencyTotal = {
  currency: string;
  total: string;
  bill_count: number;
};

type Summary = {
  total_count: number;
  by_currency: CurrencyTotal[];
};

type LocationRow = { id: number; name: string };

function fmtMoney(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v;
}

export default function CashBills() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();

  const [location, setLocation] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (location !== "all") p.set("location_id", location);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [location, from, to]);

  const { data, isLoading } = useQuery<{ bills: BillRow[]; summary: Summary }>({
    queryKey: ["cash-bills", queryString],
    queryFn: () => apiFetch(`/api/cash-bills${queryString ? `?${queryString}` : ""}`),
  });

  const { data: locationsData } = useQuery<{ locations: LocationRow[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
  });

  const bills = data?.bills ?? [];
  const summary = data?.summary;
  const locations = locationsData?.locations ?? [];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Receipt className="h-6 w-6" /> {t("cashBills.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("cashBills.subtitle")}</p>
        </div>
      </div>

      {(summary?.by_currency?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Coins className="h-4 w-4" /> {t("cashBills.totalByCurrency")}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {summary!.by_currency.map((c) => (
                <div key={c.currency} className="flex items-baseline gap-1.5">
                  <span className="text-sm font-medium text-muted-foreground">{c.currency}</span>
                  <span className="text-lg font-bold tabular-nums">{fmtMoney(c.total)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({c.bill_count})
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cashBills.location")}</Label>
              <Select value={location} onValueChange={setLocation}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("cashBills.allLocations")}</SelectItem>
                  {locations.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cashBills.from")}</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("cashBills.to")}</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : bills.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("cashBills.empty")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">{t("cashBills.date")}</th>
                    <th className="py-2 pr-4 text-right">{t("cashBills.amount")}</th>
                    <th className="py-2 pr-4">{t("cashBills.description")}</th>
                    <th className="py-2 pr-4">{t("cashBills.drawer")}</th>
                    <th className="py-2 pr-4">{t("cashBills.locationCol")}</th>
                    <th className="py-2 pr-4">{t("cashBills.session")}</th>
                    <th className="py-2 pr-4">{t("cashBills.recordedBy")}</th>
                    <th className="py-2 pr-4">{t("cashBills.invoice")}</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const invoiceHref = imageUrl(b.attachment_url);
                    return (
                      <tr key={b.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 text-xs text-muted-foreground">
                          {new Date(b.transaction_date).toLocaleString()}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {fmtMoney(b.amount)} {b.currency}
                        </td>
                        <td className="py-2 pr-4">{b.description ?? "—"}</td>
                        <td className="py-2 pr-4">{b.drawer_name ?? "—"}</td>
                        <td className="py-2 pr-4">{b.location_name ?? "—"}</td>
                        <td className="py-2 pr-4">
                          {b.cash_session_id ? (
                            <button
                              type="button"
                              className="font-mono text-xs text-primary hover:underline"
                              onClick={() => navigate(`/cash-sessions/${b.cash_session_id}`)}
                            >
                              {b.session_number ?? `#${b.cash_session_id}`}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">{b.created_by_name ?? "—"}</td>
                        <td className="py-2 pr-4">
                          {invoiceHref ? (
                            <a
                              href={invoiceHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <FileText className="h-3.5 w-3.5" /> {t("cashBills.view")}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
