import { useState, useRef, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface AliasChipInputProps {
  aliases: string[];
  onChange: (aliases: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function AliasChipInput({
  aliases,
  onChange,
  placeholder = "Add another alias",
  disabled = false,
}: AliasChipInputProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function addAlias(text: string) {
    const trimmed = text.trim();
    if (!trimmed || aliases.includes(trimmed)) {
      setInput("");
      return;
    }
    onChange([...aliases, trimmed]);
    setInput("");
  }

  function removeAlias(index: number) {
    onChange(aliases.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addAlias(input);
    } else if (e.key === ",") {
      e.preventDefault();
      // Allow comma-separated additions
      const parts = input.split(",");
      parts.forEach((p) => addAlias(p));
    } else if (e.key === "Backspace" && !input && aliases.length > 0) {
      removeAlias(aliases.length - 1);
    }
  }

  function handleBlur() {
    if (input.trim()) addAlias(input);
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 rounded-md border border-input bg-background px-3 py-2 min-h-[38px] cursor-text focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
      onClick={() => !disabled && inputRef.current?.focus()}
      role="group"
      aria-label="Aliases"
    >
      {aliases.map((alias, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full bg-secondary text-secondary-foreground px-2.5 py-0.5 text-sm font-normal"
        >
          {alias}
          {!disabled && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeAlias(i);
              }}
              className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label={`Remove alias ${alias}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={aliases.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[160px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          aria-label="Type an alias and press Enter or comma to add"
        />
      )}
    </div>
  );
}
