import { useTranslation } from "react-i18next";
import { Globe, Search, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { StoreFunnelBreakdownItem } from "@workspace/api-client-react";

export const SOURCE_ICON: Record<string, React.ReactNode> = {
  direct: <Globe size={12} className="shrink-0 text-slate-500" />,
  organic_search: <Search size={12} className="shrink-0 text-green-600" />,
  google: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />,
  googleads: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-blue-400" />,
  ig: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-pink-500" />,
  fb: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600" />,
  social: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-purple-500" />,
  referral: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" />,
  email: <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-sky-500" />,
  "youtube.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" />,
  "chatgpt.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />,
  "tiktok.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-slate-900" />,
  "twitter.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-sky-400" />,
  "x.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-slate-800" />,
  "linkedin.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-blue-700" />,
  "snapchat.com": <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-yellow-400" />,
};

export const SOURCE_LABEL: Record<string, string> = {
  direct: "Direct",
  organic_search: "Organic Search",
  ig: "Instagram",
  fb: "Facebook",
  google: "Google",
  googleads: "Google Ads",
  social: "Social",
  referral: "Referral",
  email: "Email",
  "youtube.com": "YouTube",
  "chatgpt.com": "ChatGPT",
  "tiktok.com": "TikTok",
  "twitter.com": "Twitter",
  "x.com": "X (Twitter)",
  "linkedin.com": "LinkedIn",
  "snapchat.com": "Snapchat",
};

const TLD_PATTERN = /\.(com|net|org|io|co|app|ai|me|uk|ae|sa|fr|de|it|es|jp|in|br|ru|nl|au|ca|mx)(\.[a-z]{2})?$/;

export function formatSourceLabel(value: string): string {
  if (SOURCE_LABEL[value]) return SOURCE_LABEL[value];
  const stripped = value.replace(TLD_PATTERN, "");
  return stripped
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const UNKNOWN_DOT = (
  <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" />
);

export function convRateClass(rate: number): string {
  if (rate === 0) return "text-muted-foreground";
  if (rate < 0.5) return "text-muted-foreground";
  if (rate < 2) return "text-amber-600 dark:text-amber-400";
  return "text-green-700 dark:text-green-400";
}

function formatInt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function BreakdownCard({
  title,
  items,
  labelFor,
  onRowClick,
}: {
  title: string;
  items: StoreFunnelBreakdownItem[];
  labelFor?: (value: string) => string;
  onRowClick?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const totalSessions = items.reduce((sum, it) => sum + it.sessions, 0);
  const maxSessions = items.length > 0 ? items[0].sessions : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length > 0 ? (
          <TooltipProvider delayDuration={300}>
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                <span>{t("storeAnalytics.funnel.dimension")}</span>
                <div className="flex gap-6">
                  <span className="w-24 text-right">{t("storeAnalytics.funnel.sessions")}</span>
                  <span className="w-16 text-right">{t("storeAnalytics.funnel.convRate")}</span>
                </div>
              </div>
              {items.map((it, i) => {
                const label = labelFor ? labelFor(it.value) : it.value;
                const sessionSharePct =
                  totalSessions > 0 ? (it.sessions / totalSessions) * 100 : 0;
                const barWidthPct =
                  maxSessions > 0 ? (it.sessions / maxSessions) * 100 : 0;
                const sessionShareLabel = `(${Math.round(sessionSharePct)}%)`;
                const isTop = i === 0;
                const needsTruncation = label.length > 28;
                const icon = SOURCE_ICON[it.value] ?? UNKNOWN_DOT;
                const clickable = !!onRowClick;
                return (
                  <div
                    key={`${it.value}-${i}`}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => onRowClick(it.value) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(it.value);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "relative flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50",
                      isTop && "bg-teal-50/60 dark:bg-teal-900/20",
                      clickable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500",
                    )}
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 rounded-md bg-teal-500/[0.07]"
                      style={{
                        insetInlineStart: 0,
                        insetInlineEnd: "auto",
                        width: `${barWidthPct}%`,
                      }}
                    />
                    <div className="relative flex min-w-0 flex-1 items-center gap-1.5 pe-2">
                      {icon}
                      {needsTruncation ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="max-w-[160px] truncate" style={{ cursor: "inherit" }}>
                              {label}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <span className="max-w-[280px] break-all">{label}</span>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="truncate">{label}</span>
                      )}
                    </div>
                    <div className="relative flex shrink-0 items-center gap-6">
                      <span className="w-24 text-right tabular-nums text-muted-foreground">
                        {formatInt(it.sessions)}{" "}
                        <span className="text-xs">{sessionShareLabel}</span>
                      </span>
                      <span
                        className={cn(
                          "w-16 text-right tabular-nums",
                          convRateClass(it.conversionRate),
                        )}
                      >
                        {formatPct(it.conversionRate)}
                      </span>
                      {clickable && (
                        <ChevronRight
                          size={14}
                          className="shrink-0 text-muted-foreground/50"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </TooltipProvider>
        ) : (
          <div className="flex h-[120px] items-center justify-center text-center text-sm text-muted-foreground">
            {t("storeAnalytics.noData")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
