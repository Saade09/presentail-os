export type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

const WORK_SCHEDULE_DAYS: { key: keyof WorkingDaysConfig; label: string; short: string }[] = [
  { key: "monday", label: "Monday", short: "Mon" },
  { key: "tuesday", label: "Tuesday", short: "Tue" },
  { key: "wednesday", label: "Wednesday", short: "Wed" },
  { key: "thursday", label: "Thursday", short: "Thu" },
  { key: "friday", label: "Friday", short: "Fri" },
  { key: "saturday", label: "Saturday", short: "Sat" },
  { key: "sunday", label: "Sunday", short: "Sun" },
];

export function formatWorkSchedule(days: WorkingDaysConfig | null): string | null {
  const config = days ?? DEFAULT_WORKING_DAYS;
  const isDefault =
    config.monday &&
    config.tuesday &&
    config.wednesday &&
    config.thursday &&
    config.friday &&
    !config.saturday &&
    !config.sunday;
  if (isDefault) return null;

  const activeDays = WORK_SCHEDULE_DAYS.filter((d) => config[d.key]);
  if (activeDays.length === 0) return "No working days";

  const indices = activeDays.map((d) =>
    WORK_SCHEDULE_DAYS.findIndex((s) => s.key === d.key),
  );
  const isContiguous = indices.every((idx, i) => i === 0 || idx === indices[i - 1] + 1);

  if (isContiguous && activeDays.length > 1) {
    return `${activeDays[0].short}\u2013${activeDays[activeDays.length - 1].short}`;
  }
  return activeDays.map((d) => d.short).join(", ");
}
