import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAED(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string" && value.trim() === "") return "—"
  const num = typeof value === "string" ? Number(value) : value
  if (!isFinite(num) || isNaN(num)) return "—"
  return `${Math.round(num)} AED`
}

export function formatUSD(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string" && value.trim() === "") return "—"
  const num = typeof value === "string" ? Number(value) : value
  if (!isFinite(num) || isNaN(num)) return "—"
  return `$${num.toFixed(2)} USD`
}
