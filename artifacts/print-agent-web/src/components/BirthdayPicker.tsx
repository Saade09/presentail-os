import { useState } from "react";
import { CalendarIcon, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

interface BirthdayPickerProps {
  value: string;
  onChange: (value: string) => void;
  "data-testid"?: string;
}

function parseLocalDate(dateStr: string): Date | undefined {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return undefined;
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, (m as number) - 1, d as number);
  if (isNaN(date.getTime())) return undefined;
  return date;
}

function toYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDisplay(dateStr: string): string {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function BirthdayPicker({
  value,
  onChange,
  "data-testid": testId,
}: BirthdayPickerProps) {
  const [open, setOpen] = useState(false);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const selected = parseLocalDate(value);
  const defaultMonth = selected ?? today;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          data-testid={testId}
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          {value ? (
            formatDisplay(value)
          ) : (
            <span>dd/mm/yyyy</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex items-center justify-end px-3 pt-2 pb-1 border-b">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground gap-1"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            data-testid="birthday-clear"
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        </div>
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (date) {
              onChange(toYMD(date));
              setOpen(false);
            }
          }}
          defaultMonth={defaultMonth}
          captionLayout="dropdown"
          disabled={(date) => date > today}
          fromYear={1900}
          toYear={today.getFullYear()}
        />
      </PopoverContent>
    </Popover>
  );
}
