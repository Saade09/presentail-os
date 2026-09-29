import { CheckCircle2, Printer, RotateCcw, Package, Truck, Clock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { CmcReturn } from "@/hooks/useCmcReturns";
import { RETURN_REASONS, COLLECTION_METHODS } from "@/hooks/useCmcReturns";
import { useUser } from "@clerk/react";

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function collectionLabel(m: string): string {
  return COLLECTION_METHODS.find((x) => x.value === m)?.label ?? m;
}

function reasonLabel(r: string): string {
  return RETURN_REASONS.find((x) => x.value === r)?.label ?? r;
}

const COLLECTION_ICONS: Record<string, React.ElementType> = {
  next_delivery: Truck,
  asap: Clock,
  self_send: Send,
};

interface Props {
  ret: CmcReturn;
  onCreateAnother: () => void;
}

export default function CmcPosReturnsSuccess({ ret, onCreateAnother }: Props) {
  const { user } = useUser();
  const totalUnits = ret.line_items.reduce((s, l) => s + l.quantity, 0);
  const CollectionIcon = COLLECTION_ICONS[ret.collection_method] ?? Truck;

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Success header */}
      <div className="rounded-xl bg-teal-50 border border-teal-200 px-6 py-5 flex flex-col items-center text-center gap-3 print:hidden">
        <div className="h-12 w-12 rounded-full bg-teal-700 flex items-center justify-center">
          <CheckCircle2 className="h-6 w-6 text-white" />
        </div>
        <div>
          <p className="text-xs text-teal-600 font-medium uppercase tracking-wide">
            Return submitted
          </p>
          <p
            className="text-3xl font-mono font-bold text-teal-900 mt-1 tracking-wider"
            aria-label={`Return reference ${ret.reference}`}
          >
            {ret.reference}
          </p>
          <div className="mt-2">
            <Badge
              variant="outline"
              className="bg-amber-50 text-amber-700 border-amber-200"
            >
              Awaiting pickup
            </Badge>
          </div>
        </div>
      </div>

      {/* Bag label instruction */}
      <div className="flex items-start gap-2.5 rounded-md bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 print:hidden">
        <Package className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Please label the bag with the reference{" "}
          <strong className="font-mono">{ret.reference}</strong> so CMC can
          identify the return when it is collected.
        </span>
      </div>

      {/* Summary card */}
      <div className="rounded-lg border overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/20">
          <h3 className="text-sm font-semibold">Return summary</h3>
        </div>
        <div className="px-4 py-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Reference</p>
            <p className="mt-0.5 font-mono font-semibold">{ret.reference}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Status</p>
            <p className="mt-0.5 font-medium">Awaiting pickup</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Products</p>
            <p className="mt-0.5">
              {ret.line_items.length} item{ret.line_items.length !== 1 ? "s" : ""}
              {" · "}
              {totalUnits} unit{totalUnits !== 1 ? "s" : ""}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Collection method</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <CollectionIcon className="h-3.5 w-3.5 text-muted-foreground" />
              <p>{collectionLabel(ret.collection_method)}</p>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Operator</p>
            <p className="mt-0.5">
              {user?.fullName ?? ret.operator_name ?? ret.operator_email ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Branch</p>
            <p className="mt-0.5">{ret.branch_name ?? "—"}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground">Submitted</p>
            <p className="mt-0.5">
              {ret.submitted_at ? fmtTs(ret.submitted_at) : fmtTs(ret.created_at)}
            </p>
          </div>
        </div>

        {/* Line items */}
        <div className="border-t">
          <div className="px-4 py-2.5 bg-muted/10">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Items
            </p>
          </div>
          <div className="divide-y">
            {ret.line_items.map((li, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-2.5 text-sm"
              >
                {li.image_url ? (
                  <img
                    src={li.image_url}
                    alt=""
                    className="h-8 w-8 rounded border object-cover shrink-0"
                  />
                ) : (
                  <div className="h-8 w-8 rounded border bg-muted shrink-0 flex items-center justify-center">
                    <Package className="h-4 w-4 text-muted-foreground opacity-40" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{li.name_snapshot}</p>
                  {li.sku_snapshot && (
                    <p className="text-xs text-muted-foreground">{li.sku_snapshot}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-medium">×{li.quantity}</span>
                  <span className="text-xs text-muted-foreground">
                    {reasonLabel(li.reason)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 print:hidden">
        <Button
          variant="outline"
          className="gap-2"
          onClick={handlePrint}
          aria-label="Print return label"
        >
          <Printer className="h-4 w-4" />
          Print return label
        </Button>
        <Button
          className="bg-teal-700 hover:bg-teal-800 text-white gap-2"
          onClick={onCreateAnother}
          aria-label="Create another return"
        >
          <RotateCcw className="h-4 w-4" />
          Create another return
        </Button>
      </div>

      {/* ── Print-only label view ── */}
      <div className="hidden print:block print:break-before-page">
        <div style={{ fontFamily: "monospace", padding: "24px", border: "2px solid #000" }}>
          <h1 style={{ fontSize: "18px", fontWeight: "bold", marginBottom: "8px" }}>
            CMC RETURN LABEL
          </h1>
          <p style={{ fontSize: "28px", fontWeight: "bold", letterSpacing: "0.1em", marginBottom: "12px" }}>
            {ret.reference}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "12px" }}>
            <tbody>
              <tr>
                <td style={{ fontWeight: "bold", paddingRight: "12px" }}>Branch:</td>
                <td>{ret.branch_name ?? "—"}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: "bold", paddingRight: "12px" }}>Date:</td>
                <td>
                  {ret.submitted_at
                    ? new Date(ret.submitted_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "—"}
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: "bold", paddingRight: "12px" }}>Collection:</td>
                <td>{collectionLabel(ret.collection_method)}</td>
              </tr>
            </tbody>
          </table>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", border: "1px solid #000" }}>
            <thead>
              <tr style={{ background: "#eee" }}>
                <th style={{ padding: "4px 8px", textAlign: "left", border: "1px solid #000" }}>
                  Product
                </th>
                <th style={{ padding: "4px 8px", textAlign: "center", border: "1px solid #000" }}>
                  Qty
                </th>
                <th style={{ padding: "4px 8px", textAlign: "left", border: "1px solid #000" }}>
                  Reason
                </th>
              </tr>
            </thead>
            <tbody>
              {ret.line_items.map((li, i) => (
                <tr key={i}>
                  <td style={{ padding: "4px 8px", border: "1px solid #000" }}>
                    {li.name_snapshot}
                    {li.sku_snapshot ? ` (${li.sku_snapshot})` : ""}
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "center", border: "1px solid #000" }}>
                    {li.quantity}
                  </td>
                  <td style={{ padding: "4px 8px", border: "1px solid #000" }}>
                    {reasonLabel(li.reason)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: "12px", fontSize: "11px", color: "#444" }}>
            Reference: {ret.reference} | Scan or quote this reference to CMC on collection.
          </p>
        </div>
      </div>
    </div>
  );
}
