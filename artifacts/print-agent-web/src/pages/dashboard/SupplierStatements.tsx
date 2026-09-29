import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { isValidPhoneNumber } from "react-phone-number-input";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CirclePause,
  Clock3,
  FileCheck2,
  FileClock,
  FilePlus2,
  Mail,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneInputField } from "@/components/PhoneInputField";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  getGetSupplierStatementRequestCountsQueryKey,
  getGetSupplierStatementRequestQueryKey,
  getListSupplierStatementContactsQueryKey,
  getListSupplierStatementJourneysQueryKey,
  getListSupplierStatementRequestsQueryKey,
  getListSupplierStatementSchedulesQueryKey,
  useArchiveSupplierStatementContact,
  useCancelSupplierStatementRequest,
  useCreateSupplierStatementContact,
  useCreateSupplierStatementJourney,
  useCreateSupplierStatementRequest,
  useCreateSupplierStatementSchedule,
  useDeleteSupplierStatementRequest,
  useGetSupplierStatementRequest,
  useGetSupplierStatementRequestCounts,
  useLinkSupplierStatementToRequest,
  useListSupplierStatementContacts,
  useListSupplierStatementJourneys,
  useListSupplierStatementRequests,
  useListSupplierStatementSchedules,
  usePauseSupplierStatementRequest,
  usePauseSupplierStatementSchedule,
  useRecordSupplierStatementReceipt,
  useResumeSupplierStatementRequest,
  useResumeSupplierStatementSchedule,
  useUpdateSupplierStatementContact,
  useUpdateSupplierStatementJourney,
  useUpdateSupplierStatementRequest,
  useUpdateSupplierStatementSchedule,
} from "@workspace/api-client-react";
import type {
  SupplierStatementContact,
  SupplierStatementJourney,
  SupplierStatementJourneyStep,
  SupplierStatementRequest,
  SupplierStatementSchedule,
} from "@workspace/api-client-react";

type WorkspaceOption = { id: number; name: string; code?: string };
type WorkspaceRecord = Record<string, unknown>;
type View = "requests" | "schedules" | "contacts";
type RequestStatus = NonNullable<SupplierStatementRequest["status"]>;

const statusConfig: Record<RequestStatus, { label: string; tone: string; icon: typeof Clock3 }> = {
  open: { label: "Open", tone: "bg-slate-100 text-slate-700 border-slate-200", icon: FileClock },
  paused: { label: "Paused", tone: "bg-amber-50 text-amber-700 border-amber-200", icon: CirclePause },
  in_progress: { label: "In progress", tone: "bg-sky-50 text-sky-700 border-sky-200", icon: Send },
  awaiting_reply: { label: "Awaiting reply", tone: "bg-violet-50 text-violet-700 border-violet-200", icon: MessageCircle },
  needs_setup: { label: "Needs setup", tone: "bg-orange-50 text-orange-700 border-orange-200", icon: Settings2 },
  received: { label: "Received", tone: "bg-emerald-50 text-emerald-700 border-emerald-200", icon: CheckCircle2 },
  reconciled: { label: "Reconciled", tone: "bg-teal-50 text-teal-700 border-teal-200", icon: FileCheck2 },
  cancelled: { label: "Cancelled", tone: "bg-slate-100 text-slate-500 border-slate-200", icon: X },
};

function displayName(record: WorkspaceRecord, fallback: string): string {
  return String(record.display_name ?? record.name ?? record.label ?? fallback);
}

function formatDate(value?: string | null, withTime = false): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, withTime
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" });
}

function formatDateInTimezone(value: string | null | undefined, timezone: string, withTime = true): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    const formatted = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      timeZone: timezone,
    }).format(date);
    return withTime ? `${formatted} (${timezone})` : formatted;
  } catch {
    return formatDate(value, withTime);
  }
}

function dateTimeInputInTimezone(value: string | null | undefined, timezone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (name: string) => parts.find((item) => item.type === name)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  } catch {
    return "";
  }
}

function dateTimeInputToIso(value: string, timezone: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let instant = target;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(instant));
      const part = (name: string) => Number(parts.find((item) => item.type === name)?.value ?? 0);
      const observed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
      instant += target - observed;
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(instant)) return null;
  const iso = new Date(instant).toISOString();
  return dateTimeInputInTimezone(iso, timezone) === value ? iso : null;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase() || "?";
}

function extractSnapshotSteps(snapshot: Record<string, unknown> | undefined): SupplierStatementJourneyStep[] {
  const steps = snapshot?.steps;
  return Array.isArray(steps) ? steps as SupplierStatementJourneyStep[] : [];
}

function normalizeRecipientSnapshot(value: unknown): NonNullable<SupplierStatementRequest["recipients_snapshot"]> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (recipient): recipient is NonNullable<SupplierStatementRequest["recipients_snapshot"]>[number] =>
      recipient !== null && typeof recipient === "object" && !Array.isArray(recipient),
  );
}

function StatusBadge({ status }: { status?: SupplierStatementRequest["status"] }) {
  const config = status ? statusConfig[status] : statusConfig.open;
  const Icon = config.icon;
  return (
    <Badge data-testid={`status-request-${status ?? "unknown"}`} variant="outline" className={cn("gap-1.5 rounded-md px-2 py-1 font-medium", config.tone)}>
      <Icon className="size-3.5" />
      {config.label}
    </Badge>
  );
}

function PanelHeader({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{eyebrow}</p>
        <h2 className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-900">{title}</h2>
      </div>
      <Button type="button" data-testid="button-close-panel" variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-slate-900" onClick={onClose}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

function LoadingRows({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-slate-100">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="grid grid-cols-[1.5fr_1fr_1fr_0.8fr] gap-4 px-5 py-4">
          <Skeleton className="h-4 w-40 bg-slate-100" />
          <Skeleton className="h-4 w-24 bg-slate-100" />
          <Skeleton className="h-4 w-28 bg-slate-100" />
          <Skeleton className="h-5 w-20 bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, title, description, action }: { icon: typeof FileClock; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div data-testid="empty-state" className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-[#e8f1ed] text-[#1f6b55]">
        <Icon className="size-5" />
      </div>
      <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm leading-6 text-slate-500">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-testid="error-state" className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-rose-50 text-rose-600"><AlertCircle className="size-5" /></div>
      <p className="mt-3 text-sm font-semibold text-slate-900">Couldn’t load this workspace</p>
      <p className="mt-1 text-sm text-slate-500">Try again, or check your connection before continuing.</p>
      <Button data-testid="button-retry" className="mt-4" variant="outline" size="sm" onClick={onRetry}><RefreshCw className="mr-2 size-3.5" />Retry</Button>
    </div>
  );
}

function RequestDetailPanel({ requestId, onClose, onDeleted, invalidate, previousRequests, contacts }: { requestId: string; onClose: () => void; onDeleted: () => void; invalidate: () => void; previousRequests: SupplierStatementRequest[]; contacts: SupplierStatementContact[] }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const detailQuery = useGetSupplierStatementRequest(requestId, {
    query: { enabled: Boolean(requestId), queryKey: getGetSupplierStatementRequestQueryKey(requestId) },
  });
  const pause = usePauseSupplierStatementRequest();
  const resume = useResumeSupplierStatementRequest();
  const cancel = useCancelSupplierStatementRequest();
  const receipt = useRecordSupplierStatementReceipt();
  const linkStatement = useLinkSupplierStatementToRequest();
  const updateDelivery = useUpdateSupplierStatementRequest();
  const deleteRequest = useDeleteSupplierStatementRequest();
  const [statementId, setStatementId] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [linkId, setLinkId] = useState("");
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<number[]>([]);
  const [emailDueLocal, setEmailDueLocal] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);

  const request = detailQuery.data?.request;
  const steps = detailQuery.data?.steps ?? [];
  const events = detailQuery.data?.events ?? [];
  const auditEvents = detailQuery.data?.audit_events ?? [];
  const inboundMessages = detailQuery.data?.inbound_messages ?? [];
  const snapshot = (request?.journey_snapshot ?? {}) as Record<string, unknown>;
  const recipients = normalizeRecipientSnapshot(request?.recipients_snapshot);
  const requestTimezone = request?.timezone || "UTC";
  const journeySteps = extractSnapshotSteps(snapshot);
  const activeApprovedContacts = contacts.filter((contact) =>
    contact.supplier_id === request?.supplier_id && contact.is_active && contact.is_approved,
  );
  const executionByOrder = new Map(steps.map((step) => [Number((step as WorkspaceRecord).step_order), step as WorkspaceRecord]));
  const firstEmailJourneyStep = journeySteps.find((step) => step.channel === "email");
  const firstEmailExecution = firstEmailJourneyStep
    ? executionByOrder.get(firstEmailJourneyStep.order)
    : undefined;
  const canEditFirstEmail = firstEmailExecution?.status === "pending";
  const requestClosed = ["received", "reconciled", "cancelled"].includes(String(request?.status));
  const stepBeingSent = steps.some((step) => String((step as WorkspaceRecord).status) === "processing");
  const hasPendingDelivery = steps.some((step) => String((step as WorkspaceRecord).status) === "pending");
  const requestHasLinkedStatement = Boolean((request as (SupplierStatementRequest & { statement_id?: string | null }) | undefined)?.statement_id);
  const hasCompletedDeliveryStep = steps.some((step) => !["pending", "cancelled"].includes(String((step as WorkspaceRecord).status)));
  const deleteBlockedReason = !["needs_setup", "cancelled"].includes(String(request?.status))
    ? "Cancel this request before deleting it."
    : requestHasLinkedStatement
      ? "Requests linked to a supplier statement cannot be deleted."
      : stepBeingSent
        ? "A request step is being sent. Try again once sending finishes."
        : hasCompletedDeliveryStep
          ? "Requests with delivery history cannot be deleted."
          : events.length || inboundMessages.length
            ? "Requests with communication history cannot be deleted."
            : null;
  const configuredRecipients = activeApprovedContacts.filter((contact) =>
    recipients.some((recipient) => Number(recipient.id) === contact.id),
  );
  const deliverySetupMessage = journeySteps.length === 0
    ? "No journey is saved on this request. Configure a journey on the supplier schedule before delivery can start."
    : configuredRecipients.length === 0
      ? "No active approved recipient is saved on this request. Configure recipients on the supplier schedule; this request has no pending steps to send."
      : journeySteps.some((step) => step.channel === "email") && !configuredRecipients.some((contact) => Boolean(contact.email))
        ? "The saved recipients do not have an active approved email address for this journey."
        : journeySteps.some((step) => step.channel === "whatsapp") && !configuredRecipients.some((contact) => Boolean(contact.whatsapp_phone || contact.phone))
          ? "The saved recipients do not have an active approved WhatsApp number for this journey."
          : request?.status === "needs_setup"
            ? "Sending is blocked until the missing supplier statement setup is complete."
            : null;
  const editableRequest = !requestClosed && !stepBeingSent && hasPendingDelivery;

  useEffect(() => {
    if (!request) return;
    const ids = normalizeRecipientSnapshot(request.recipients_snapshot)
      .map((contact) => Number(contact.id))
      .filter((id) => activeApprovedContacts.some((contact) => contact.id === id));
    setSelectedRecipientIds(ids);
    setEmailDueLocal(dateTimeInputInTimezone(firstEmailExecution?.scheduled_at as string | undefined, requestTimezone));
  }, [requestId, detailQuery.data, contacts]);

  const runAction = (action: "pause" | "resume" | "cancel") => {
    const mutation = action === "pause" ? pause : action === "resume" ? resume : cancel;
    mutation.mutate({ id: requestId }, {
      onSuccess: () => {
        toast({ title: action === "pause" ? "Request paused" : action === "resume" ? "Request resumed" : "Request cancelled" });
        invalidate();
        void queryClient.invalidateQueries({ queryKey: getGetSupplierStatementRequestQueryKey(requestId) });
      },
      onError: (error) => toast({ title: "Action failed", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }),
    });
  };

  const confirmDelete = () => {
    deleteRequest.mutate({ id: requestId }, {
      onSuccess: () => {
        setDeleteConfirmationOpen(false);
        toast({ title: "Request deleted" });
        onDeleted();
      },
      onError: (error) => toast({
        title: "Could not delete request",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      }),
    });
  };

  const saveDelivery = () => {
    if (selectedRecipientIds.length === 0) {
      toast({ title: "Select at least one approved recipient", variant: "destructive" });
      return;
    }
    const emailDueAt = canEditFirstEmail && emailDueLocal
      ? dateTimeInputToIso(emailDueLocal, requestTimezone)
      : null;
    if (canEditFirstEmail && emailDueLocal && !emailDueAt) {
      toast({ title: "Enter a valid due date and time", description: `The time must be valid in ${requestTimezone}.`, variant: "destructive" });
      return;
    }
    updateDelivery.mutate({
      id: requestId,
      data: {
        recipient_contact_ids: selectedRecipientIds,
        ...(emailDueAt ? { email_due_at: emailDueAt } : {}),
      },
    }, {
      onSuccess: () => {
        toast({ title: "Request delivery updated", description: "Future recurring cycles are unchanged." });
        invalidate();
        void detailQuery.refetch();
      },
      onError: (error) => toast({
        title: "Could not update request delivery",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      }),
    });
  };

  if (detailQuery.isLoading) {
    return <aside data-testid="panel-request-detail" className="w-full shrink-0 border-l border-slate-200 bg-white lg:w-[430px]"><PanelHeader eyebrow="Request detail" title="Loading request" onClose={onClose} /><div className="space-y-4 p-5"><Skeleton className="h-20 w-full bg-slate-100" /><Skeleton className="h-32 w-full bg-slate-100" /><Skeleton className="h-24 w-full bg-slate-100" /></div></aside>;
  }
  if (detailQuery.isError || !request) {
    return <aside data-testid="panel-request-detail" className="w-full shrink-0 border-l border-slate-200 bg-white lg:w-[430px]"><PanelHeader eyebrow="Request detail" title="Unavailable" onClose={onClose} /><ErrorState onRetry={() => void detailQuery.refetch()} /></aside>;
  }

  const supplierName = String((request as SupplierStatementRequest & { supplier_name?: string }).supplier_name ?? `Supplier ${request.supplier_id ?? ""}`);
  const providerConfirmed = events.some((event) => /provider|delivered|confirmed/i.test(String(event.type ?? event.event ?? event.event_type ?? "")));
  const currentStep = steps.find((step) => ["processing", "pending"].includes(String((step as WorkspaceRecord).status ?? "")))
    ?? steps[0];
  const relatedRequests = previousRequests.filter((item) =>
    item.id !== request.id &&
    item.supplier_id === request.supplier_id &&
    item.finance_entity_id === request.finance_entity_id,
  ).slice(0, 4);
  return (
    <aside data-testid="panel-request-detail" className="w-full shrink-0 overflow-y-auto border-l border-slate-200 bg-white lg:w-[430px]">
      <PanelHeader eyebrow={`Request ${request.id?.slice(0, 8) ?? "—"}`} title={supplierName} onClose={onClose} />
      <div className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-sm font-semibold text-slate-900">{request.period_label ?? "Exact period"}</p><p className="mt-1 text-xs text-slate-500">{formatDate(request.period_start)} — {formatDate(request.period_end)}</p></div>
          <StatusBadge status={request.status} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Next action</p><p className="mt-1 text-xs font-medium leading-5 text-slate-700">{request.next_action ?? "No action queued"}</p></div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-400">Due</p><p className="mt-1 text-xs font-medium leading-5 text-slate-700">{formatDateInTimezone(request.next_action_at, requestTimezone)}</p></div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-slate-400">Current step</span><p className="mt-1 font-medium text-slate-700">{String((currentStep as WorkspaceRecord | undefined)?.channel ?? "Not started")}</p></div>
          <div><span className="text-slate-400">Next recurring cycle</span><p className="mt-1 font-medium text-slate-700">{formatDateInTimezone(request.next_recurring_cycle_at, requestTimezone, false)}</p></div>
          <div><span className="text-slate-400">Last contact</span><p className="mt-1 font-medium text-slate-700">{formatDateInTimezone(String(events.at(-1)?.occurred_at ?? events.at(-1)?.created_at ?? ""), requestTimezone)}</p></div>
          <div><span className="text-slate-400">Provider delivery</span><p className="mt-1 font-medium text-slate-700">{providerConfirmed ? "Confirmed by provider" : "Not confirmed"}</p></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {request.status === "paused" ? <Button data-testid="button-resume-request" size="sm" variant="outline" disabled={resume.isPending} onClick={() => runAction("resume")}><Play className="mr-1.5 size-3.5" />Resume</Button> : request.status !== "cancelled" && request.status !== "reconciled" ? <Button data-testid="button-pause-request" size="sm" variant="outline" disabled={pause.isPending} onClick={() => runAction("pause")}><CirclePause className="mr-1.5 size-3.5" />Pause</Button> : null}
          {request.status !== "cancelled" && request.status !== "reconciled" ? <Button data-testid="button-cancel-request" size="sm" variant="ghost" className="text-rose-600 hover:text-rose-700" disabled={cancel.isPending} onClick={() => runAction("cancel")}><X className="mr-1.5 size-3.5" />Cancel</Button> : null}
          {request.status === "received" ? <Button data-testid="button-open-reconciliation" size="sm" onClick={() => setLocation(`/supplier-reconciliation?request_id=${encodeURIComponent(request.id ?? "")}`)}>Reconcile <ArrowRight className="ml-1.5 size-3.5" /></Button> : null}
        </div>
        <div className="space-y-1 border-t border-slate-100 pt-4">
          <Button data-testid="button-delete-request" size="sm" variant="outline" className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800" disabled={Boolean(deleteBlockedReason) || deleteRequest.isPending} onClick={() => setDeleteConfirmationOpen(true)}><Trash2 className="mr-1.5 size-3.5" />{deleteRequest.isPending ? "Deleting…" : "Delete request"}</Button>
          {deleteBlockedReason ? <p data-testid="text-delete-request-blocked" className="text-xs leading-5 text-slate-500">{deleteBlockedReason}</p> : <p className="text-xs leading-5 text-slate-500">Only the request and its unsent steps will be removed. The deletion audit record is retained.</p>}
        </div>
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Request journey</h3><Badge variant="outline" className="font-mono text-[10px]">v{String(snapshot.version ?? request.journey_version_id ?? "—")}</Badge></div>
          {journeySteps.length ? <div className="space-y-2">{journeySteps.map((journeyStep, index) => {
            const execution = executionByOrder.get(journeyStep.order);
            const stepStatus = String(execution?.status ?? "not scheduled");
            return <div key={`${journeyStep.order}`} data-testid={`journey-step-${index}`} className="flex gap-3 rounded-lg border border-slate-200 p-3"><div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#e8f1ed] text-[11px] font-semibold text-[#1f6b55]">{index + 1}</div><div className="min-w-0"><div className="flex items-center gap-2 text-xs font-semibold text-slate-800">{journeyStep.channel === "whatsapp" ? <MessageCircle className="size-3.5 text-[#1f6b55]" /> : <Mail className="size-3.5 text-[#1f6b55]" />}{String(journeyStep.subject ?? journeyStep.message ?? "Statement request")}<span className="font-normal text-slate-400">· +{String(journeyStep.delay_minutes ?? 0)}m</span></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{String(journeyStep.message ?? "Message content is not available.")}</p><p className="mt-1 text-[11px] font-medium text-slate-600">{stepStatus === "pending" ? `Scheduled: ${formatDateInTimezone(String(execution?.scheduled_at ?? ""), requestTimezone)}` : `Status: ${stepStatus.replaceAll("_", " ")}`}</p></div></div>;
          })}</div> : <p className="text-sm text-slate-500">No journey steps were captured. Add a journey to the schedule configuration before delivery can start.</p>}
          <div className="flex flex-wrap gap-1.5">{recipients.length ? recipients.map((contact) => <Badge key={contact.id} variant="secondary" className="gap-1.5 font-normal"><span className="flex size-4 items-center justify-center rounded-full bg-slate-300 text-[8px] font-semibold text-slate-700">{initials(contact.name)}</span>{contact.name}</Badge>) : <span className="text-xs text-slate-500">No approved recipients on this snapshot. Sending is blocked until setup is complete.</span>}</div>
        </section>
        <section data-testid="request-delivery-controls" className="space-y-3 border-t border-slate-100 pt-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Request delivery settings</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">Edits apply only to this request. Future recurring cycles continue to use the schedule settings.</p>
          </div>
          <div className="max-h-32 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">
            {activeApprovedContacts.length ? activeApprovedContacts.map((contact) => <label key={contact.id} className="flex items-center gap-2 text-xs">
              <Checkbox
                data-testid={`checkbox-request-delivery-contact-${contact.id}`}
                checked={selectedRecipientIds.includes(contact.id)}
                disabled={!editableRequest || updateDelivery.isPending}
                onCheckedChange={(checked) => setSelectedRecipientIds((current) => checked === true
                  ? [...new Set([...current, contact.id])]
                  : current.filter((id) => id !== contact.id))}
              />
              <span className="min-w-0 flex-1 truncate">{contact.name}</span>
              <span className="text-slate-400">{contact.email ?? contact.whatsapp_phone ?? contact.phone ?? "No channel"}</span>
            </label>) : <p className="text-xs text-amber-700">No active approved contacts for this supplier. Approve a contact before editing recipients.</p>}
          </div>
          {canEditFirstEmail ? <div className="space-y-1.5">
            <Label htmlFor="input-request-email-due" className="text-xs">First email due time ({requestTimezone})</Label>
            <Input id="input-request-email-due" data-testid="input-request-email-due" type="datetime-local" value={emailDueLocal} disabled={!editableRequest || updateDelivery.isPending} onChange={(event) => setEmailDueLocal(event.target.value)} />
            <p className="text-[11px] leading-4 text-slate-500">Follow-up steps keep their configured delays relative to the rescheduled email.</p>
          </div> : <p className="rounded-md bg-slate-50 p-2 text-xs leading-5 text-slate-500">{firstEmailExecution && ["sent", "processing"].includes(String(firstEmailExecution.status)) ? "The first email is already sent or being sent and cannot be rescheduled." : "No pending first email is available to reschedule."}</p>}
          {deliverySetupMessage ? <p className="rounded-md bg-amber-50 p-2 text-xs leading-5 text-amber-800">{deliverySetupMessage}</p> : null}
          {!hasPendingDelivery && !requestClosed ? <p className="rounded-md bg-slate-50 p-2 text-xs leading-5 text-slate-500">This request has no pending delivery steps. Past messages cannot be changed.</p> : null}
          <Button data-testid="button-save-request-delivery" size="sm" className="w-full bg-[#1f6b55] hover:bg-[#185343]" disabled={!editableRequest || updateDelivery.isPending || selectedRecipientIds.length === 0} onClick={saveDelivery}>{updateDelivery.isPending ? "Saving…" : "Save request delivery"}</Button>
        </section>
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Record receipt</h3>
          <div className="grid grid-cols-2 gap-2"><Input data-testid="input-receipt-statement-id" value={statementId} onChange={(event) => setStatementId(event.target.value)} placeholder="Statement ID" /><Input data-testid="input-receipt-date" type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} /></div>
          <Button data-testid="button-record-receipt" size="sm" variant="outline" className="w-full" disabled={!statementId.trim() || receipt.isPending} onClick={() => receipt.mutate({ id: requestId, data: { statement_id: statementId.trim(), received_at: receiptDate || null } }, { onSuccess: () => { toast({ title: "Receipt recorded" }); setStatementId(""); invalidate(); void detailQuery.refetch(); }, onError: (error) => toast({ title: "Could not record receipt", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) })}><CheckCircle2 className="mr-1.5 size-3.5" />{receipt.isPending ? "Recording…" : "Record received statement"}</Button>
        </section>
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Link an exact-period statement</h3>
          <div className="flex gap-2"><Input data-testid="input-link-statement-id" value={linkId} onChange={(event) => setLinkId(event.target.value)} placeholder="Statement ID" /><Button data-testid="button-link-statement" variant="outline" disabled={!linkId.trim() || linkStatement.isPending} onClick={() => linkStatement.mutate({ id: requestId, data: { statement_id: linkId.trim() } }, { onSuccess: () => { toast({ title: "Statement linked" }); setLinkId(""); invalidate(); void detailQuery.refetch(); }, onError: (error) => toast({ title: "Could not link statement", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) })}>Link</Button></div>
        </section>
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Journey events</h3><span className="text-xs text-slate-400">{events.length} events</span></div>
          {events.length ? <div className="space-y-2">{events.slice(0, 6).map((event, index) => <div key={index} data-testid={`event-request-${index}`} className="flex gap-2.5 text-xs"><div className="mt-1 size-1.5 shrink-0 rounded-full bg-[#1f6b55]" /><div><p className="font-medium text-slate-700">{String(event.type ?? event.event ?? "Activity")}</p><p className="mt-0.5 text-slate-400">{formatDateInTimezone(String(event.created_at ?? event.at ?? ""), requestTimezone)}</p></div></div>)}</div> : <p className="text-sm text-slate-500">No events recorded yet.</p>}
        </section>
        {auditEvents.length ? <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Request audit history</h3>
          <div className="space-y-2">{auditEvents.slice(-5).reverse().map((entry, index) => <div key={String(entry.id ?? index)} className="rounded-md bg-slate-50 p-2 text-xs"><p className="font-medium text-slate-700">{String(entry.action ?? "Request updated").replaceAll("_", " ")}</p><p className="mt-1 text-slate-400">{formatDateInTimezone(String(entry.created_at ?? ""), requestTimezone)}</p></div>)}</div>
        </section> : null}
        <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Replies and documents</h3>
          {inboundMessages.length ? inboundMessages.map((message, index) => {
            const item = message as WorkspaceRecord;
            const hasAttachment = Boolean(item.attachment_url) || (Array.isArray(item.attachments) && item.attachments.length > 0);
            const classification = String(item.classification ?? "").toLowerCase();
            const isStatement = classification.includes("statement");
            return <div key={index} data-testid={`inbound-message-${index}`} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium text-slate-700">{String(item.sender ?? item.channel ?? "Supplier reply")}</span><span className="text-slate-400">{formatDate(String(item.received_at ?? ""), true)}</span></div>
              <p className="mt-1 text-xs leading-5 text-slate-500">{String(item.body ?? "Attachment received without a message.")}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">{hasAttachment ? <Badge variant="outline" className="gap-1 text-[10px]"><FileCheck2 className="size-3" />Attachment</Badge> : null}<Badge variant="outline" className={cn("text-[10px]", isStatement ? "border-emerald-200 text-emerald-700" : "border-slate-200 text-slate-500")}>{isStatement ? "Statement document" : "Reply — not classified as statement"}</Badge></div>
            </div>;
          }) : <p className="text-sm text-slate-500">No replies or attachments recorded yet.</p>}
        </section>
        {relatedRequests.length ? <section className="space-y-3 border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Prior periods</h3>
          <div className="space-y-2">{relatedRequests.map((item) => <button type="button" key={item.id} data-testid={`prior-request-${item.id}`} className="flex w-full items-center justify-between rounded-lg border border-slate-200 p-3 text-left hover:bg-slate-50"><span className="text-xs font-medium text-slate-700">{item.period_label ?? `${formatDate(item.period_start)} — ${formatDate(item.period_end)}`}</span><StatusBadge status={item.status} /></button>)}</div>
        </section> : null}
      </div>
      <Dialog open={deleteConfirmationOpen} onOpenChange={setDeleteConfirmationOpen}>
        <DialogContent data-testid="dialog-delete-request" className="max-w-md">
          <DialogHeader><DialogTitle>Delete this request permanently?</DialogTitle></DialogHeader>
          <p className="text-sm leading-6 text-slate-600">The request and its unsent steps will be removed. A deletion audit record will remain. This cannot be undone.</p>
          <DialogFooter>
            <Button data-testid="button-cancel-delete-request" variant="outline" onClick={() => setDeleteConfirmationOpen(false)}>Keep request</Button>
            <Button data-testid="button-confirm-delete-request" className="bg-rose-700 hover:bg-rose-800" disabled={deleteRequest.isPending} onClick={confirmDelete}>{deleteRequest.isPending ? "Deleting…" : "Delete permanently"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

type ScheduleForm = { supplierId: string; entityId: string; cadence: "monthly" | "quarterly"; localDay: string; localTime: string; timezone: string; firstRunDate: string; journeyId: string; active: boolean };
const blankSchedule: ScheduleForm = { supplierId: "", entityId: "", cadence: "monthly", localDay: "1", localTime: "09:00", timezone: "Asia/Beirut", firstRunDate: new Date().toISOString().slice(0, 10), journeyId: "", active: true };

function ScheduleEditor({
  schedule,
  suppliers,
  entities,
  journeys,
  journeysLoading,
  journeysError,
  onRetryJourneys,
  contacts,
  onClose,
  onSaved,
}: {
  schedule?: SupplierStatementSchedule;
  suppliers: WorkspaceOption[];
  entities: WorkspaceOption[];
  journeys: SupplierStatementJourney[];
  journeysLoading: boolean;
  journeysError: boolean;
  onRetryJourneys: () => void;
  contacts: SupplierStatementContact[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const createSchedule = useCreateSupplierStatementSchedule();
  const updateSchedule = useUpdateSupplierStatementSchedule();
  const [form, setForm] = useState<ScheduleForm>(() => schedule ? { supplierId: String(schedule.supplier_id ?? ""), entityId: String(schedule.finance_entity_id ?? ""), cadence: schedule.cadence ?? "monthly", localDay: String(schedule.local_day ?? 1), localTime: schedule.local_time ?? "09:00", timezone: schedule.timezone ?? "Asia/Beirut", firstRunDate: schedule.first_run_date ?? blankSchedule.firstRunDate, journeyId: String(schedule.journey_id ?? ""), active: schedule.is_active !== false } : blankSchedule);
  const [recipientIds, setRecipientIds] = useState<number[]>([]);
  const [escalationOwner, setEscalationOwner] = useState("");
  const [escalationDelay, setEscalationDelay] = useState("60");
  const scheduleContacts = contacts.filter((contact) => contact.supplier_id === Number(form.supplierId) && contact.is_active);
  const matchingJourneys = journeys.filter((journey) =>
    journey.supplier_id == null ||
    (Boolean(form.supplierId) && Number(journey.supplier_id) === Number(form.supplierId)),
  );
  const selectedSupplierName = suppliers.find((supplier) => supplier.id === Number(form.supplierId))?.name;
  const changeSupplier = (supplierId: string) => {
    setForm((current) => {
      const selectedJourney = journeys.find((journey) => String(journey.id) === current.journeyId);
      const journeyStillMatches = !selectedJourney?.supplier_id ||
        Number(selectedJourney.supplier_id) === Number(supplierId);
      return {
        ...current,
        supplierId,
        journeyId: selectedJourney && !journeyStillMatches ? "" : current.journeyId,
      };
    });
    setRecipientIds([]);
  };
  const nextSendPreview = form.firstRunDate
    ? `${form.firstRunDate} at ${form.localTime} (${form.timezone})`
    : "Choose a first run date";
  const periodPreview = form.cadence === "quarterly"
    ? "The request will cover the preceding calendar quarter."
    : "The request will cover the preceding calendar month.";
  const setField = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!form.supplierId || !form.entityId || !form.firstRunDate) {
      toast({ title: "Complete the required fields", description: "Choose a supplier, finance entity, and first run date.", variant: "destructive" });
      return;
    }
    const data = { supplier_id: Number(form.supplierId), finance_entity_id: Number(form.entityId), cadence: form.cadence, local_day: Number(form.localDay), local_time: form.localTime, timezone: form.timezone, first_run_date: form.firstRunDate, journey_id: form.journeyId ? Number(form.journeyId) : null, recipient_contact_ids: recipientIds, is_active: form.active, escalation_settings: { owner: escalationOwner || null, delay_minutes: Number(escalationDelay) || 0 } };
    const onSuccess = () => { toast({ title: schedule ? "Schedule updated" : "Schedule created" }); onSaved(); };
    const onError = (error: Error) => toast({ title: "Could not save schedule", description: error.message, variant: "destructive" });
    if (schedule?.id) updateSchedule.mutate({ id: schedule.id, data }, { onSuccess, onError }); else createSchedule.mutate({ data }, { onSuccess, onError });
  };
  return (
    <aside data-testid="panel-schedule-editor" className="w-full shrink-0 overflow-y-auto border-l border-slate-200 bg-white lg:w-[430px]">
      <PanelHeader eyebrow={schedule ? "Edit schedule" : "New schedule"} title="Supplier schedule" onClose={onClose} />
      <div className="space-y-5 p-5">
        <div className="rounded-xl border border-[#cfe2d9] bg-[#f1f7f4] p-3 text-xs leading-5 text-[#1f6b55]"><ShieldCheck className="mb-1 size-4" /><span>Schedules create a new exact-period request each cycle. The run date and time use the schedule timezone. Follow-up steps run after their configured journey delays. Only approved, selected contacts can be used by the journey.</span></div>
        <div className="space-y-2"><Label htmlFor="schedule-supplier">Supplier <span className="text-rose-500">*</span></Label><select id="schedule-supplier" data-testid="select-schedule-supplier" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={form.supplierId} onChange={(event) => changeSupplier(event.target.value)}><option value="">Choose supplier</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="schedule-entity">Finance entity <span className="text-rose-500">*</span></Label><select id="schedule-entity" data-testid="select-schedule-entity" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={form.entityId} onChange={(event) => setField("entityId", event.target.value)}><option value="">Choose entity</option>{entities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="schedule-cadence">Cadence</Label><select id="schedule-cadence" data-testid="select-schedule-cadence" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={form.cadence} onChange={(event) => setField("cadence", event.target.value as ScheduleForm["cadence"])}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></div><div className="space-y-2"><Label htmlFor="schedule-day">Day of month</Label><Input id="schedule-day" data-testid="input-schedule-day" type="number" min="1" max="31" value={form.localDay} onChange={(event) => setField("localDay", event.target.value)} /></div></div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="schedule-time">Local time</Label><Input id="schedule-time" data-testid="input-schedule-time" type="time" value={form.localTime} onChange={(event) => setField("localTime", event.target.value)} /></div><div className="space-y-2"><Label htmlFor="schedule-timezone">Timezone</Label><Input id="schedule-timezone" data-testid="input-schedule-timezone" value={form.timezone} onChange={(event) => setField("timezone", event.target.value)} /></div></div>
        <div className="space-y-2"><Label htmlFor="schedule-first-run">First run date <span className="text-rose-500">*</span></Label><Input id="schedule-first-run" data-testid="input-schedule-first-run" type="date" value={form.firstRunDate} onChange={(event) => setField("firstRunDate", event.target.value)} /></div>
        <div data-testid="schedule-preview" className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"><div><p className="text-slate-400">Next local run</p><p className="mt-1 font-medium text-slate-700">{nextSendPreview}</p><p className="mt-1 text-[11px] leading-4 text-slate-500">Follow-ups run after each journey step’s relative delay.</p></div><div><p className="text-slate-400">Requested period</p><p className="mt-1 font-medium leading-5 text-slate-700">{periodPreview}</p></div></div>
        <div className="space-y-2">
          <Label htmlFor="schedule-journey">Collection journey</Label>
          <select id="schedule-journey" data-testid="select-schedule-journey" aria-describedby="schedule-journey-guidance" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={form.journeyId} onChange={(event) => setField("journeyId", event.target.value)}>
            <option value="">No journey selected</option>
            {journeys.map((journey) => {
              const isShared = journey.supplier_id == null;
              const isAvailable = isShared || (
                Boolean(form.supplierId) &&
                Number(journey.supplier_id) === Number(form.supplierId)
              );
              const journeySupplierName = suppliers.find((supplier) => supplier.id === Number(journey.supplier_id))?.name
                ?? `Supplier ${journey.supplier_id}`;
              return (
                <option key={journey.id} value={journey.id} disabled={!isAvailable}>
                  {journey.name ?? "Untitled journey"}{!isAvailable && !isShared ? ` — for ${journeySupplierName}` : ""}
                </option>
              );
            })}
          </select>
          <div id="schedule-journey-guidance" data-testid="schedule-journey-guidance" aria-live="polite" className="text-[11px] leading-4 text-slate-500">
            {journeysError
              ? "Could not load saved journeys. Reload the journey list and try again."
              : journeysLoading
                ? "Loading saved journeys…"
                : journeys.length === 0
                  ? "No saved journeys were found. Create one, then reload the journey list."
                  : !form.supplierId && journeys.some((journey) => journey.supplier_id != null)
                    ? "Choose a supplier first. Supplier-specific journeys are shown disabled until their supplier is selected."
                    : form.supplierId && matchingJourneys.length === 0
                      ? `No journey is configured for ${selectedSupplierName ?? "this supplier"}. Other journeys are shown disabled; choose their supplier or change the journey’s Supplier context.`
                      : "Choose a shared journey or one configured for this supplier."}
          </div>
          {journeysError || (!journeysLoading && journeys.length === 0) ? (
            <Button type="button" data-testid="button-retry-journeys" size="sm" variant="outline" onClick={onRetryJourneys}>
              Reload journeys
            </Button>
          ) : null}
        </div>
        <div className="space-y-2"><Label>Approved recipients</Label><div data-testid="schedule-recipient-list" className="max-h-28 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">{scheduleContacts.length ? scheduleContacts.map((contact) => <label key={contact.id} className="flex items-center gap-2 text-xs"><Checkbox data-testid={`checkbox-schedule-contact-${contact.id}`} checked={recipientIds.includes(contact.id)} disabled={!contact.is_approved} onCheckedChange={(checked) => setRecipientIds((current) => checked === true ? [...current, contact.id] : current.filter((id) => id !== contact.id))} /><span className="min-w-0 flex-1 truncate">{contact.name}</span><span className="text-slate-400">{contact.email ?? contact.whatsapp_phone ?? "No channel"}</span></label>) : <p className="text-xs text-amber-700">No active supplier contacts. Add and approve a contact before activating this schedule.</p>}</div></div>
        <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="schedule-escalation-owner">Escalation owner</Label><Input id="schedule-escalation-owner" data-testid="input-schedule-escalation-owner" value={escalationOwner} onChange={(event) => setEscalationOwner(event.target.value)} placeholder="Name or team" /></div><div className="space-y-2"><Label htmlFor="schedule-escalation-delay">Escalate after (minutes)</Label><Input id="schedule-escalation-delay" data-testid="input-schedule-escalation-delay" type="number" min="0" value={escalationDelay} onChange={(event) => setEscalationDelay(event.target.value)} /></div></div>
        {schedule ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">Future edits apply to future cycles only. They do not silently rewrite the journey or recipients captured on active request snapshots.</div> : null}
        <label className="flex items-center gap-2 text-sm text-slate-700"><Checkbox data-testid="checkbox-schedule-active" checked={form.active} onCheckedChange={(checked) => setField("active", checked === true)} />Keep schedule active</label>
        <div className="flex gap-2 border-t border-slate-100 pt-4"><Button type="button" data-testid="button-save-schedule" className="flex-1 bg-[#1f6b55] hover:bg-[#185343]" disabled={createSchedule.isPending || updateSchedule.isPending} onClick={save}>{createSchedule.isPending || updateSchedule.isPending ? "Saving…" : schedule ? "Save changes" : "Create schedule"}</Button><Button type="button" data-testid="button-cancel-schedule" variant="outline" onClick={onClose}>Cancel</Button></div>
      </div>
    </aside>
  );
}

type ContactForm = { supplierId: string; name: string; role: string; department: string; email: string; phone: string; whatsappPhone: string; approved: boolean; selected: boolean };
const blankContact: ContactForm = { supplierId: "", name: "", role: "", department: "", email: "", phone: "", whatsappPhone: "", approved: false, selected: false };

function phoneIsValidOrUnchanged(value: string, original?: string | null): boolean {
  if (!value.trim() || (original && value === original && !isValidPhoneNumber(value))) return true;
  return isValidPhoneNumber(value);
}

function ContactDialog({ open, onOpenChange, suppliers, contact, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; suppliers: WorkspaceOption[]; contact?: SupplierStatementContact; onSaved: () => void }) {
  const { toast } = useToast();
  const create = useCreateSupplierStatementContact();
  const update = useUpdateSupplierStatementContact();
  const [form, setForm] = useState<ContactForm>(blankContact);
  useEffect(() => {
    if (!open) return;
    setForm(contact ? {
      supplierId: String(contact.supplier_id),
      name: contact.name,
      role: contact.role ?? "",
      department: contact.department ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      whatsappPhone: contact.whatsapp_phone ?? "",
      approved: contact.is_approved,
      selected: contact.is_selected,
    } : { ...blankContact });
  }, [open, contact]);
  const setField = <K extends keyof ContactForm>(key: K, value: ContactForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!form.supplierId || !form.name.trim()) { toast({ title: "Name and supplier are required", variant: "destructive" }); return; }
    if (!phoneIsValidOrUnchanged(form.phone, contact?.phone) || !phoneIsValidOrUnchanged(form.whatsappPhone, contact?.whatsapp_phone)) {
      toast({ title: "Enter valid international phone numbers", description: "Choose a country code for each phone number.", variant: "destructive" });
      return;
    }
    if (!form.email.trim() && !form.phone.trim() && !form.whatsappPhone.trim()) {
      toast({ title: "Add an email or phone number", description: "A supplier contact needs at least one way to reach them.", variant: "destructive" });
      return;
    }
    const onSuccess = () => { toast({ title: contact ? "Contact updated" : "Contact added" }); onSaved(); onOpenChange(false); };
    const onError = (error: Error) => toast({ title: "Could not save contact", description: error.message, variant: "destructive" });
    if (contact) update.mutate({ id: contact.id, data: { name: form.name.trim(), role: form.role || null, department: form.department || null, email: form.email || null, phone: form.phone || null, whatsapp_phone: form.whatsappPhone || null, is_approved: form.approved, is_selected: form.selected } }, { onSuccess, onError });
    else create.mutate({ data: { supplier_id: Number(form.supplierId), name: form.name.trim(), role: form.role || null, department: form.department || null, email: form.email || null, phone: form.phone || null, whatsapp_phone: form.whatsappPhone || null, is_approved: form.approved, is_selected: form.selected } }, { onSuccess, onError });
  };
  const phoneFieldValue = (value: string) => value.startsWith("+") ? value : undefined;
  const showLegacyPhoneHint = (value: string, original?: string | null) =>
    Boolean(value && original && value === original && !isValidPhoneNumber(value));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-contact" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit approved contact" : "Add supplier contact"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="contact-supplier">Supplier</Label>
            <select id="contact-supplier" data-testid="select-contact-supplier" disabled={Boolean(contact)} className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={form.supplierId} onChange={(event) => setField("supplierId", event.target.value)}>
              <option value="">Choose supplier</option>
              {suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label htmlFor="contact-name">Name</Label><Input id="contact-name" data-testid="input-contact-name" value={form.name} onChange={(event) => setField("name", event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="contact-role">Role</Label><Input id="contact-role" data-testid="input-contact-role" value={form.role} onChange={(event) => setField("role", event.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2"><Label htmlFor="contact-department">Department</Label><Input id="contact-department" data-testid="input-contact-department" value={form.department} onChange={(event) => setField("department", event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="contact-email">Email</Label><Input id="contact-email" data-testid="input-contact-email" type="email" value={form.email} onChange={(event) => setField("email", event.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="contact-phone">Phone</Label>
              <PhoneInputField
                id="contact-phone"
                data-testid="input-contact-phone"
                international
                countryCallingCodeEditable={false}
                defaultCountry="LB"
                value={phoneFieldValue(form.phone)}
                onChange={(value) => setField("phone", value ?? "")}
              />
              {showLegacyPhoneHint(form.phone, contact?.phone) && <p className="text-xs text-amber-700">Saved number needs a country code to be used for WhatsApp.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact-whatsapp">WhatsApp phone</Label>
              <PhoneInputField
                id="contact-whatsapp"
                data-testid="input-contact-whatsapp"
                international
                countryCallingCodeEditable={false}
                defaultCountry="LB"
                value={phoneFieldValue(form.whatsappPhone)}
                onChange={(value) => setField("whatsappPhone", value ?? "")}
              />
              {showLegacyPhoneHint(form.whatsappPhone, contact?.whatsapp_phone) && <p className="text-xs text-amber-700">Saved number needs a country code to be used for WhatsApp.</p>}
              <p className="text-xs text-slate-500">Respond.io uses this number; if blank, it uses Phone.</p>
            </div>
          </div>
          <p className="-mt-2 text-xs text-slate-500">Select the country for each number; values are saved in international format.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox data-testid="checkbox-contact-approved" checked={form.approved} onCheckedChange={(checked) => setField("approved", checked === true)} />
              <span><span className="font-medium">Approved</span><span className="mt-0.5 block text-xs text-slate-500">Vetted and required before messages can be sent.</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox data-testid="checkbox-contact-selected" checked={form.selected} onCheckedChange={(checked) => setField("selected", checked === true)} />
              <span><span className="font-medium">Use in journeys</span><span className="mt-0.5 block text-xs text-slate-500">Include in scheduled supplier statement journeys.</span></span>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button data-testid="button-cancel-contact" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid="button-save-contact" className="bg-[#1f6b55] hover:bg-[#185343]" disabled={create.isPending || update.isPending} onClick={save}>{create.isPending || update.isPending ? "Saving…" : "Save contact"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestCreateDialog({ open, onOpenChange, suppliers, entities, journeys, contacts, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; suppliers: WorkspaceOption[]; entities: WorkspaceOption[]; journeys: SupplierStatementJourney[]; contacts: SupplierStatementContact[]; onSaved: (result?: { request: SupplierStatementRequest; reused?: boolean }) => void }) {
  const { toast } = useToast();
  const create = useCreateSupplierStatementRequest();
  const [supplierId, setSupplierId] = useState("");
  const [entityId, setEntityId] = useState("");
  const [journeyId, setJourneyId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [cadence, setCadence] = useState<"monthly" | "quarterly">("monthly");
  const [selectedContacts, setSelectedContacts] = useState<number[]>([]);
  const eligibleContacts = contacts.filter((contact) => !supplierId || contact.supplier_id === Number(supplierId));
  const save = () => {
    if (!supplierId || !entityId || !periodStart || !periodEnd) { toast({ title: "Complete the request period", description: "Choose a supplier, finance entity, and exact start and end dates.", variant: "destructive" }); return; }
    create.mutate({ data: { supplier_id: Number(supplierId), finance_entity_id: Number(entityId), period_start: periodStart, period_end: periodEnd, period_label: `${formatDate(periodStart)} – ${formatDate(periodEnd)}`, cadence, journey_id: journeyId ? Number(journeyId) : null, recipient_contact_ids: selectedContacts, source: "manual", idempotency_key: `manual-${Date.now()}` } }, { onSuccess: (result) => { if (!result) { toast({ title: "Request submitted", description: "Refreshing the request list." }); onSaved(); onOpenChange(false); return; } const reused = result.reused === true; toast({ title: reused ? "An open request already exists for this period" : "Statement request created", description: reused ? "Opened the existing request instead of creating a duplicate." : undefined }); onSaved(result); onOpenChange(false); }, onError: (error) => toast({ title: "Could not create request", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) });
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-testid="dialog-create-request" className="max-w-xl"><DialogHeader><DialogTitle>Collect a supplier statement</DialogTitle></DialogHeader><div className="grid gap-4 py-2"><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="request-supplier">Supplier</Label><select id="request-supplier" data-testid="select-request-supplier" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setSelectedContacts([]); }}><option value="">Choose supplier</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="space-y-2"><Label htmlFor="request-entity">Finance entity</Label><select id="request-entity" data-testid="select-request-entity" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={entityId} onChange={(event) => setEntityId(event.target.value)}><option value="">Choose entity</option>{entities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="request-start">Period starts</Label><Input id="request-start" data-testid="input-request-period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="request-end">Period ends</Label><Input id="request-end" data-testid="input-request-period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></div></div><div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="request-cadence">Cadence</Label><select id="request-cadence" data-testid="select-request-cadence" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={cadence} onChange={(event) => setCadence(event.target.value as "monthly" | "quarterly")}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></div><div className="space-y-2"><Label htmlFor="request-journey">Journey</Label><select id="request-journey" data-testid="select-request-journey" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={journeyId} onChange={(event) => setJourneyId(event.target.value)}><option value="">No journey</option>{journeys.map((journey) => <option key={journey.id} value={journey.id}>{journey.name}</option>)}</select></div></div><div className="space-y-2"><Label>Approved recipients</Label><div className="max-h-32 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">{eligibleContacts.length ? eligibleContacts.map((contact) => <label key={contact.id} className="flex items-center gap-2 text-sm"><Checkbox data-testid={`checkbox-request-contact-${contact.id}`} checked={selectedContacts.includes(contact.id)} disabled={!contact.is_approved || !contact.is_active} onCheckedChange={(checked) => setSelectedContacts((current) => checked === true ? [...current, contact.id] : current.filter((id) => id !== contact.id))} /><span className={cn("flex-1", (!contact.is_approved || !contact.is_active) && "text-slate-400")}>{contact.name}</span><span className="text-xs text-slate-400">{contact.email ?? contact.whatsapp_phone ?? "No channel"}</span></label>) : <p className="text-xs text-slate-500">Select a supplier to see approved contacts.</p>}</div></div></div><DialogFooter><Button data-testid="button-cancel-request" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button data-testid="button-submit-request" className="bg-[#1f6b55] hover:bg-[#185343]" disabled={create.isPending} onClick={save}>{create.isPending ? "Creating…" : "Create request"}</Button></DialogFooter></DialogContent></Dialog>;
}

type EditableJourneyStep = {
  order: number;
  channel: "email" | "whatsapp";
  delay_minutes: number;
  subject: string | null;
  message: string;
};

function JourneyDialog({ open, onOpenChange, journey, suppliers, contacts, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; journey?: SupplierStatementJourney; suppliers: WorkspaceOption[]; contacts: SupplierStatementContact[]; onSaved: () => void }) {
  const { toast } = useToast();
  const create = useCreateSupplierStatementJourney();
  const update = useUpdateSupplierStatementJourney();
  const [name, setName] = useState(journey?.name ?? "");
  const [description, setDescription] = useState(journey?.description ?? "");
  const [supplierId, setSupplierId] = useState(String(journey?.supplier_id ?? ""));
  const [recipientIds, setRecipientIds] = useState<number[]>([]);
  const [steps, setSteps] = useState<EditableJourneyStep[]>([{
    order: 1,
    channel: "email",
    delay_minutes: 0,
    subject: "Supplier statement request",
    message: "Please send the supplier statement for the requested period.",
  }]);
  const [escalationOwner, setEscalationOwner] = useState("");
  const [escalationDelay, setEscalationDelay] = useState("60");
  const eligibleContacts = contacts.filter((contact) => contact.is_active && contact.supplier_id === Number(supplierId));
  const updateStep = (index: number, patch: Partial<EditableJourneyStep>) => setSteps((current) => current.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step));
  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    setSteps((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((step, stepIndex) => ({ ...step, order: stepIndex + 1 }));
    });
  };
  const save = () => {
    if (!name.trim() || steps.length === 0) { toast({ title: "Journey name and one step are required", variant: "destructive" }); return; }
    const onSuccess = () => { toast({ title: journey ? "Journey updated" : "Journey created" }); onSaved(); onOpenChange(false); };
    const onError = (error: Error) => toast({ title: "Could not save journey", description: error.message, variant: "destructive" });
    const payloadSteps: SupplierStatementJourneyStep[] = steps.map((step, index) => ({ ...step, order: index + 1 }));
    const escalation_settings = { owner: escalationOwner || null, delay_minutes: Number(escalationDelay) || 0 };
    if (journey?.id) update.mutate({ id: journey.id, data: { name: name.trim(), description: description || null, steps: payloadSteps, recipient_contact_ids: recipientIds, escalation_settings } }, { onSuccess, onError });
    else create.mutate({ data: { supplier_id: supplierId ? Number(supplierId) : null, name: name.trim(), description: description || null, steps: payloadSteps, recipient_contact_ids: recipientIds, escalation_settings } }, { onSuccess, onError });
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-testid="dialog-journey" className="max-w-2xl"><DialogHeader><DialogTitle>{journey ? "Edit journey" : "New collection journey"}</DialogTitle></DialogHeader><div className="max-h-[70vh] space-y-4 overflow-y-auto py-2">
    <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="journey-name">Journey name</Label><Input id="journey-name" data-testid="input-journey-name" value={name} onChange={(event) => setName(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="journey-supplier">Supplier context</Label><select id="journey-supplier" data-testid="select-journey-supplier" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm" value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setRecipientIds([]); }}><option value="">Shared journey</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div>
    <div className="space-y-2"><Label htmlFor="journey-description">Description</Label><Textarea id="journey-description" data-testid="input-journey-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
    <div className="space-y-2"><div className="flex items-center justify-between"><Label>Journey steps</Label><Button data-testid="button-add-journey-step" size="sm" variant="outline" onClick={() => setSteps((current) => [...current, { order: current.length + 1, channel: "email", delay_minutes: 60, subject: "Follow-up", message: "Following up on the supplier statement request." }])}><Plus className="mr-1 size-3.5" />Add step</Button></div><div className="space-y-2">{steps.map((step, index) => <div key={index} data-testid={`journey-editor-step-${index}`} className="rounded-lg border border-slate-200 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-slate-500">Step {index + 1}</span><div className="flex gap-1"><Button data-testid={`button-move-step-up-${index}`} variant="ghost" size="icon" className="size-7" disabled={index === 0} onClick={() => moveStep(index, -1)}><ChevronUp className="size-3.5" /></Button><Button data-testid={`button-move-step-down-${index}`} variant="ghost" size="icon" className="size-7" disabled={index === steps.length - 1} onClick={() => moveStep(index, 1)}><ChevronDown className="size-3.5" /></Button><Button data-testid={`button-remove-step-${index}`} variant="ghost" size="icon" className="size-7 text-rose-600" disabled={steps.length === 1} onClick={() => setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index).map((item, stepIndex) => ({ ...item, order: stepIndex + 1 })))}><Trash2 className="size-3.5" /></Button></div></div><div className="grid grid-cols-[0.8fr_1fr] gap-2"><select data-testid={`select-journey-step-channel-${index}`} className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm" value={step.channel} onChange={(event) => updateStep(index, { channel: event.target.value as EditableJourneyStep["channel"], subject: event.target.value === "email" ? step.subject ?? "Supplier statement request" : null })}><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select><Input data-testid={`input-journey-step-delay-${index}`} type="number" min="0" value={step.delay_minutes} onChange={(event) => updateStep(index, { delay_minutes: Number(event.target.value) || 0 })} placeholder="Delay after previous (minutes)" /></div>{step.channel === "email" ? <Input className="mt-2" data-testid={`input-journey-step-subject-${index}`} value={step.subject ?? ""} onChange={(event) => updateStep(index, { subject: event.target.value })} placeholder="Email subject" /> : null}<Textarea className="mt-2" data-testid={`input-journey-step-message-${index}`} value={step.message} onChange={(event) => updateStep(index, { message: event.target.value })} /></div>)}</div></div>
    <div className="space-y-2"><Label>Approved recipients</Label><div data-testid="journey-recipient-list" className="max-h-28 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3">{supplierId && eligibleContacts.length ? eligibleContacts.map((contact) => <label key={contact.id} className="flex items-center gap-2 text-xs"><Checkbox data-testid={`checkbox-journey-contact-${contact.id}`} checked={recipientIds.includes(contact.id)} disabled={!contact.is_approved} onCheckedChange={(checked) => setRecipientIds((current) => checked === true ? [...current, contact.id] : current.filter((id) => id !== contact.id))} /><span className="min-w-0 flex-1 truncate">{contact.name}</span><span className="text-slate-400">{contact.email ?? contact.whatsapp_phone ?? "No channel"}</span></label>) : <p className="text-xs text-amber-700">{supplierId ? "No active contacts for this supplier. Add and approve one first." : "Select a supplier to choose controlled recipients."}</p>}</div></div>
    <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label htmlFor="journey-escalation-owner">Escalation owner</Label><Input id="journey-escalation-owner" data-testid="input-journey-escalation-owner" value={escalationOwner} onChange={(event) => setEscalationOwner(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="journey-escalation-delay">Escalate after (minutes)</Label><Input id="journey-escalation-delay" data-testid="input-journey-escalation-delay" type="number" min="0" value={escalationDelay} onChange={(event) => setEscalationDelay(event.target.value)} /></div></div>
  </div><DialogFooter><Button data-testid="button-cancel-journey" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button data-testid="button-save-journey" className="bg-[#1f6b55] hover:bg-[#185343]" disabled={create.isPending || update.isPending} onClick={save}>{create.isPending || update.isPending ? "Saving…" : "Save journey"}</Button></DialogFooter></DialogContent></Dialog>;
}

export default function SupplierStatements() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const [view, setView] = useState<View>("requests");
  const [search, setSearch] = useState("");
  const [requestState, setRequestState] = useState<"all" | "awaiting" | "overdue" | "received" | "paused">("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [entityFilter, setEntityFilter] = useState("all");
  const [cadenceFilter, setCadenceFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [requestPage, setRequestPage] = useState(1);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedScheduleId, setSelectedScheduleId] = useState<number | null>(null);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [contactDialogOpen, setContactDialogOpen] = useState(false);
  const [journeyDialogOpen, setJourneyDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<SupplierStatementContact | undefined>();
  const [editingJourney, setEditingJourney] = useState<SupplierStatementJourney | undefined>();

  const supplierOptionsQuery = useQuery({
    queryKey: ["supplier-statements", "suppliers"],
    queryFn: () => apiFetch<{ suppliers?: WorkspaceRecord[] }>("/api/suppliers"),
    staleTime: 60_000,
  });
  const entityOptionsQuery = useQuery({
    queryKey: ["supplier-statements", "finance-entities"],
    queryFn: () => apiFetch<{ entities?: WorkspaceRecord[] }>("/api/finance/entities"),
    staleTime: 60_000,
  });
  const suppliers = useMemo<WorkspaceOption[]>(() => (supplierOptionsQuery.data?.suppliers ?? []).map((item) => ({ id: Number(item.id), name: displayName(item, `Supplier ${String(item.id)}`) })).filter((item) => Number.isFinite(item.id)), [supplierOptionsQuery.data]);
  const entities = useMemo<WorkspaceOption[]>(() => (entityOptionsQuery.data?.entities ?? []).map((item) => ({ id: Number(item.id), name: displayName(item, `Entity ${String(item.id)}`), code: typeof item.code === "string" ? item.code : undefined })).filter((item) => Number.isFinite(item.id)), [entityOptionsQuery.data]);
  const requestParams = useMemo(() => ({
    status: requestState === "awaiting" ? "awaiting_reply" : requestState === "received" ? "received" : requestState === "paused" ? "paused" : undefined,
    supplier_id: supplierFilter === "all" ? undefined : Number(supplierFilter),
    finance_entity_id: entityFilter === "all" ? undefined : Number(entityFilter),
  }), [requestState, supplierFilter, entityFilter]);
  const requestsQuery = useListSupplierStatementRequests(requestParams, { query: { queryKey: getListSupplierStatementRequestsQueryKey(requestParams) } });
  const countsQuery = useGetSupplierStatementRequestCounts({ query: { queryKey: getGetSupplierStatementRequestCountsQueryKey() } });
  const schedulesQuery = useListSupplierStatementSchedules(undefined, { query: { queryKey: getListSupplierStatementSchedulesQueryKey() } });
  const contactsQuery = useListSupplierStatementContacts(undefined, { query: { queryKey: getListSupplierStatementContactsQueryKey() } });
  const journeysQuery = useListSupplierStatementJourneys(undefined, { query: { queryKey: getListSupplierStatementJourneysQueryKey() } });
  const pauseSchedule = usePauseSupplierStatementSchedule();
  const resumeSchedule = useResumeSupplierStatementSchedule();
  const archiveContact = useArchiveSupplierStatementContact();
  const requests = requestsQuery.data?.requests ?? [];
  const schedules = schedulesQuery.data?.schedules ?? [];
  const contacts = contactsQuery.data?.contacts ?? [];
  const journeys = journeysQuery.data?.journeys ?? [];
  const filteredRequests = useMemo(() => requests.filter((request) => {
    const record = request as SupplierStatementRequest & { supplier_name?: string; finance_entity_name?: string };
    const haystack = `${record.supplier_name ?? ""} ${record.finance_entity_name ?? ""} ${request.period_label ?? ""} ${request.id ?? ""}`.toLowerCase();
    const steps = extractSnapshotSteps(request.journey_snapshot as Record<string, unknown> | undefined);
    const overdue = Boolean(request.next_action_at && new Date(request.next_action_at).getTime() < Date.now() && !["received", "reconciled", "cancelled"].includes(String(request.status)));
    return (!search.trim() || haystack.includes(search.trim().toLowerCase()))
      && (requestState !== "overdue" || overdue)
      && (cadenceFilter === "all" || request.cadence === cadenceFilter)
      && (channelFilter === "all" || steps.some((step) => step.channel === channelFilter));
  }), [requests, search, requestState, cadenceFilter, channelFilter]);
  const pagedRequests = useMemo(() => filteredRequests.slice((requestPage - 1) * 10, requestPage * 10), [filteredRequests, requestPage]);
  const filteredSchedules = useMemo(() => schedules.filter((schedule) => {
    const supplier = suppliers.find((item) => item.id === schedule.supplier_id);
    return !search.trim() || `${supplier?.name ?? ""} ${schedule.cadence ?? ""} ${schedule.timezone ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
  }), [schedules, suppliers, search]);
  const filteredContacts = useMemo(() => contacts.filter((contact) => !search.trim() || `${contact.name} ${contact.email ?? ""} ${contact.department ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [contacts, search]);

  const invalidateRequests = () => {
    void queryClient.invalidateQueries({ queryKey: getListSupplierStatementRequestsQueryKey(requestParams) });
    void queryClient.invalidateQueries({ queryKey: getGetSupplierStatementRequestCountsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListSupplierStatementSchedulesQueryKey() });
  };
  const invalidateSchedules = () => void queryClient.invalidateQueries({ queryKey: getListSupplierStatementSchedulesQueryKey() });
  const invalidateContacts = () => void queryClient.invalidateQueries({ queryKey: getListSupplierStatementContactsQueryKey() });
  const invalidateJourneys = () => void queryClient.invalidateQueries({ queryKey: getListSupplierStatementJourneysQueryKey() });

  const selectedSchedule = schedules.find((schedule) => schedule.id === selectedScheduleId);
  const queryError = view === "requests" ? requestsQuery.isError : view === "schedules" ? schedulesQuery.isError : contactsQuery.isError;
  const queryLoading = view === "requests" ? requestsQuery.isLoading : view === "schedules" ? schedulesQuery.isLoading : contactsQuery.isLoading;
  const count = countsQuery.data?.counts;

  useEffect(() => {
    const requestId = new URLSearchParams(location.split("?")[1] ?? "").get("request_id");
    if (requestId && requests.some((request) => request.id === requestId)) {
      setSelectedRequestId(requestId);
    }
  }, [location, requests]);

  const changeView = (nextView: View) => { setView(nextView); setSelectedRequestId(null); setSelectedScheduleId(null); };
  return (
    <div data-testid="page-supplier-statements" className="min-h-[100dvh] bg-[#f5f7f6] text-slate-900">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-5 flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-[#1f6b55]"><span className="size-1.5 rounded-full bg-[#1f6b55]" />Procurement operations <ChevronRight className="size-3.5 text-slate-400" /> Finance control</div><h1 data-testid="heading-supplier-statements" className="text-[26px] font-semibold tracking-[-0.04em] text-slate-950">Supplier statements</h1><p className="mt-1 max-w-2xl text-sm text-slate-500">Collect exact-period statements, follow every request journey, and keep recurring supplier schedules ready.</p></div>
          <div className="flex items-center gap-2"><Button data-testid="button-refresh-statements" variant="ghost" size="sm" className="text-slate-500" onClick={() => { void requestsQuery.refetch(); void schedulesQuery.refetch(); void contactsQuery.refetch(); void journeysQuery.refetch(); }}><RefreshCw className="mr-1.5 size-3.5" />Refresh</Button><Button data-testid="button-new-request" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => setRequestDialogOpen(true)}><Plus className="mr-1.5 size-4" />Collect statement</Button></div>
        </header>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[{ label: "Open work", value: count?.open ?? "—", icon: FileClock, tone: "text-sky-700 bg-sky-50" }, { label: "Needs setup", value: count?.needs_setup ?? "—", icon: Settings2, tone: "text-orange-700 bg-orange-50" }, { label: "Received", value: count?.received ?? "—", icon: CheckCircle2, tone: "text-emerald-700 bg-emerald-50" }, { label: "Reconciled", value: count?.reconciled ?? "—", icon: FileCheck2, tone: "text-teal-700 bg-teal-50" }].map((item) => <div key={item.label} data-testid={`metric-${item.label.toLowerCase().replaceAll(" ", "-")}`} className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"><div className="flex items-start justify-between"><div><p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-400">{item.label}</p><p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-900">{item.value}</p></div><div className={cn("flex size-8 items-center justify-center rounded-lg", item.tone)}><item.icon className="size-4" /></div></div></div>)}
        </div>
          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-2 shadow-[0_1px_2px_rgba(15,23,42,0.03)] md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-1 overflow-x-auto">{([{ key: "requests", label: "Requests", icon: FileClock }, { key: "schedules", label: "Supplier schedules", icon: CalendarClock }, { key: "contacts", label: "Approved contacts", icon: UsersRound }] as const).map((item) => <button type="button" key={item.key} data-testid={`tab-${item.key}`} onClick={() => changeView(item.key)} className={cn("inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors", view === item.key ? "bg-[#e8f1ed] text-[#1f6b55]" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800")}><item.icon className="size-4" />{item.label}{item.key === "requests" && count?.total ? <span className="rounded-full bg-white px-1.5 text-[10px] text-slate-500">{count.total}</span> : null}</button>)}</div>
          <div className="flex flex-col gap-2 sm:flex-row"><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><Input data-testid="input-search-statements" className="h-9 w-full border-slate-200 pl-9 text-sm sm:w-64" value={search} onChange={(event) => { setSearch(event.target.value); setRequestPage(1); }} placeholder="Search supplier, period…" /></div>{view === "requests" ? <div className="flex flex-wrap gap-2"><select data-testid="select-request-state" className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600" value={requestState} onChange={(event) => { setRequestState(event.target.value as typeof requestState); setRequestPage(1); }}><option value="all">All</option><option value="awaiting">Awaiting</option><option value="overdue">Overdue</option><option value="received">Received</option><option value="paused">Paused</option></select><select data-testid="select-request-supplier-filter" className="h-9 max-w-[150px] rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600" value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="all">All suppliers</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select data-testid="select-request-entity-filter" className="h-9 max-w-[150px] rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600" value={entityFilter} onChange={(event) => setEntityFilter(event.target.value)}><option value="all">All entities</option>{entities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select data-testid="select-request-cadence-filter" className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600" value={cadenceFilter} onChange={(event) => setCadenceFilter(event.target.value)}><option value="all">All frequencies</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select><select data-testid="select-request-channel-filter" className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}><option value="all">All channels</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></div> : view !== "contacts" ? <Button data-testid="button-filter-schedules" size="sm" variant="outline" className="h-9" onClick={() => setSearch("")}><SlidersHorizontal className="mr-1.5 size-3.5" />Clear filter</Button> : null}</div>
        </div>
        <div className={cn("mt-4 flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]", (selectedRequestId || selectedScheduleId !== null) ? "flex-col lg:flex-row" : "block")}>
          <main className="min-w-0 flex-1">
            {queryLoading ? <LoadingRows /> : queryError ? <ErrorState onRetry={() => { if (view === "requests") void requestsQuery.refetch(); else if (view === "schedules") void schedulesQuery.refetch(); else void contactsQuery.refetch(); }} /> : view === "requests" ? <div data-testid="requests-list">
              <div className="grid grid-cols-[1.4fr_1fr_1fr_0.9fr_auto] gap-4 border-b border-slate-100 bg-slate-50/80 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-400"><span>Supplier / period</span><span>Finance entity</span><span>Next action</span><span>Status</span><span /></div>
              {pagedRequests.length ? <div className="divide-y divide-slate-100">{pagedRequests.map((request) => { const record = request as SupplierStatementRequest & { supplier_name?: string; finance_entity_name?: string }; const supplierName = record.supplier_name ?? suppliers.find((item) => item.id === request.supplier_id)?.name ?? `Supplier ${request.supplier_id ?? ""}`; const entityName = record.finance_entity_name ?? entities.find((item) => item.id === request.finance_entity_id)?.name ?? `Entity ${request.finance_entity_id ?? ""}`; return <button type="button" key={request.id} data-testid={`row-request-${request.id}`} onClick={() => { if (request.id) setSelectedRequestId(request.id); }} className={cn("grid w-full grid-cols-[1.4fr_1fr_1fr_0.9fr_auto] items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[#f7faf8]", selectedRequestId === request.id && "bg-[#f1f7f4]")}><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{supplierName}</p><p className="mt-1 truncate text-xs text-slate-500">{request.period_label ?? `${formatDate(request.period_start)} — ${formatDate(request.period_end)}`} <span className="text-slate-300">·</span> {request.source === "scheduled" ? "Scheduled" : "Manual"}</p></div><p className="truncate text-sm text-slate-600">{entityName}</p><div className="min-w-0"><p className="truncate text-xs font-medium text-slate-700">{request.next_action ?? "No action queued"}</p><p className="mt-1 text-[11px] text-slate-400">{formatDateInTimezone(request.next_action_at, request.timezone ?? "UTC")}</p></div><StatusBadge status={request.status} /><ChevronRight className="size-4 text-slate-300" /></button>; })}</div> : <EmptyState icon={FilePlus2} title="No collection requests" description={search ? "No requests match your current search." : "Create an exact-period request when a supplier statement is needed."} action={!search ? <Button data-testid="button-empty-create-request" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => setRequestDialogOpen(true)}><Plus className="mr-1.5 size-4" />Collect statement</Button> : undefined} />}
              <div className="flex items-center justify-between border-t border-slate-100 px-5 py-3 text-xs text-slate-500"><span>Showing {pagedRequests.length ? (requestPage - 1) * 10 + 1 : 0}–{Math.min(requestPage * 10, filteredRequests.length)} of {filteredRequests.length} · Counts use server dates; overdue is based on the server-provided next action deadline.</span><div className="flex gap-2"><Button data-testid="button-request-page-prev" variant="outline" size="sm" disabled={requestPage === 1} onClick={() => setRequestPage((page) => page - 1)}><ChevronUp className="mr-1 size-3.5 rotate-[-90deg]" />Previous</Button><Button data-testid="button-request-page-next" variant="outline" size="sm" disabled={requestPage * 10 >= filteredRequests.length} onClick={() => setRequestPage((page) => page + 1)}>Next<ChevronDown className="ml-1 size-3.5 rotate-[-90deg]" /></Button></div></div>
            </div> : view === "schedules" ? <div data-testid="schedules-list">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-5 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-400">Recurring collection</p><p className="mt-1 text-xs text-slate-500">{filteredSchedules.length} configured schedule{filteredSchedules.length === 1 ? "" : "s"}</p></div><Button type="button" data-testid="button-new-schedule" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => { setSelectedScheduleId(null); setScheduleDialogOpen(true); }}><Plus className="mr-1.5 size-3.5" />New schedule</Button></div>
              {filteredSchedules.length ? <div className="divide-y divide-slate-100">{filteredSchedules.map((schedule) => { const supplier = suppliers.find((item) => item.id === schedule.supplier_id); const entity = entities.find((item) => item.id === schedule.finance_entity_id); return <div key={schedule.id} data-testid={`row-schedule-${schedule.id}`} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[#f7faf8]"><button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setSelectedScheduleId(schedule.id ?? null); setScheduleDialogOpen(true); }}><div className="flex items-center gap-2"><span className="text-sm font-semibold text-slate-800">{supplier?.name ?? `Supplier ${schedule.supplier_id ?? ""}`}</span>{schedule.is_active === false ? <Badge variant="outline" className="border-slate-200 text-[10px] text-slate-400">Paused</Badge> : <Badge variant="outline" className="border-[#cfe2d9] bg-[#f1f7f4] text-[10px] text-[#1f6b55]">Active</Badge>}</div><p className="mt-1 text-xs text-slate-500">{schedule.cadence ?? "monthly"} · day {schedule.local_day ?? 1} at {schedule.local_time ?? "09:00"} · {schedule.timezone ?? "Local time"}</p></button><div className="hidden text-right sm:block"><p className="text-[10px] uppercase tracking-wider text-slate-400">Next run</p><p className="mt-1 text-xs font-medium text-slate-700">{formatDateInTimezone(schedule.next_run_at, schedule.timezone ?? "UTC")}</p></div><div className="flex items-center gap-1"><Badge variant="outline" className={cn("hidden text-[10px] sm:inline-flex", schedule.readiness === "Ready" ? "border-[#cfe2d9] text-[#1f6b55]" : "border-orange-200 text-orange-700")}>{schedule.readiness ?? "Needs setup"}</Badge>{schedule.is_active === false ? <Button type="button" data-testid={`button-resume-schedule-${schedule.id}`} variant="ghost" size="icon" className="size-8 text-[#1f6b55]" disabled={resumeSchedule.isPending} onClick={() => schedule.id && resumeSchedule.mutate({ id: schedule.id }, { onSuccess: () => { toast({ title: "Schedule resumed" }); invalidateSchedules(); }, onError: (error) => toast({ title: "Could not resume schedule", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) })}><Play className="size-4" /></Button> : <Button type="button" data-testid={`button-pause-schedule-${schedule.id}`} variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-amber-700" disabled={pauseSchedule.isPending} onClick={() => schedule.id && pauseSchedule.mutate({ id: schedule.id }, { onSuccess: () => { toast({ title: "Schedule paused" }); invalidateSchedules(); }, onError: (error) => toast({ title: "Could not pause schedule", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) })}><CirclePause className="size-4" /></Button>}<Button type="button" data-testid={`button-edit-schedule-${schedule.id}`} variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-slate-800" onClick={() => { setSelectedScheduleId(schedule.id ?? null); setScheduleDialogOpen(true); }}><Pencil className="size-3.5" /></Button></div></div>; })}</div> : <EmptyState icon={CalendarClock} title="No supplier schedules" description="Set a dependable cadence for suppliers you collect statements from every month or quarter." action={<Button type="button" data-testid="button-empty-create-schedule" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => setScheduleDialogOpen(true)}><Plus className="mr-1.5 size-4" />Create schedule</Button>} />}
              <div className="border-t border-slate-100 px-5 py-5"><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Collection journeys</p><p className="mt-1 text-xs text-slate-400">Versioned message steps used by schedules and requests.</p></div><Button data-testid="button-new-journey" size="sm" variant="outline" onClick={() => { setEditingJourney(undefined); setJourneyDialogOpen(true); }}><Plus className="mr-1.5 size-3.5" />New journey</Button></div>{journeys.length ? <div className="grid gap-2 md:grid-cols-2">{journeys.map((journey) => <button type="button" key={journey.id} data-testid={`row-journey-${journey.id}`} className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-left transition-colors hover:border-[#a7cbb9] hover:bg-[#f7faf8]" onClick={() => { setEditingJourney(journey); setJourneyDialogOpen(true); }}><div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{journey.name ?? "Untitled journey"}</p><p className="mt-1 truncate text-xs text-slate-500">{journey.description ?? "No description"}</p></div><Pencil className="size-3.5 shrink-0 text-slate-400" /></button>)}</div> : <p className="text-sm text-slate-500">No journeys configured.</p>}</div>
            </div> : <div data-testid="contacts-list">
              <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-5 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-400">Supplier contacts</p><p className="mt-1 text-xs text-slate-500">Approved recipients available to collection journeys.</p></div><Button data-testid="button-new-contact" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => { setEditingContact(undefined); setContactDialogOpen(true); }}><Plus className="mr-1.5 size-3.5" />Add contact</Button></div>{filteredContacts.length ? <div className="divide-y divide-slate-100">{filteredContacts.map((contact) => { const supplier = suppliers.find((item) => item.id === contact.supplier_id); return <div key={contact.id} data-testid={`row-contact-${contact.id}`} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-[#f7faf8]"><div className="flex min-w-0 items-center gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#e8f1ed] text-xs font-semibold text-[#1f6b55]">{initials(contact.name)}</div><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{contact.name}</p><p className="mt-1 truncate text-xs text-slate-500">{supplier?.name ?? `Supplier ${contact.supplier_id}`} · {contact.role ?? "No role"}{contact.department ? ` · ${contact.department}` : ""}</p></div></div><div className="hidden min-w-0 flex-1 items-center gap-4 text-xs text-slate-500 md:flex"><span className="truncate">{contact.email ?? "No email"}</span><span>{contact.whatsapp_phone ? "WhatsApp" : contact.phone ? "Phone" : "No channel"}</span></div><div className="flex items-center gap-2"><Badge variant="outline" className={cn("text-[10px]", contact.is_approved ? "border-[#cfe2d9] bg-[#f1f7f4] text-[#1f6b55]" : "border-amber-200 bg-amber-50 text-amber-700")}>{contact.is_approved ? "Approved" : "Review"}</Badge>{contact.is_selected ? <Badge variant="secondary" className="hidden text-[10px] sm:inline-flex">Selected</Badge> : null}<Button data-testid={`button-edit-contact-${contact.id}`} variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-slate-800" onClick={() => { setEditingContact(contact); setContactDialogOpen(true); }}><Pencil className="size-3.5" /></Button><Button data-testid={`button-archive-contact-${contact.id}`} variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-rose-600" disabled={archiveContact.isPending} onClick={() => archiveContact.mutate({ id: contact.id }, { onSuccess: () => { toast({ title: "Contact archived" }); invalidateContacts(); }, onError: (error) => toast({ title: "Could not archive contact", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" }) })}><Trash2 className="size-3.5" /></Button></div></div>; })}</div> : <EmptyState icon={UserRound} title="No approved contacts" description="Add named supplier contacts so every request has a controlled delivery destination." action={<Button data-testid="button-empty-create-contact" size="sm" className="bg-[#1f6b55] hover:bg-[#185343]" onClick={() => { setEditingContact(undefined); setContactDialogOpen(true); }}><Plus className="mr-1.5 size-4" />Add contact</Button>} />}</div>}
          </main>
          {selectedRequestId ? <RequestDetailPanel requestId={selectedRequestId} previousRequests={requests} contacts={contacts} onClose={() => setSelectedRequestId(null)} onDeleted={() => { setSelectedRequestId(null); invalidateRequests(); }} invalidate={invalidateRequests} /> : null}
          {selectedScheduleId !== null && scheduleDialogOpen ? <ScheduleEditor schedule={selectedSchedule} suppliers={suppliers} entities={entities} journeys={journeys} journeysLoading={journeysQuery.isLoading} journeysError={journeysQuery.isError} onRetryJourneys={() => { void journeysQuery.refetch(); }} contacts={contacts} onClose={() => { setScheduleDialogOpen(false); setSelectedScheduleId(null); }} onSaved={() => { invalidateSchedules(); setScheduleDialogOpen(false); setSelectedScheduleId(null); }} /> : null}
          {scheduleDialogOpen && selectedScheduleId === null ? <ScheduleEditor suppliers={suppliers} entities={entities} journeys={journeys} journeysLoading={journeysQuery.isLoading} journeysError={journeysQuery.isError} onRetryJourneys={() => { void journeysQuery.refetch(); }} contacts={contacts} onClose={() => setScheduleDialogOpen(false)} onSaved={() => { invalidateSchedules(); setScheduleDialogOpen(false); }} /> : null}
        </div>
      </div>
      <RequestCreateDialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen} suppliers={suppliers} entities={entities} journeys={journeys} contacts={contacts} onSaved={(result) => { invalidateRequests(); setView("requests"); setSelectedScheduleId(null); setScheduleDialogOpen(false); setSearch(""); setRequestState("all"); setSupplierFilter("all"); setEntityFilter("all"); setCadenceFilter("all"); setChannelFilter("all"); setRequestPage(1); setSelectedRequestId(result?.request.id ?? null); }} />
      <ContactDialog open={contactDialogOpen} onOpenChange={setContactDialogOpen} suppliers={suppliers} contact={editingContact} onSaved={invalidateContacts} />
      <JourneyDialog open={journeyDialogOpen} onOpenChange={setJourneyDialogOpen} journey={editingJourney} suppliers={suppliers} contacts={contacts} onSaved={invalidateJourneys} />
    </div>
  );
}