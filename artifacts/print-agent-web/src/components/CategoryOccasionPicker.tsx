import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ChevronDown, Check, PlusCircle, X } from "lucide-react";

export type CategoryOptionKind = "catalog_category" | "occasion";

export type SelectedCategoryOption = {
  kind: CategoryOptionKind;
  id: number;
  name: string;
  slug?: string;
};

type FetchedOption = {
  kind: CategoryOptionKind;
  id: number;
  name: string;
  slug: string;
};

interface CategoryOccasionPickerProps {
  value: SelectedCategoryOption[];
  onChange: (next: SelectedCategoryOption[]) => void;
}

const KIND_LABEL: Record<CategoryOptionKind, string> = {
  catalog_category: "Category",
  occasion: "Occasion",
};

function optionKey(kind: CategoryOptionKind, id: number): string {
  return `${kind}:${id}`;
}

/**
 * Combined multi-select picker spanning Catalog Categories + Occasions. Selected
 * items are shown as removable chips. Typing a value with no match offers a
 * "Create" action that creates a new Catalog Category (the default kind) and
 * adds it to the selection.
 */
export function CategoryOccasionPicker({ value, onChange }: CategoryOccasionPickerProps) {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const trimmed = inputValue.trim();

  const { data } = useQuery({
    queryKey: ["product-category-options", trimmed],
    queryFn: () =>
      apiFetch<{ options: FetchedOption[] }>(
        `/api/products/category-options${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ""}`,
      ),
  });

  const options = data?.options ?? [];

  const selectedKeys = new Set(value.map((v) => optionKey(v.kind, v.id)));
  const lowerTrimmed = trimmed.toLowerCase();
  const exactMatch = options.some((o) => o.name.toLowerCase() === lowerTrimmed);
  const showCreate = trimmed.length > 0 && !exactMatch && !creating;

  function toggle(opt: FetchedOption) {
    const key = optionKey(opt.kind, opt.id);
    if (selectedKeys.has(key)) {
      onChange(value.filter((v) => optionKey(v.kind, v.id) !== key));
    } else {
      onChange([...value, { kind: opt.kind, id: opt.id, name: opt.name, slug: opt.slug }]);
    }
  }

  function remove(item: SelectedCategoryOption) {
    onChange(value.filter((v) => optionKey(v.kind, v.id) !== optionKey(item.kind, item.id)));
  }

  async function createCategory() {
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const res = await apiFetch<{ item: { id: number; name: string; slug: string } }>(
        "/api/catalog_categories",
        { method: "POST", body: JSON.stringify({ name: trimmed }) },
      );
      onChange([
        ...value,
        { kind: "catalog_category", id: res.item.id, name: res.item.name, slug: res.item.slug },
      ]);
      setInputValue("");
      await qc.invalidateQueries({ queryKey: ["product-category-options"] });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Couldn't create category",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            <span className={value.length ? "" : "text-muted-foreground"}>
              {value.length
                ? `${value.length} selected`
                : "Select categories & occasions…"}
            </span>
            <ChevronDown size={14} className="opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
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
                    onSelect={createCategory}
                    className="gap-2"
                  >
                    <PlusCircle size={14} className="shrink-0 text-primary" />
                    Create category &ldquo;{trimmed}&rdquo;
                  </CommandItem>
                </CommandGroup>
              )}
              {options.length > 0 && (
                <CommandGroup heading={showCreate ? "Existing" : undefined}>
                  {options.map((opt) => {
                    const key = optionKey(opt.kind, opt.id);
                    const checked = selectedKeys.has(key);
                    return (
                      <CommandItem
                        key={key}
                        value={key}
                        onSelect={() => toggle(opt)}
                        className="gap-2"
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${checked ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="flex-1 truncate">{opt.name}</span>
                        <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
                          {KIND_LABEL[opt.kind]}
                        </Badge>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
              {!showCreate && options.length === 0 && (
                <CommandEmpty className="text-xs text-muted-foreground py-4 text-center">
                  No categories or occasions — type to create one
                </CommandEmpty>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <Badge
              key={optionKey(item.kind, item.id)}
              variant="secondary"
              className="gap-1 font-normal"
            >
              <span className="opacity-60 text-[10px]">{KIND_LABEL[item.kind]}:</span>
              {item.name}
              <button
                type="button"
                onClick={() => remove(item)}
                className="ml-0.5 rounded-sm hover:bg-muted-foreground/20"
                aria-label={`Remove ${item.name}`}
              >
                <X size={12} />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
