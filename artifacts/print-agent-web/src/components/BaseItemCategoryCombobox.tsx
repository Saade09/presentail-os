import { useState, useMemo } from "react";
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
import { ChevronDown, Check } from "lucide-react";

type SubCategory = {
  id: number;
  name: string;
  parent_id: number;
  status?: string;
};

type MainCategory = {
  id: number;
  name: string;
  parent_id: null;
  status?: string;
  subcategories: SubCategory[];
};

interface BaseItemCategoryComboboxProps {
  value: string;
  onChange: (id: string) => void;
  categories: MainCategory[];
  isLoading?: boolean;
}

type SelectableItem = {
  id: number;
  label: string;
  parentLabel: string | null;
};

export function BaseItemCategoryCombobox({
  value,
  onChange,
  categories,
  isLoading = false,
}: BaseItemCategoryComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectableItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = [];
    for (const main of categories) {
      if (main.subcategories.length === 0) {
        items.push({ id: main.id, label: main.name, parentLabel: null });
      } else {
        for (const sub of main.subcategories) {
          items.push({ id: sub.id, label: sub.name, parentLabel: main.name });
        }
      }
    }
    return items;
  }, [categories]);

  const selectedItem = useMemo(
    () => (value ? selectableItems.find((i) => String(i.id) === value) ?? null : null),
    [value, selectableItems],
  );

  const triggerLabel = selectedItem
    ? selectedItem.parentLabel
      ? `${selectedItem.parentLabel} › ${selectedItem.label}`
      : selectedItem.label
    : null;

  const lowerSearch = search.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!lowerSearch) return categories;

    return categories
      .map((main) => {
        const parentMatches = main.name.toLowerCase().includes(lowerSearch);

        if (main.subcategories.length === 0) {
          if (parentMatches) return main;
          return null;
        }

        const matchingSubs = main.subcategories.filter((sub) =>
          sub.name.toLowerCase().includes(lowerSearch) || parentMatches,
        );

        if (matchingSubs.length === 0) return null;

        return { ...main, subcategories: matchingSubs };
      })
      .filter((m): m is MainCategory => m !== null);
  }, [categories, lowerSearch]);

  const hasResults = filteredGroups.length > 0;

  function select(id: number) {
    onChange(String(id));
    setSearch("");
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid="base-item-category-combobox-trigger"
        >
          <span className={triggerLabel ? "" : "text-muted-foreground"}>
            {isLoading
              ? "Loading categories…"
              : triggerLabel ?? "Select category…"}
          </span>
          <ChevronDown size={14} className="opacity-50 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search categories…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-56">
            {isLoading ? (
              <CommandEmpty>Loading categories…</CommandEmpty>
            ) : !hasResults && search.trim() ? (
              <CommandEmpty>No matching categories.</CommandEmpty>
            ) : !hasResults ? (
              <CommandEmpty>
                <span className="block text-muted-foreground text-xs py-1">
                  No categories found.{" "}
                  <a
                    href="/dashboard/base-item-categories"
                    target="_blank"
                    rel="noreferrer"
                    className="underline text-primary"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Manage categories
                  </a>
                </span>
              </CommandEmpty>
            ) : (
              filteredGroups.map((main) => {
                if (main.subcategories.length === 0) {
                  return (
                    <CommandGroup key={main.id}>
                      <CommandItem
                        value={String(main.id)}
                        onSelect={() => select(main.id)}
                        className="gap-2"
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${String(main.id) === value ? "opacity-100" : "opacity-0"}`}
                        />
                        <span className="font-medium">{main.name}</span>
                      </CommandItem>
                    </CommandGroup>
                  );
                }

                return (
                  <CommandGroup key={main.id} heading={main.name}>
                    {main.subcategories.map((sub) => (
                      <CommandItem
                        key={sub.id}
                        value={String(sub.id)}
                        onSelect={() => select(sub.id)}
                        className="gap-2 pl-5"
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${String(sub.id) === value ? "opacity-100" : "opacity-0"}`}
                        />
                        {sub.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
