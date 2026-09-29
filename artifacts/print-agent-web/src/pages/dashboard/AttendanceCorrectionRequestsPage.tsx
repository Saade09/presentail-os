import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminAttendanceRequests,
  useApproveAttendanceRequest,
  useRejectAttendanceRequest,
  getGetAdminAttendanceRequestsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  FileEdit,
  ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

type CorrectionRequest = {
  id: number;
  employee_id: number;
  employee_name: string | null;
  attendance_session_id: number | null;
  request_type: string;
  requested_clock_in_at: string | null;
  requested_clock_out_at: string | null;
  reason: string | null;
  status: string;
  reviewer_note: string | null;
  created_at: string;
};

const REQUEST_TYPE_LABELS: Record<string, string> = {
  missed_clock_in: "Missed Clock-In",
  missed_clock_out: "Missed Clock-Out",
  edit_clock_in: "Edit Clock-In",
  edit_clock_out: "Edit Clock-Out",
  offsite_clock_in: "Offsite Clock-In",
  offsite_clock_out: "Offsite Clock-Out",
  other: "Other",
};

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200" variant="secondary">
          <Clock size={10} /> Pending
        </Badge>
      );
    case "approved":
      return (
        <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-emerald-200" variant="secondary">
          <CheckCircle2 size={10} /> Approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge className="gap-1 bg-red-100 text-red-800 border-red-200" variant="secondary">
          <XCircle size={10} /> Rejected
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatDateTime(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AttendanceCorrectionRequestsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = useState("pending");
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [activeRequest, setActiveRequest] = useState<CorrectionRequest | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");

  const { data, isLoading } = useGetAdminAttendanceRequests(
    { status: statusFilter, limit: 100 },
  );
  const requests: CorrectionRequest[] =
    ((data as Record<string, unknown> | undefined)?.requests as CorrectionRequest[] | undefined) ?? [];

  const approveMutation = useApproveAttendanceRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        toast({ title: "Request approved and correction applied" });
        setActiveRequest(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const rejectMutation = useRejectAttendanceRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        toast({ title: "Request rejected" });
        setRejectDialogOpen(false);
        setActiveRequest(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  function handleApprove(req: CorrectionRequest) {
    approveMutation.mutate({ id: req.id, data: {} });
  }

  function openReject(req: CorrectionRequest) {
    setActiveRequest(req);
    setReviewerNote("");
    setRejectDialogOpen(true);
  }

  function handleReject() {
    if (!activeRequest) return;
    rejectMutation.mutate({
      id: activeRequest.id,
      data: reviewerNote ? { reviewer_note: reviewerNote } : {},
    });
  }

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin/attendance">
              <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 text-muted-foreground">
                <ChevronLeft size={15} />
                Back to Attendance
              </Button>
            </Link>
          </div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileEdit size={22} />
            Correction Requests
            {pendingCount > 0 && statusFilter === "pending" && (
              <Badge className="text-sm px-2 py-0.5 bg-amber-100 text-amber-800 border-amber-200" variant="secondary">
                {pendingCount} pending
              </Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Review and act on employee attendance correction requests.
          </p>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
              Loading…
            </div>
          ) : requests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <CheckCircle2 size={32} className="opacity-30" />
              <p className="text-sm">
                {statusFilter === "pending"
                  ? "No pending correction requests."
                  : `No ${statusFilter} requests found.`}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {requests.map((req) => (
                <div key={req.id} className="px-4 py-4 hover:bg-muted/20 transition-colors">
                  <div className="flex items-start gap-3 flex-wrap">
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {req.employee_name ?? `Employee #${req.employee_id}`}
                        </span>
                        {statusBadge(req.status)}
                        <Badge variant="outline" className="text-xs font-normal">
                          {REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type}
                        </Badge>
                      </div>

                      {req.reason && (
                        <p className="text-sm text-muted-foreground">
                          <span className="font-medium text-foreground">Reason: </span>
                          {req.reason}
                        </p>
                      )}

                      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {req.requested_clock_in_at && (
                          <span>
                            Requested clock-in: <span className="text-foreground">{formatDateTime(req.requested_clock_in_at)}</span>
                          </span>
                        )}
                        {req.requested_clock_out_at && (
                          <span>
                            Requested clock-out: <span className="text-foreground">{formatDateTime(req.requested_clock_out_at)}</span>
                          </span>
                        )}
                        {req.attendance_session_id && (
                          <span>
                            Session #{req.attendance_session_id}
                          </span>
                        )}
                        <span>Submitted {formatDateTime(req.created_at)}</span>
                      </div>

                      {req.reviewer_note && (
                        <p className="text-xs text-muted-foreground italic">
                          Reviewer note: "{req.reviewer_note}"
                        </p>
                      )}
                    </div>

                    {req.status === "pending" && (
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          size="sm"
                          className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                          onClick={() => handleApprove(req)}
                          disabled={approveMutation.isPending}
                        >
                          {approveMutation.isPending && approveMutation.variables?.id === req.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <CheckCircle2 size={14} />
                          )}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() => openReject(req)}
                        >
                          <XCircle size={14} />
                          Reject
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={(o) => { if (!o) setRejectDialogOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle size={18} className="text-red-500" />
              Reject Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {activeRequest && (
              <p className="text-sm text-muted-foreground">
                Rejecting <span className="font-medium text-foreground">{REQUEST_TYPE_LABELS[activeRequest.request_type]}</span> request
                from <span className="font-medium text-foreground">{activeRequest.employee_name ?? `Employee #${activeRequest.employee_id}`}</span>.
              </p>
            )}
            <Textarea
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Reason for rejection (optional)…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)} disabled={rejectMutation.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={rejectMutation.isPending}>
              {rejectMutation.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
