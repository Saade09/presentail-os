export function formatSupplierStatementDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.trim();
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}