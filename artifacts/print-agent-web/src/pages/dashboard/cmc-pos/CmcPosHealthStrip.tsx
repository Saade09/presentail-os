import { Link } from "wouter";
import { CheckCircle2, AlertTriangle, AlertCircle, ExternalLink } from "lucide-react";
import { deriveHealthSeverity, healthMessage, type HealthCounts } from "./cmcPosDashboard.helpers";

type Props = {
  counts: HealthCounts;
  /** When true, suppress the normal health strip and show an overdue action-required banner */
  isOverdue?: boolean;
  /** True when the overdue shift's linked cash session was already finalized. */
  isSessionFinalized?: boolean;
  /** Called when the user clicks "Resolve now" in the overdue banner */
  onResolveOverdue?: () => void;
};

function CountPill({ count, label, color }: { count: number; label: string; color: string }) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>
      {count} {label}
    </span>
  );
}

export default function CmcPosHealthStrip({
  counts,
  isOverdue,
  isSessionFinalized,
  onResolveOverdue,
}: Props) {
  // When the shift is overdue, replace the health strip with an amber action-required banner.
  if (isOverdue) {
    return (
      <div
        className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        data-testid="health-strip-overdue"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
        <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <span className="text-sm font-semibold text-amber-800">Action required</span>
          <span className="text-sm text-amber-700">
            {isSessionFinalized
              ? "The cash session is already finalized; this shift still needs to be closed."
              : "This shift's cash session is still open and needs to be closed."}
          </span>
        </div>
        <button
          type="button"
          data-testid="link-resolve-overdue"
          className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-900 transition-colors shrink-0"
          onClick={onResolveOverdue}
        >
          {isSessionFinalized ? "Close shift" : "Resolve now"}
          <ExternalLink className="h-3 w-3" />
        </button>
      </div>
    );
  }

  const severity = deriveHealthSeverity(counts);
  const message = healthMessage(severity);

  const bg =
    severity === "ok"
      ? "bg-emerald-50 border-emerald-200"
      : severity === "critical"
        ? "bg-red-50 border-red-200"
        : "bg-amber-50 border-amber-200";

  const Icon =
    severity === "ok"
      ? CheckCircle2
      : severity === "critical"
        ? AlertCircle
        : AlertTriangle;

  const iconColor =
    severity === "ok"
      ? "text-emerald-600"
      : severity === "critical"
        ? "text-red-600"
        : "text-amber-600";

  const textColor =
    severity === "ok"
      ? "text-emerald-800"
      : severity === "critical"
        ? "text-red-800"
        : "text-amber-800";

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${bg}`}
      data-testid="health-strip"
    >
      <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
      <span className={`text-sm font-medium ${textColor}`}>{message}</span>

      {/* Count pills */}
      <div className="flex flex-wrap gap-1.5">
        <CountPill
          count={counts.pendingRequests}
          label={`pending request${counts.pendingRequests !== 1 ? "s" : ""}`}
          color="bg-amber-100 text-amber-800"
        />
        <CountPill
          count={counts.paymentIssues}
          label={`payment issue${counts.paymentIssues !== 1 ? "s" : ""}`}
          color="bg-red-100 text-red-800"
        />
        <CountPill
          count={counts.stockAlerts}
          label={`stock alert${counts.stockAlerts !== 1 ? "s" : ""}`}
          color="bg-orange-100 text-orange-800"
        />
      </div>

      {/* Audit link */}
      <Link href="/cmc-pos/audit" asChild>
        <a
          data-testid="link-open-audit"
          className="ms-auto inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          Open CMC Audit
          <ExternalLink className="h-3 w-3" />
        </a>
      </Link>
    </div>
  );
}
