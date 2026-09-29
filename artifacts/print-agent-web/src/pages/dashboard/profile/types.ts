export type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

export type FullProfileData = {
  phone: string | null;
  job_title: string | null;
  birthday: string | null;
  gender: string | null;
  notify_email_on_time_off_request: boolean;
  notify_email_on_time_off_decision: boolean;
  notify_email_on_new_sign_in: boolean;
  notify_email_on_new_order: boolean;
  notify_email_weekly_digest: boolean;
  working_days: WorkingDaysConfig | null;
  department: string | null;
  location: string | null;
  employment_type: string | null;
  employment_status: string | null;
  start_date: string | null;
  manager_member_id: number | null;
  manager_name: string | null;
  role: string;
  custom_role_id: number | null;
  custom_role_name: string | null;
  /** Multi-role: IDs of all assigned roles (empty for owners / no-role members). */
  custom_role_ids: number[];
  /** Multi-role: names of all assigned roles (empty for owners / no-role members). */
  custom_role_names: string[];
  member_email: string;
  assigned_locations: { id: number; name: string }[];
  ec_name: string | null;
  ec_relationship: string | null;
  ec_phone_country_code: string | null;
  ec_phone: string | null;
  pref_add_person_last_type: string | null;
};

export const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

export const WORK_SCHEDULE_DAYS: { key: keyof WorkingDaysConfig; label: string; short: string }[] = [
  { key: "monday", label: "Monday", short: "Mon" },
  { key: "tuesday", label: "Tuesday", short: "Tue" },
  { key: "wednesday", label: "Wednesday", short: "Wed" },
  { key: "thursday", label: "Thursday", short: "Thu" },
  { key: "friday", label: "Friday", short: "Fri" },
  { key: "saturday", label: "Saturday", short: "Sat" },
  { key: "sunday", label: "Sunday", short: "Sun" },
];

export const GENDER_OPTIONS = [
  { value: "", label: "" },
  { value: "prefer_not_to_say", label: "Prefer not to say" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "non_binary", label: "Non-binary" },
  { value: "other", label: "Other" },
];

export const EMPLOYMENT_TYPE_OPTIONS = [
  { value: "", label: "— Not set —" },
  { value: "full_time", label: "Full-time" },
  { value: "part_time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "freelance", label: "Freelance" },
  { value: "intern", label: "Intern" },
];

export function formatBirthday(dateStr: string | null): string {
  if (!dateStr) return "—";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatDisplayDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[parseInt(parts[1], 10) - 1] ?? parts[1];
  return `${parseInt(parts[2], 10)} ${month} ${parts[0]}`;
}

export function getRoleLabel(profile: FullProfileData): string {
  if (profile.role === "owner") return "Owner";
  const names = profile.custom_role_names?.length
    ? profile.custom_role_names
    : profile.custom_role_name
      ? [profile.custom_role_name]
      : [];
  if (names.length > 0) return names.join(", ");
  return "Member";
}
