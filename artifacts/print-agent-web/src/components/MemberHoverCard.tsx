import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, BriefcaseBusiness, Building2 } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { apiFetch } from "@/lib/queryClient";

interface MemberHoverCardProps {
  children: React.ReactNode;
  name: string;
  personId?: string | number | null;
  jobTitle?: string | null;
  departmentName?: string | null;
  imageUrl?: string | null;
  side?: "top" | "bottom" | "left" | "right";
}

type PersonSnap = {
  job_title: string | null;
  department_name: string | null;
  image_url: string | null;
};

export function MemberHoverCard({
  children,
  name,
  personId,
  jobTitle,
  departmentName,
  imageUrl,
  side = "top",
}: MemberHoverCardProps) {
  const [open, setOpen] = useState(false);

  const needsFetch =
    personId != null &&
    (jobTitle === undefined || departmentName === undefined || imageUrl === undefined);

  const { data: fetched } = useQuery<PersonSnap>({
    queryKey: ["people-snap", String(personId)],
    queryFn: () => apiFetch<PersonSnap>(`/api/people/${personId}`),
    enabled: open && !!needsFetch,
    staleTime: 5 * 60 * 1000,
  });

  const resolvedJobTitle = jobTitle !== undefined ? jobTitle : (fetched?.job_title ?? null);
  const resolvedDepartment = departmentName !== undefined ? departmentName : (fetched?.department_name ?? null);
  const resolvedImageUrl = imageUrl !== undefined ? imageUrl : (fetched?.image_url ?? null);

  const initials = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={400} closeDelay={150}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        className="w-56 p-3"
        side={side}
        sideOffset={6}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold shrink-0 overflow-hidden select-none">
            {resolvedImageUrl ? (
              <img src={resolvedImageUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              initials
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight truncate">{name}</p>
            {resolvedJobTitle && (
              <p className="mt-0.5 text-xs text-muted-foreground truncate flex items-center gap-1">
                <BriefcaseBusiness size={10} className="shrink-0" />
                {resolvedJobTitle}
              </p>
            )}
            {resolvedDepartment && (
              <p className="mt-0.5 text-xs text-muted-foreground truncate flex items-center gap-1">
                <Building2 size={10} className="shrink-0" />
                {resolvedDepartment}
              </p>
            )}
          </div>
        </div>
        {personId != null && (
          <div className="mt-2 pt-2 border-t">
            <Link
              href={`/dashboard/people/${personId}`}
              className="text-xs text-primary hover:underline flex items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={11} />
              View profile
            </Link>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
