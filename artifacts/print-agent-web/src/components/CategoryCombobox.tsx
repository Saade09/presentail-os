import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ChevronDown, Check, PlusCircle } from "lucide-react";

interface CategoryComboboxProps {
  brandName?: string;
  lockedBrand?: string;
  value: string;
  onChange: (v: string) => void;
}

export function CategoryCombobox({
  brandName,
  lockedBrand,
  value,
  onChange,
}: CategoryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");

  const effectiveBrand = lockedBrand ?? brandName ?? "";

  const { data } = useQuery({
    queryKey: ["product-categories", effectiveBrand],
    queryFn: () =>
      apiFetch<{ categories: string[] }>(
        `/api/products/categories${effectiveBrand ? `?brand=${encodeURIComponent(effectiveBrand)}` : ""}`,
      ),
    enabled: !!effectiveBrand,
  });

  const categories = data?.categories ?? [];

  const trimmed = inputValue.trim();
  const lowerTrimmed = trimmed.toLowerCase();
  const exactMatch = categories.some((c) => c.toLowerCase() === lowerTrimmed);
  const showCreate = trimmed.length > 0 && !exactMatch;

  const filtered = categories.filter((c) =>
    c.toLowerCase().includes(lowerTrimmed),
  );

  function select(cat: string) {
    onChange(cat);
    setInputValue("");
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={value ? "" : "text-muted-foreground"}>
            {value || "Select or create category…"}
          </span>
          <ChevronDown size={14} className="opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search or create…"
            value={inputValue}
            onValueChange={setInputValue}
          />
          <CommandList>
            {showCreate && (
              <CommandGroup>
                <CommandItem
                  value={`__create__:${trimmed}`}
                  onSelect={() => select(trimmed)}
                  className="gap-2"
                >
                  <PlusCircle size={14} className="shrink-0 text-primary" />
                  Create &ldquo;{trimmed}&rdquo;
                </CommandItem>
              </CommandGroup>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading={showCreate ? "Existing" : undefined}>
                {filtered.map((cat) => (
                  <CommandItem key={cat} value={cat} onSelect={() => select(cat)} className="gap-2">
                    <Check
                      size={14}
                      className={`shrink-0 ${value === cat ? "opacity-100" : "opacity-0"}`}
                    />
                    {cat}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {!showCreate && filtered.length === 0 && !effectiveBrand && !lockedBrand && (
              <CommandEmpty className="text-xs text-muted-foreground py-4 text-center">
                Select a brand first
              </CommandEmpty>
            )}
            {!showCreate && filtered.length === 0 && effectiveBrand && (
              <CommandEmpty className="text-xs text-muted-foreground py-4 text-center">
                No categories yet — type to create one
              </CommandEmpty>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
