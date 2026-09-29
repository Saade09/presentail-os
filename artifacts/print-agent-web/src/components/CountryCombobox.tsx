import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  COUNTRY_CATALOGUE,
  EXCLUDED_COUNTRY_NAMES,
  getCountryMetadataByCode,
  type CountryEntry,
} from "@/lib/countries";
import { cn } from "@/lib/utils";

const DEFAULT_COUNTRY_OPTIONS: readonly CountryEntry[] = COUNTRY_CATALOGUE.filter(
  (c) => !EXCLUDED_COUNTRY_NAMES.includes(c.name),
);

interface CountryComboboxProps {
  value: string;
  onChange: (code: string) => void;
  countries?: readonly CountryEntry[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Searchable country combobox that works with ISO alpha-2 codes as values.
 * Displays flag emoji + country name. Uses COUNTRY_CATALOGUE by default.
 */
export function CountryCombobox({
  value,
  onChange,
  countries = DEFAULT_COUNTRY_OPTIONS,
  disabled = false,
  placeholder = "Select country…",
  className,
}: CountryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const lowerValue = value.toLowerCase();

  const filtered = countries.filter(
    (c) =>
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.code.toLowerCase().includes(search.toLowerCase()),
  );

  const selected = countries.find((c) => c.code.toLowerCase() === lowerValue);
  const meta = selected ? getCountryMetadataByCode(selected.code) : null;

  if (disabled) {
    return (
      <div
        className={cn(
          "flex h-9 items-center px-3 rounded-md border border-input bg-muted text-sm",
          className,
        )}
      >
        {meta ? `${meta.flagEmoji} ${meta.name}` : value || "—"}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal h-9 px-3", className)}
          type="button"
        >
          <span className={value ? "text-foreground" : "text-muted-foreground"}>
            {meta ? `${meta.flagEmoji} ${meta.name}` : value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search countries…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value=""
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-muted-foreground"
                >
                  — Clear selection —
                </CommandItem>
              )}
              {filtered.map((c) => {
                const m = getCountryMetadataByCode(c.code);
                return (
                  <CommandItem
                    key={c.code}
                    value={c.code}
                    onSelect={() => {
                      onChange(c.code);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        lowerValue === c.code.toLowerCase() ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {m ? `${m.flagEmoji} ${c.name}` : c.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
