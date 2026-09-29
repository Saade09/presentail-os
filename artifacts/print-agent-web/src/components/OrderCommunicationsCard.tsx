import React from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthedSse } from "@/hooks/use-authed-sse";
import {
  useListOrderCommunications,
  getListOrderCommunicationsQueryKey,
  useSendOrderCommunication,
  useListOrderActivity,
  getListOrderActivityQueryKey,
} from "@workspace/api-client-react";
import type { OrderCommunication } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Mail,
  Send,
  Loader2,
  MoreHorizontal,
  Copy,
  RefreshCw,
  Plus,
  AlertCircle,
  Star,
  MessageCircle,
  ChevronDown,
} from "lucide-react";

const TEMPLATE_TYPES = [
  "order_confirmation",
  "payment_instructions",
  "payment_received",
  "status_update",
  "refund",
] as const;

type TemplateType = (typeof TEMPLATE_TYPES)[number];

const GREEN_STATUSES = new Set(["sent", "accepted", "delivered", "opened", "clicked"]);
const RED_STATUSES = new Set(["failed", "bounced", "dropped", "suppressed"]);
const AMBER_STATUSES = new Set(["deferred"]);

export function commStatusBadgeClass(status: string): string {
  if (GREEN_STATUSES.has(status))
    return "bg-green-100 text-green-800 border-green-300 hover:bg-green-100";
  if (RED_STATUSES.has(status))
    return "bg-red-100 text-red-800 border-red-300 hover:bg-red-100";
  if (AMBER_STATUSES.has(status))
    return "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100";
  return "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary";
}

const TP_GREEN = new Set(["created"]);
const TP_RED = new Set(["failed"]);
const TP_AMBER = new Set(["pending", "processing"]);

function trustpilotStatusBadgeClass(status: string): string {
  if (TP_GREEN.has(status))
    return "bg-green-100 text-green-800 border-green-300 hover:bg-green-100";
  if (TP_RED.has(status))
    return "bg-red-100 text-red-800 border-red-300 hover:bg-red-100";
  if (TP_AMBER.has(status))
    return "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100";
  return "bg-secondary text-secondary-foreground border-transparent hover:bg-secondary";
}

type TrustpilotInvitation = {
  id: string;
  status: string;
  recipient_email: string | null;
  preferred_send_time: string | null;
  last_attempt_at: string | null;
  created_at: string;
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function OrderCommunicationsCard({
  orderId,
  canEdit,
  trustpilotInvitation,
  trustpilotEnabled,
  orderStatus,
  canSendWhatsappPaymentInstructions = false,
}: {
  orderId: string;
  canEdit: boolean;
  trustpilotInvitation?: TrustpilotInvitation | null;
  trustpilotEnabled?: boolean;
  orderStatus?: string | null;
  canSendWhatsappPaymentInstructions?: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = React.useState<OrderCommunication | null>(null);
  const [addEmailOpen, setAddEmailOpen] = React.useState(false);
  const [addEmailValue, setAddEmailValue] = React.useState("");
  const [addEmailTemplate, setAddEmailTemplate] =
    React.useState<TemplateType>("order_confirmation");
  const [showAll, setShowAll] = React.useState(false);
  const [isCollapsed, setIsCollapsed] = React.useState(false);

  const { data, isLoading, isError, refetch } = useListOrderCommunications(orderId, {
    query: { queryKey: getListOrderCommunicationsQueryKey(orderId) },
  });
  const sendMut = useSendOrderCommunication();

  useAuthedSse("/api/events", true, {
    "order.comm_status_updated": (raw) => {
      try {
        const parsed = JSON.parse(raw) as {
          data?: { orderId?: string };
        };
        if (parsed.data?.orderId === orderId) {
          void queryClient.invalidateQueries({
            queryKey: getListOrderCommunicationsQueryKey(orderId),
          });
        }
      } catch {
        // ignore parse errors
      }
    },
  });

  const comms = data?.communications ?? [];
  const customerEmail = data?.customerEmail ?? null;
  const whatsappEligible = data?.whatsappEligible === true;

  const acceptedCount = comms.filter((c) => GREEN_STATUSES.has(c.status)).length;
  const problemCount = comms.filter(
    (c) => RED_STATUSES.has(c.status) || c.status === "not_sent",
  ).length;

  const templateLabel = (templateType: string) =>
    t(`orders.comms.template.${templateType}`, {
      defaultValue: templateType.replace(/_/g, " "),
    });

  const statusLabel = (status: string) =>
    t(`orders.comms.status.${status}`, {
      defaultValue: status.replace(/_/g, " "),
    });

  const statusUpdateContext = (communication: OrderCommunication) => {
    if (communication.channel === "whatsapp" || communication.templateType !== "status_update") {
      return null;
    }
    return (
      communication.subject?.trim() ||
      t("orders.comms.statusUpdateFallback", {
        defaultValue: "Status update email",
      })
    );
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListOrderCommunicationsQueryKey(orderId),
    });
    void queryClient.invalidateQueries({
      queryKey: getListOrderActivityQueryKey(orderId),
    });
  };

  const doSend = (
    templateType: TemplateType,
    opts?: { communicationId?: string; email?: string; channel?: "email" | "whatsapp" },
  ) => {
    sendMut.mutate(
      {
        id: orderId,
        data: {
          templateType,
          ...(opts?.communicationId ? { communicationId: opts.communicationId } : {}),
          ...(opts?.email ? { email: opts.email } : {}),
          ...(opts?.channel ? { channel: opts.channel } : {}),
        },
      },
      {
        onSuccess: () => {
          toast({
            description: t(
              opts?.channel === "whatsapp"
                ? "orders.comms.whatsappSendSuccess"
                : "orders.comms.sendSuccess",
            ),
          });
          setAddEmailOpen(false);
          setSelected(null);
          invalidate();
        },
        onError: (err: unknown) => {
          const message =
            err && typeof err === "object" && "error" in err
              ? String((err as { error: unknown }).error)
              : t("orders.comms.sendError");
          toast({ variant: "destructive", description: message });
          invalidate();
        },
      },
    );
  };

  const copyEmail = (email: string) => {
    void navigator.clipboard.writeText(email).then(() => {
      toast({ description: t("orders.comms.copied") });
    });
  };

  const copyPhone = (phone: string) => {
    void navigator.clipboard.writeText(phone).then(() => {
      toast({ description: t("orders.comms.phoneCopied") });
    });
  };

  const channelLabel = (communication: OrderCommunication) =>
    t(`orders.comms.channel.${communication.channel}`, {
      defaultValue: communication.channel,
    });

  const destination = (communication: OrderCommunication) =>
    communication.channel === "whatsapp"
      ? communication.recipientPhone
      : communication.recipientEmail;

  const whatsappTemplateContext = (communication: OrderCommunication) =>
    communication.channel === "whatsapp" && communication.templateName
      ? t(`orders.comms.whatsappTemplate.${communication.templateName}`, {
          defaultValue: communication.templateName,
        })
      : null;

  const whatsappStatusTemplate =
    orderStatus === "ready_for_delivery" || orderStatus === "completed";

  const visible = showAll ? comms : comms.slice(0, 6);

  return (
    <Card data-testid="card-communications">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail size={15} className="text-muted-foreground" />
              {t("orders.comms.title")}
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("orders.comms.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {comms.length > 0 && (
              <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
                <span data-testid="text-comms-accepted-count">
                  {t("orders.comms.acceptedCount", { count: acceptedCount })}
                </span>
                <span aria-hidden>·</span>
                <span data-testid="text-comms-problem-count">
                  {t("orders.comms.problemCount", { count: problemCount })}
                </span>
              </div>
            )}
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={sendMut.isPending}
                    data-testid="button-comms-send-message"
                  >
                    {sendMut.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    {t("orders.comms.sendMessage")}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {TEMPLATE_TYPES.map((tt) => (
                    <DropdownMenuItem
                      key={tt}
                      onClick={() => {
                        if (!customerEmail) {
                          setAddEmailTemplate(tt);
                          setAddEmailValue("");
                          setAddEmailOpen(true);
                          return;
                        }
                        doSend(tt);
                      }}
                      data-testid={`menu-send-${tt}`}
                    >
                      {templateLabel(tt)}
                    </DropdownMenuItem>
                  ))}
                  <div className="my-1 border-t" />
                  <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                    {t("orders.comms.channel.whatsapp")}
                  </p>
                  <DropdownMenuItem
                    disabled={!whatsappEligible}
                    onClick={() => doSend("order_confirmation", { channel: "whatsapp" })}
                    data-testid="menu-send-whatsapp-order_confirmation"
                  >
                    <MessageCircle size={14} className="me-2" />
                    {t("orders.comms.whatsappTemplate.new_order_received")}
                  </DropdownMenuItem>
                  {whatsappStatusTemplate && (
                    <DropdownMenuItem
                      disabled={!whatsappEligible}
                      onClick={() => doSend("status_update", { channel: "whatsapp" })}
                      data-testid="menu-send-whatsapp-status_update"
                    >
                      <MessageCircle size={14} className="me-2" />
                      {t(
                        orderStatus === "completed"
                          ? "orders.comms.whatsappTemplate.order_delivered"
                          : "orders.comms.whatsappTemplate.order_ready",
                      )}
                    </DropdownMenuItem>
                  )}
                  {canSendWhatsappPaymentInstructions && (
                    <DropdownMenuItem
                      disabled={!whatsappEligible}
                      onClick={() => doSend("payment_instructions", { channel: "whatsapp" })}
                      data-testid="menu-send-whatsapp-payment_instructions"
                    >
                      <MessageCircle size={14} className="me-2" />
                      {t("orders.comms.whatsappTemplate.whish_payment_instructions")}
                    </DropdownMenuItem>
                  )}
                  {!whatsappEligible && (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                      {t("orders.comms.whatsappUnavailable")}
                    </p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-controls="comms-card-content"
              onClick={() => setIsCollapsed((v) => !v)}
              className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              data-testid="button-comms-collapse"
            >
              <ChevronDown
                size={16}
                className={`transition-transform duration-200 ${isCollapsed ? "-rotate-90" : "rotate-0"}`}
              />
            </button>
          </div>
        </div>
      </CardHeader>
      {!isCollapsed && <CardContent className="text-sm" id="comms-card-content">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 size={16} className="animate-spin" />
            {t("common.loading")}
          </div>
        ) : isError ? (
          <div
            className="flex items-center justify-between gap-2 py-3"
            data-testid="comms-error"
          >
            <p className="text-muted-foreground flex items-center gap-2">
              <AlertCircle size={15} className="text-destructive" />
              {t("orders.comms.loadError")}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t("common.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : comms.length === 0 && !(trustpilotEnabled && trustpilotInvitation) ? (
          <p className="text-muted-foreground italic py-2" data-testid="comms-empty">
            {t("orders.comms.empty")}
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b">
                    <th className="text-start font-medium py-2 pe-3">
                      {t("orders.comms.colMessage")}
                    </th>
                    <th className="text-start font-medium py-2 pe-3">
                      {t("orders.comms.colSentTo")}
                    </th>
                    <th className="text-start font-medium py-2 pe-3">
                      {t("orders.comms.colStatus")}
                    </th>
                    <th className="text-start font-medium py-2 pe-3">
                      {t("orders.comms.colLastActivity")}
                    </th>
                    <th className="text-end font-medium py-2">
                      {t("orders.comms.colActions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelected(c)}
                      data-testid={`row-comm-${c.id}`}
                    >
                      <td className="py-2.5 pe-3">
                        <div>
                          <div>
                            <span className="font-medium">{templateLabel(c.templateType)}</span>
                            <span className="ms-1.5 text-xs text-muted-foreground">
                              {channelLabel(c)}
                            </span>
                            {c.attempt > 1 && (
                              <span className="text-xs text-muted-foreground ms-1.5">
                                {t("orders.comms.attemptN", { n: c.attempt })}
                              </span>
                            )}
                          </div>
                          {statusUpdateContext(c) && (
                            <p
                              className="text-xs text-muted-foreground break-words mt-0.5"
                              data-testid={`text-comm-context-${c.id}`}
                            >
                              {statusUpdateContext(c)}
                            </p>
                          )}
                          {whatsappTemplateContext(c) && (
                            <p
                              className="text-xs text-muted-foreground break-words mt-0.5"
                              data-testid={`text-comm-whatsapp-template-${c.id}`}
                            >
                              {whatsappTemplateContext(c)}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 pe-3">
                        {destination(c) ? (
                          <span dir="ltr">{destination(c)}</span>
                        ) : (
                          <span className="text-muted-foreground italic">
                            {c.channel === "whatsapp"
                              ? t("orders.comms.noPhone")
                              : t("orders.comms.noEmail")}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pe-3">
                        {(c.status === "not_sent" || RED_STATUSES.has(c.status)) &&
                        c.failureReason ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex cursor-help"
                                  data-testid={`badge-comm-status-${c.id}`}
                                  aria-label={`${t("orders.comms.failureReasonTip")}: ${c.failureReason}`}
                                >
                                  <Badge
                                    className={`border font-medium text-xs ${commStatusBadgeClass(c.status)}`}
                                  >
                                    {statusLabel(c.status)}
                                  </Badge>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-start">
                                <p>{c.failureReason}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          <Badge
                            className={`border font-medium text-xs ${commStatusBadgeClass(c.status)}`}
                            data-testid={`badge-comm-status-${c.id}`}
                          >
                            {statusLabel(c.status)}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 pe-3 text-muted-foreground">
                        {formatDateTime(c.lastEventAt ?? c.createdAt)}
                      </td>
                      <td className="py-2.5 text-end">
                        <RowActions
                          c={c}
                          canEdit={canEdit}
                          sending={sendMut.isPending}
                          onResend={() =>
                            doSend(c.templateType as TemplateType, {
                              communicationId: c.id,
                              channel: c.channel === "whatsapp" ? "whatsapp" : "email",
                            })
                          }
                          onCopy={() => {
                            const value = destination(c);
                            if (!value) return;
                            if (c.channel === "whatsapp") copyPhone(value);
                            else copyEmail(value);
                          }}
                          onAddEmail={() => {
                            setAddEmailTemplate(c.templateType as TemplateType);
                            setAddEmailValue("");
                            setAddEmailOpen(true);
                          }}
                          t={t}
                        />
                      </td>
                    </tr>
                  ))}
                  {trustpilotEnabled && trustpilotInvitation && (
                    <tr
                      className="border-b last:border-0"
                      data-testid="row-comm-trustpilot"
                    >
                      <td className="py-2.5 pe-3">
                        <span className="font-medium flex items-center gap-1.5">
                          <Star size={13} className="text-muted-foreground shrink-0" />
                          {t("orders.trustpilotComm.label")}
                        </span>
                      </td>
                      <td className="py-2.5 pe-3">
                        {trustpilotInvitation.recipient_email ? (
                          <span dir="ltr">{trustpilotInvitation.recipient_email}</span>
                        ) : (
                          <span className="text-muted-foreground italic">
                            {t("orders.comms.noEmail")}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pe-3">
                        <Badge
                          className={`border font-medium text-xs ${trustpilotStatusBadgeClass(trustpilotInvitation.status)}`}
                          data-testid="badge-comm-status-trustpilot"
                        >
                          {t(`orders.trustpilotComm.status.${trustpilotInvitation.status}`, {
                            defaultValue: trustpilotInvitation.status,
                          })}
                        </Badge>
                      </td>
                      <td className="py-2.5 pe-3 text-muted-foreground">
                        {formatDateTime(
                          trustpilotInvitation.last_attempt_at ??
                          trustpilotInvitation.preferred_send_time ??
                          trustpilotInvitation.created_at,
                        )}
                      </td>
                      <td className="py-2.5 text-end" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile stacked cards */}
            <div className="md:hidden space-y-2">
              {visible.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className="w-full text-start rounded-md border p-3 space-y-1.5 hover:bg-muted/40"
                  onClick={() => setSelected(c)}
                  data-testid={`card-comm-${c.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div>
                        <span className="font-medium">{templateLabel(c.templateType)}</span>
                          <span className="ms-1.5 text-xs text-muted-foreground">
                            {channelLabel(c)}
                          </span>
                      </div>
                      {statusUpdateContext(c) && (
                        <p
                          className="text-xs text-muted-foreground break-words mt-0.5"
                          data-testid={`text-comm-context-${c.id}`}
                        >
                          {statusUpdateContext(c)}
                        </p>
                      )}
                        {whatsappTemplateContext(c) && (
                          <p
                            className="text-xs text-muted-foreground break-words mt-0.5"
                            data-testid={`text-comm-whatsapp-template-${c.id}`}
                          >
                            {whatsappTemplateContext(c)}
                          </p>
                        )}
                    </div>
                    {(c.status === "not_sent" || RED_STATUSES.has(c.status)) &&
                    c.failureReason ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className="inline-flex cursor-help"
                              aria-label={`${t("orders.comms.failureReasonTip")}: ${c.failureReason}`}
                            >
                              <Badge
                                className={`border font-medium text-xs ${commStatusBadgeClass(c.status)}`}
                              >
                                {statusLabel(c.status)}
                              </Badge>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-start">
                            <p>{c.failureReason}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <Badge
                        className={`border font-medium text-xs ${commStatusBadgeClass(c.status)}`}
                      >
                        {statusLabel(c.status)}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {destination(c) ??
                      (c.channel === "whatsapp"
                        ? t("orders.comms.noPhone")
                        : t("orders.comms.noEmail"))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(c.lastEventAt ?? c.createdAt)}
                  </p>
                </button>
              ))}
              {trustpilotEnabled && trustpilotInvitation && (
                <div
                  className="w-full text-start rounded-md border p-3 space-y-1.5"
                  data-testid="card-comm-trustpilot"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium flex items-center gap-1.5">
                      <Star size={13} className="text-muted-foreground shrink-0" />
                      {t("orders.trustpilotComm.label")}
                    </span>
                    <Badge
                      className={`border font-medium text-xs ${trustpilotStatusBadgeClass(trustpilotInvitation.status)}`}
                    >
                      {t(`orders.trustpilotComm.status.${trustpilotInvitation.status}`, {
                        defaultValue: trustpilotInvitation.status,
                      })}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {trustpilotInvitation.recipient_email ?? t("orders.comms.noEmail")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(
                      trustpilotInvitation.last_attempt_at ??
                      trustpilotInvitation.preferred_send_time ??
                      trustpilotInvitation.created_at,
                    )}
                  </p>
                </div>
              )}
            </div>

            {comms.length > 6 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 text-xs text-muted-foreground"
                onClick={() => setShowAll((v) => !v)}
                data-testid="button-comms-view-all"
              >
                {showAll
                  ? t("orders.comms.showLess")
                  : t("orders.comms.viewAll", { count: comms.length })}
              </Button>
            )}
          </>
        )}
      </CardContent>}

      {/* Details drawer */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{templateLabel(selected.templateType)}</SheetTitle>
                <SheetDescription>
                  {t("orders.comms.drawerSubtitle", { n: selected.attempt })}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 space-y-3 text-sm">
                <DetailRow label={t("orders.comms.channelLabel")}>
                  {channelLabel(selected)}
                </DetailRow>
                <DetailRow label={t("orders.comms.colStatus")}>
                  <Badge
                    className={`border font-medium text-xs ${commStatusBadgeClass(selected.status)}`}
                  >
                    {statusLabel(selected.status)}
                  </Badge>
                </DetailRow>
                {selected.subject && (
                  <DetailRow label={t("orders.comms.subject")}>
                    <span className="break-words">{selected.subject}</span>
                  </DetailRow>
                )}
                <DetailRow label={t("orders.comms.recipient")}>
                  {destination(selected) ? (
                    <span dir="ltr">{destination(selected)}</span>
                  ) : (
                    <span className="text-muted-foreground italic">
                      {selected.channel === "whatsapp"
                        ? t("orders.comms.noPhone")
                        : t("orders.comms.noEmail")}
                    </span>
                  )}
                </DetailRow>
                {whatsappTemplateContext(selected) && (
                  <DetailRow label={t("orders.comms.approvedTemplate")}>
                    {whatsappTemplateContext(selected)}
                  </DetailRow>
                )}
                <DetailRow label={t("orders.comms.provider")}>
                  <span className="capitalize">{selected.provider}</span>
                </DetailRow>
                {selected.providerMessageId && (
                  <DetailRow label={t("orders.comms.providerMessageId")}>
                    <span className="font-mono text-xs break-all" dir="ltr">
                      {selected.providerMessageId}
                    </span>
                  </DetailRow>
                )}
                {selected.failureReason && (
                  <DetailRow label={t("orders.comms.failureReason")}>
                    <span className="text-destructive break-words">
                      {selected.failureReason}
                    </span>
                  </DetailRow>
                )}
                {selected.triggeredByName && (
                  <DetailRow label={t("orders.comms.triggeredBy")}>
                    {selected.triggeredByName}
                  </DetailRow>
                )}
                <div className="border-t pt-3 space-y-1.5">
                  <TimestampRow label={t("orders.comms.createdAt")} value={selected.createdAt} />
                  <TimestampRow label={t("orders.comms.sentAt")} value={selected.sentAt} />
                  <TimestampRow label={t("orders.comms.deliveredAt")} value={selected.deliveredAt} />
                  <TimestampRow label={t("orders.comms.openedAt")} value={selected.openedAt} />
                  <TimestampRow label={t("orders.comms.clickedAt")} value={selected.clickedAt} />
                </div>
                <div className="border-t pt-3">
                  <p className="font-medium mb-2">{t("orders.comms.eventHistory")}</p>
                  {selected.events.length === 0 ? (
                    <p className="text-muted-foreground italic text-xs">
                      {t("orders.comms.noEvents")}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {selected.events.map((e, i) => (
                        <li key={i} className="flex items-center justify-between gap-2 text-xs">
                          <Badge
                            className={`border font-medium ${commStatusBadgeClass(e.eventType)}`}
                          >
                            {statusLabel(e.eventType)}
                          </Badge>
                          <span className="text-muted-foreground">
                            {formatDateTime(e.occurredAt)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {canEdit && destination(selected) && (
                  <div className="border-t pt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={sendMut.isPending}
                      onClick={() =>
                        doSend(selected.templateType as TemplateType, {
                          communicationId: selected.id,
                          channel:
                            selected.channel === "whatsapp" ? "whatsapp" : "email",
                        })
                      }
                      data-testid="button-drawer-resend"
                    >
                      {sendMut.isPending ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      {t("orders.comms.resend")}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Add / correct email dialog */}
      <Dialog open={addEmailOpen} onOpenChange={setAddEmailOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("orders.comms.addEmailTitle")}</DialogTitle>
            <DialogDescription>{t("orders.comms.addEmailDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="comm-add-email">{t("orders.comms.emailLabel")}</Label>
            <Input
              id="comm-add-email"
              type="email"
              dir="ltr"
              value={addEmailValue}
              onChange={(e) => setAddEmailValue(e.target.value)}
              data-testid="input-comm-add-email"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddEmailOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addEmailValue) || sendMut.isPending}
              onClick={() => doSend(addEmailTemplate, { email: addEmailValue.trim() })}
              data-testid="button-comm-add-email-send"
            >
              {sendMut.isPending && <Loader2 size={14} className="me-1 animate-spin" />}
              {t("orders.comms.saveAndSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-end min-w-0">{children}</span>
    </div>
  );
}

function TimestampRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>{formatDateTime(value)}</span>
    </div>
  );
}

function RowActions({
  c,
  canEdit,
  sending,
  onResend,
  onCopy,
  onAddEmail,
  t,
}: {
  c: OrderCommunication;
  canEdit: boolean;
  sending: boolean;
  onResend: () => void;
  onCopy: () => void;
  onAddEmail: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(e) => e.stopPropagation()}
          data-testid={`button-comm-actions-${c.id}`}
        >
          <MoreHorizontal size={15} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {canEdit && (c.channel === "whatsapp" ? c.recipientPhone : c.recipientEmail) && (
          <DropdownMenuItem disabled={sending} onClick={onResend} data-testid={`menu-resend-${c.id}`}>
            <RefreshCw size={14} className="me-2" />
            {t("orders.comms.resend")}
          </DropdownMenuItem>
        )}
        {(c.channel === "whatsapp" ? c.recipientPhone : c.recipientEmail) && (
          <DropdownMenuItem onClick={onCopy}>
            <Copy size={14} className="me-2" />
            {c.channel === "whatsapp"
              ? t("orders.comms.copyPhone")
              : t("orders.comms.copyEmail")}
          </DropdownMenuItem>
        )}
        {canEdit && c.channel !== "whatsapp" && !c.recipientEmail && (
          <DropdownMenuItem onClick={onAddEmail} data-testid={`menu-add-email-${c.id}`}>
            <Plus size={14} className="me-2" />
            {t("orders.comms.addEmail")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
