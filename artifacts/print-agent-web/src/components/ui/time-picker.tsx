import { Clock, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

interface TimePickerProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  "data-testid"?: string;
}

const HOURS = Array.from({ length: 24 }, (_, i) =>
  String(i).padStart(2, "0"),
);

const MINUTES = Array.from({ length: 12 }, (_, i) =>
  String(i * 5).padStart(2, "0"),
);

function parse(value: string): { hh: string; mm: string } {
  if (!value || !value.includes(":")) return { hh: "", mm: "" };
  const [h, m] = value.split(":");
  const hh = HOURS.includes(h) ? h : "";
  const rawMm = m?.slice(0, 2) ?? "";
  const nearestMm = MINUTES.reduce((best, candidate) =>
    Math.abs(parseInt(candidate) - parseInt(rawMm || "0")) <
    Math.abs(parseInt(best) - parseInt(rawMm || "0"))
      ? candidate
      : best,
  );
  const mm = rawMm !== "" ? nearestMm : "";
  return { hh, mm };
}

export function TimePicker({ value, onChange, id, "data-testid": testId }: TimePickerProps) {
  const { hh, mm } = parse(value);
  const hasValue = hh !== "" || mm !== "";

  function handleHour(h: string) {
    const resolvedMm = mm || "00";
    onChange(`${h}:${resolvedMm}`);
  }

  function handleMinute(m: string) {
    const resolvedHh = hh || "00";
    onChange(`${resolvedHh}:${m}`);
  }

  function handleClear() {
    onChange("");
  }

  return (
    <div
      className="flex items-center gap-1.5 min-w-0"
      id={id}
      data-testid={testId}
      aria-label="Time picker"
    >
      <Clock size={15} className="text-muted-foreground shrink-0" />

      <Select value={hh} onValueChange={handleHour}>
        <SelectTrigger
          className="w-[60px]"
          aria-label="Hour"
          data-testid={testId ? `${testId}-hour` : undefined}
        >
          <SelectValue placeholder="HH" />
        </SelectTrigger>
        <SelectContent className="max-h-56">
          {HOURS.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-muted-foreground font-semibold select-none">:</span>

      <Select value={mm} onValueChange={handleMinute}>
        <SelectTrigger
          className="w-[60px]"
          aria-label="Minute"
          data-testid={testId ? `${testId}-minute` : undefined}
        >
          <SelectValue placeholder="MM" />
        </SelectTrigger>
        <SelectContent>
          {MINUTES.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasValue && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={handleClear}
          aria-label="Clear cutoff time"
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <X size={13} />
        </Button>
      )}
    </div>
  );
}
