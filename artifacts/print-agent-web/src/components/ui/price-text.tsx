import { cn } from "@/lib/utils";

interface PriceTextProps {
  value: string;
  className?: string;
}

export function PriceText({ value, className }: PriceTextProps) {
  const isMissing = value === "—";
  return (
    <span className={cn(isMissing && "text-muted-foreground", className)}>
      {value}
    </span>
  );
}
