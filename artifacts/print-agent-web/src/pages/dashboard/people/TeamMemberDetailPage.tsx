import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  ArrowLeft,
  Mail,
  Phone,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  UserCheck,
  Loader2,
  UserCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type TeamMember = {
  id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_id: number | null;
  department_name: string | null;
  employment_status: string;
  start_date: string | null;
  birthday: string | null;
  notes: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  archived_at: string | null;
  image_url: string | null;
};

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "full_time", label: "Full Time" },
  { value: "part_time", label: "Part Time" },
  { value: "contractor", label: "Contractor" },
  { value: "intern", label: "Intern" },
  { value: "temporary", label: "Temporary" },
];

function employmentStatusLabel(status: string) {
  return EMPLOYMENT_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function employmentStatusColor(status: string) {
  switch (status) {
    case "full_time": return "bg-emerald-100 text-emerald-800";
    case "part_time": return "bg-blue-100 text-blue-800";
    case "contractor": return "bg-purple-100 text-purple-800";
    case "intern": return "bg-amber-100 text-amber-800";
    default: return "bg-muted text-muted-foreground";
  }
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return null;
  return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function TeamMemberDetailPage() {
  const [, params] = useRoute("/admin/people/team-members/:id");
  const id = params?.id ? Number(params.id) : null;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["team-member", id],
    queryFn: () => apiFetch(`/api/team-members/${id}`),
    enabled: id != null,
  });

  const member: TeamMember | null = (data as { team_member?: TeamMember })?.team_member ?? null;

  const displayName = member
    ? [member.first_name, member.last_name].filter(Boolean).join(" ")
    : "";

  const initials = member
    ? (member.first_name.charAt(0) + (member.last_name?.charAt(0) ?? "")).toUpperCase()
    : "";

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/admin/people/team-members">
            <ArrowLeft size={16} className="mr-1" />
            Back to Team Members
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading…
        </div>
      ) : isError || !member ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <UserCircle2 size={36} className="opacity-30" />
          <p className="text-sm">Team member not found.</p>
          <Button size="sm" variant="outline" asChild>
            <Link href="/admin/people/team-members">Back to list</Link>
          </Button>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-start gap-5">
            <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center text-2xl font-bold shrink-0 overflow-hidden">
              {member.image_url ? (
                <img
                  src={member.image_url}
                  alt=""
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                initials || <UserCheck size={28} className="opacity-40" />
              )}
            </div>
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold">{displayName}</h1>
                {member.archived_at && (
                  <Badge variant="secondary" className="text-xs">Archived</Badge>
                )}
              </div>
              {member.job_title && (
                <p className="text-muted-foreground text-sm flex items-center gap-1.5">
                  <BriefcaseBusiness size={14} />
                  {member.job_title}
                </p>
              )}
              {member.department_name && (
                <p className="text-muted-foreground text-sm flex items-center gap-1.5">
                  <Building2 size={14} />
                  {member.department_name}
                </p>
              )}
              <Badge
                className={`text-xs py-0 h-5 font-normal ${employmentStatusColor(member.employment_status)}`}
                variant="secondary"
              >
                {employmentStatusLabel(member.employment_status)}
              </Badge>
            </div>
          </div>

          {/* Contact & Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Contact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {member.email ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail size={14} className="text-muted-foreground shrink-0" />
                    <a href={`mailto:${member.email}`} className="hover:underline truncate">
                      {member.email}
                    </a>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No email</p>
                )}
                {member.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone size={14} className="text-muted-foreground shrink-0" />
                    <a href={`tel:${member.phone}`} className="hover:underline">
                      {member.phone}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Employment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {member.start_date && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays size={14} className="text-muted-foreground shrink-0" />
                    <span>Started {formatDate(member.start_date)}</span>
                  </div>
                )}
                {member.birthday && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays size={14} className="text-muted-foreground shrink-0" />
                    <span>Birthday: {formatDate(member.birthday)}</span>
                  </div>
                )}
                {!member.start_date && !member.birthday && (
                  <p className="text-sm text-muted-foreground">No dates on file</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Emergency Contact */}
          {(member.emergency_contact_name || member.emergency_contact_phone) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Emergency Contact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {member.emergency_contact_name && (
                  <p className="font-medium">
                    {member.emergency_contact_name}
                    {member.emergency_contact_relationship && (
                      <span className="text-muted-foreground font-normal ml-1.5">
                        ({member.emergency_contact_relationship})
                      </span>
                    )}
                  </p>
                )}
                {member.emergency_contact_phone && (
                  <div className="flex items-center gap-2">
                    <Phone size={13} className="text-muted-foreground" />
                    <a href={`tel:${member.emergency_contact_phone}`} className="hover:underline">
                      {member.emergency_contact_phone}
                    </a>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Notes */}
          {member.notes && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Notes</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm whitespace-pre-wrap">{member.notes}</p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
