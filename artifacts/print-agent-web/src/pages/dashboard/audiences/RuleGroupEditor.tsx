import type {
  AudienceFieldDef,
  AudienceRuleCondition,
  AudienceRuleGroup,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, X } from "lucide-react";
import {
  CURRENCY_FIELDS,
  LIST_OPERATORS,
  RANGE_OPERATORS,
  RELATIVE_DAY_OPERATORS,
  VALUELESS_OPERATORS,
  defaultValueFor,
  newCondition,
  operatorLabel,
  type GroupPath,
} from "./ruleUtils";

const FIELD_GROUP_LABELS: Record<string, string> = {
  contact: "Contact",
  purchasing: "Purchasing",
  gifting: "Gifting",
  occasions: "Occasions",
  channels: "Channels & consent",
  data_quality: "Data quality",
};

type GroupOps = {
  onLogicChange: (path: GroupPath, logic: "ALL" | "ANY") => void;
  onAddCondition: (path: GroupPath) => void;
  onRemoveCondition: (path: GroupPath, index: number) => void;
  onDuplicateCondition: (path: GroupPath, index: number) => void;
  onMoveCondition: (path: GroupPath, index: number, dir: -1 | 1) => void;
  onConditionChange: (path: GroupPath, index: number, c: AudienceRuleCondition) => void;
  onAddGroup: (path: GroupPath) => void;
  onRemoveGroup: (path: GroupPath, index: number) => void;
};

function ListValueInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: unknown;
  onChange: (v: string[]) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const items = Array.isArray(value) ? value.map(String) : [];
  return (
    <div className="flex flex-wrap items-center gap-1 min-w-[10rem]">
      {items.map((item, i) => (
        <Badge key={`${item}-${i}`} variant="secondary" className="gap-1">
          {item}
          <button
            type="button"
            aria-label={`Remove ${item}`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <X size={10} />
          </button>
        </Badge>
      ))}
      <Input
        aria-label={ariaLabel}
        placeholder={placeholder}
        className="h-8 w-32 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v && !items.includes(v)) onChange([...items, v]);
            (e.target as HTMLInputElement).value = "";
          }
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && !items.includes(v)) onChange([...items, v]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ValueControl({
  def,
  condition,
  onChange,
}: {
  def: AudienceFieldDef;
  condition: AudienceRuleCondition;
  onChange: (c: AudienceRuleCondition) => void;
}) {
  const op = condition.operator;
  if (VALUELESS_OPERATORS.has(op)) return null;
  const set = (value: unknown) => onChange({ ...condition, value });
  const ariaLabel = `Value for ${def.label}`;

  if (RELATIVE_DAY_OPERATORS.has(op)) {
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={1}
          aria-label={`Days for ${def.label}`}
          className="h-8 w-20 text-xs"
          value={condition.value == null ? "" : String(condition.value)}
          onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))}
        />
        <span className="text-xs text-muted-foreground">days</span>
      </div>
    );
  }

  if (RANGE_OPERATORS.has(op)) {
    const v = Array.isArray(condition.value) ? condition.value : ["", ""];
    const inputType = def.type === "date" ? "date" : "number";
    const parse = (raw: string) =>
      def.type === "date" ? raw : raw === "" ? "" : Number(raw);
    return (
      <div className="flex items-center gap-1.5">
        <Input
          type={inputType}
          aria-label={`${def.label} from`}
          className="h-8 w-32 text-xs"
          value={v[0] == null ? "" : String(v[0])}
          onChange={(e) => set([parse(e.target.value), v[1]])}
        />
        <span className="text-xs text-muted-foreground">and</span>
        <Input
          type={inputType}
          aria-label={`${def.label} to`}
          className="h-8 w-32 text-xs"
          value={v[1] == null ? "" : String(v[1])}
          onChange={(e) => set([v[0], parse(e.target.value)])}
        />
      </div>
    );
  }

  if (LIST_OPERATORS.has(op)) {
    if (def.type === "enum" && def.enumValues?.length) {
      const items = Array.isArray(condition.value) ? condition.value.map(String) : [];
      return (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
          {def.enumValues.map((ev) => {
            const on = items.includes(ev);
            return (
              <button
                key={ev}
                type="button"
                aria-pressed={on}
                onClick={() => set(on ? items.filter((x) => x !== ev) : [...items, ev])}
                className={cn(
                  "text-xs px-2 py-0.5 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border hover:bg-secondary",
                )}
              >
                {ev}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <ListValueInput
        value={condition.value}
        onChange={set}
        placeholder="Add value ↵"
        ariaLabel={ariaLabel}
      />
    );
  }

  if (def.type === "enum" && def.enumValues?.length) {
    return (
      <Select value={String(condition.value ?? "")} onValueChange={set}>
        <SelectTrigger className="h-8 w-40 text-xs" aria-label={ariaLabel}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {def.enumValues.map((ev) => (
            <SelectItem key={ev} value={ev}>
              {ev}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (def.type === "number") {
    const isCurrency = CURRENCY_FIELDS.has(def.key);
    return (
      <div className="flex items-center gap-1">
        {isCurrency && <span className="text-xs text-muted-foreground">$</span>}
        <Input
          type="number"
          aria-label={ariaLabel}
          className="h-8 w-28 text-xs"
          value={condition.value == null ? "" : String(condition.value)}
          onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))}
        />
      </div>
    );
  }

  if (def.type === "date") {
    return (
      <Input
        type="date"
        aria-label={ariaLabel}
        className="h-8 w-40 text-xs"
        value={String(condition.value ?? "")}
        onChange={(e) => set(e.target.value)}
      />
    );
  }

  // string / tags single-value
  return (
    <Input
      aria-label={ariaLabel}
      placeholder={def.key === "country" ? "e.g. Lebanon" : "Value"}
      className="h-8 w-40 text-xs"
      value={String(condition.value ?? "")}
      onChange={(e) => set(e.target.value)}
    />
  );
}

function ConditionRow({
  fields,
  condition,
  index,
  count,
  path,
  ops,
}: {
  fields: AudienceFieldDef[];
  condition: AudienceRuleCondition;
  index: number;
  count: number;
  path: GroupPath;
  ops: GroupOps;
}) {
  const def = fields.find((f) => f.key === condition.field);
  const grouped = new Map<string, AudienceFieldDef[]>();
  for (const f of fields) {
    const arr = grouped.get(f.group) ?? [];
    arr.push(f);
    grouped.set(f.group, arr);
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-2.5 py-2"
      data-testid={`rule-condition-${path.join("-") || "root"}-${index}`}
    >
      <Select
        value={condition.field || undefined}
        onValueChange={(key) => {
          const nextDef = fields.find((f) => f.key === key);
          if (nextDef) ops.onConditionChange(path, index, newCondition(nextDef));
        }}
      >
        <SelectTrigger className="h-8 w-52 text-xs" aria-label="Field">
          <SelectValue placeholder="Choose a field…" />
        </SelectTrigger>
        <SelectContent className="max-h-72 overflow-y-auto">
          {[...grouped.entries()].map(([groupKey, groupFields]) => (
            <SelectGroup key={groupKey}>
              <SelectLabel>{FIELD_GROUP_LABELS[groupKey] ?? groupKey}</SelectLabel>
              {groupFields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                  {f.inferred ? " (inferred)" : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {def && (
        <Select
          value={condition.operator}
          onValueChange={(op) =>
            ops.onConditionChange(path, index, {
              ...condition,
              operator: op,
              value: defaultValueFor(def, op),
            })
          }
        >
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Condition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.operators.map((op) => (
              <SelectItem key={op} value={op}>
                {operatorLabel(op)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {def && (
        <ValueControl
          def={def}
          condition={condition}
          onChange={(c) => ops.onConditionChange(path, index, c)}
        />
      )}
      <div className="ms-auto flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Move condition up"
          disabled={index === 0}
          onClick={() => ops.onMoveCondition(path, index, -1)}
        >
          <ArrowUp size={13} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Move condition down"
          disabled={index === count - 1}
          onClick={() => ops.onMoveCondition(path, index, 1)}
        >
          <ArrowDown size={13} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Duplicate condition"
          onClick={() => ops.onDuplicateCondition(path, index)}
        >
          <Copy size={13} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive"
          aria-label="Remove condition"
          onClick={() => ops.onRemoveCondition(path, index)}
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {def?.inferred && (
        <p className="w-full text-[11px] text-amber-600">
          Inferred field — values are estimated, not confirmed.
        </p>
      )}
    </div>
  );
}

export function RuleGroupEditor({
  group,
  fields,
  path = [],
  ops,
  parentPath,
  indexInParent,
  depth = 0,
}: {
  group: AudienceRuleGroup;
  fields: AudienceFieldDef[];
  path?: GroupPath;
  ops: GroupOps;
  parentPath?: GroupPath;
  indexInParent?: number;
  depth?: number;
}) {
  const logicLabel =
    group.logic === "ALL" ? "all of the following" : "any of the following";
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-3",
        depth > 0 ? "bg-muted/30" : "bg-background",
      )}
      role="group"
      aria-label={`Rule group matching ${logicLabel}`}
      data-testid={`rule-group-${path.join("-") || "root"}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Match</span>
        <Select
          value={group.logic}
          onValueChange={(v) => ops.onLogicChange(path, v as "ALL" | "ANY")}
        >
          <SelectTrigger className="h-7 w-32 text-xs" aria-label="Group match logic">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">ALL (and)</SelectItem>
            <SelectItem value="ANY">ANY (or)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">of the following</span>
        {parentPath != null && indexInParent != null && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ms-auto h-7 w-7 text-destructive"
            aria-label="Remove group"
            onClick={() => ops.onRemoveGroup(parentPath, indexInParent)}
          >
            <Trash2 size={13} />
          </Button>
        )}
      </div>
      {group.conditions.map((c, i) => (
        <ConditionRow
          key={i}
          fields={fields}
          condition={c}
          index={i}
          count={group.conditions.length}
          path={path}
          ops={ops}
        />
      ))}
      {(group.groups ?? []).map((child, i) => (
        <RuleGroupEditor
          key={i}
          group={child}
          fields={fields}
          path={[...path, i]}
          ops={ops}
          parentPath={path}
          indexInParent={i}
          depth={depth + 1}
        />
      ))}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => ops.onAddCondition(path)}
          data-testid={`button-add-condition-${path.join("-") || "root"}`}
        >
          <Plus size={12} className="me-1" /> Add condition
        </Button>
        {depth < 2 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => ops.onAddGroup(path)}
          >
            <Plus size={12} className="me-1" /> Add nested group
          </Button>
        )}
      </div>
    </div>
  );
}

export type { GroupOps };
