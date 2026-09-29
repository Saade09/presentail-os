import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListContacts,
  useGetContactsSummary,
  useAddContactTag,
  useRemoveContactTag,
  getListContactsQueryKey,
  type ContactListItem,
  type ContactsKpi,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Gift,
  Phone,
  Plus,
  Repeat,
  Search,
  SlidersHorizontal,
  UserRound,
  Users,
  X,
} from "lucide-react";

const RESERVED_TAGS = ["customer", "recipient"];

/** Badge colors for well-known tags (mockup palette); anything else is neutral. */
const TAG_BADGE_CLASSES: Record<string, string> = {
  vip: "bg-violet-100 text-violet-800 hover:bg-violet-100",
  corporate: "bg-teal-100 text-teal-800 hover:bg-teal-100",
  regular: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  "one-time": "bg-amber-100 text-amber-800 hover:bg-amber-100",
  whatsapp: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
};

function tagBadgeClass(tag: string): string {
  return TAG_BADGE_CLASSES[tag.toLowerCase()] ?? "bg-muted text-foreground hover:bg-muted";
}

const AUTO_TAG_LABEL_KEYS: Record<string, string> = {
  vip: "customers.tagVip",
  corporate: "customers.tagCorporate",
  regular: "customers.tagRegular",
  "one-time": "customers.tagOneTime",
};

type TypeFilter = "all" | "customer" | "recipient" | "both" | "vip" | "duplicates";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function formatMoney(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fullName(c: ContactListItem, fallback: string): string {
  const display = (c.display_name ?? "").trim();
  if (display) return display;
  const n = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return n || fallback;
}

/**
 * Numbered pagination model: always show the first and last page, a window
 * around the current page, and "…" gaps (mockup style: 1 2 3 … 308).
 */
function pageNumbers(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

const LIST_STATE_KEY = "contacts.listState";

type SavedListState = {
  searchInput: string;
  sort: string;
  type: TypeFilter;
  countryFilter: string;
  tagFilter: string;
  page: number;
  scrollY: number;
};

function loadListState(): Partial<SavedListState> {
  try {
    const raw = sessionStorage.getItem(LIST_STATE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<SavedListState>;
  } catch {
    return {};
  }
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function KpiCard({
  label,
  kpi,
  icon,
  iconClass,
  testId,
}: {
  label: string;
  kpi: ContactsKpi | undefined;
  icon: React.ReactNode;
  iconClass: string;
  testId: string;
}) {
  const { t } = useTranslation();
  const delta = kpi?.delta_pct ?? null;
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold mt-1">
            {kpi ? kpi.count.toLocaleString() : "—"}
          </p>
        </div>
        <div className={`rounded-full p-2.5 ${iconClass}`}>{icon}</div>
      </div>
      {delta != null && (
        <p
          className={`mt-2 text-xs flex items-center gap-1 ${delta >= 0 ? "text-emerald-600" : "text-red-600"}`}
        >
          {delta >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {Math.abs(delta)}% {t("customers.vsLastMonth")}
        </p>
      )}
    </div>
  );
}

export default function CustomersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [saved] = useState(loadListState);
  const [searchInput, setSearchInput] = useState(saved.searchInput ?? "");
  const search = useDebounced(searchInput, 300);
  const [sort, setSort] = useState(saved.sort ?? "created_at:desc");
  const [type, setType] = useState<TypeFilter>(saved.type ?? "all");
  const [countryFilter, setCountryFilter] = useState(saved.countryFilter ?? "all");
  const [tagFilter, setTagFilter] = useState(saved.tagFilter ?? "all");
  const [page, setPage] = useState(saved.page ?? 1);
  const limit = 50;

  useEffect(() => {
    try {
      sessionStorage.setItem(
        LIST_STATE_KEY,
        JSON.stringify({
          searchInput,
          sort,
          type,
          countryFilter,
          tagFilter,
          page,
          scrollY: window.scrollY,
        } satisfies SavedListState),
      );
    } catch {
      // ignore storage failures
    }
  }, [searchInput, sort, type, countryFilter, tagFilter, page]);

  useEffect(() => {
    if (saved.scrollY && saved.scrollY > 0) {
      window.scrollTo(0, saved.scrollY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [sortKey, sortDir] = sort.split(":");

  const params = useMemo(
    () => ({
      page,
      limit,
      sort: sortKey as "created_at" | "last_order_at" | "orders_placed" | "name" | "total_spent_usd",
      dir: sortDir as "asc" | "desc",
      ...(search ? { search } : {}),
      ...(type !== "all" ? { type } : {}),
      ...(countryFilter !== "all" ? { country: countryFilter } : {}),
      ...(tagFilter !== "all" ? { tag: tagFilter } : {}),
    }),
    [page, limit, sortKey, sortDir, search, type, countryFilter, tagFilter],
  );

  const { data, isLoading } = useListContacts(params);
  const { data: summary } = useGetContactsSummary();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });

  const addTag = useAddContactTag({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.tagAdded") });
        void invalidate();
      },
      onError: () => toast({ title: t("customers.tagError"), variant: "destructive" }),
    },
  });

  const removeTag = useRemoveContactTag({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.tagRemoved") });
        void invalidate();
      },
      onError: () => toast({ title: t("customers.tagError"), variant: "destructive" }),
    },
  });

  const contacts = data?.contacts ?? [];
  const availableTags = data?.available_tags ?? [];
  const availableCountries = data?.available_countries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const rangeStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const rangeEnd = Math.min(page * limit, total);

  const sortOptions = [
    { value: "created_at:desc", label: t("customers.sortNewest") },
    { value: "created_at:asc", label: t("customers.sortOldest") },
    { value: "name:asc", label: t("customers.sortNameAsc") },
    { value: "name:desc", label: t("customers.sortNameDesc") },
    { value: "last_order_at:desc", label: t("customers.sortRecentOrder") },
    { value: "orders_placed:desc", label: t("customers.sortMostOrders") },
    { value: "total_spent_usd:desc", label: t("customers.sortTotalSpent") },
  ];

  const tabs: { key: TypeFilter; label: string }[] = [
    { key: "all", label: t("customers.tabAll") },
    { key: "customer", label: t("customers.tabCustomers") },
    { key: "recipient", label: t("customers.tabRecipients") },
    { key: "duplicates", label: t("customers.tabDuplicates") },
  ];
  const activeTab: TypeFilter = type === "both" ? "all" : type;

  const typeDropdownValue = ["customer", "recipient", "both"].includes(type) ? type : "all";

  const activeFilterCount =
    (search ? 1 : 0) +
    (type !== "all" ? 1 : 0) +
    (countryFilter !== "all" ? 1 : 0) +
    (tagFilter !== "all" ? 1 : 0);

  const clearFilters = () => {
    setSearchInput("");
    setType("all");
    setCountryFilter("all");
    setTagFilter("all");
    setSort("created_at:desc");
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("customers.title")}</h1>
        <p className="text-muted-foreground mt-1">{t("customers.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={t("customers.kpiTotalContacts")}
          kpi={summary?.total_contacts}
          icon={<Users size={18} className="text-teal-600" />}
          iconClass="bg-teal-50"
          testId="kpi-total-contacts"
        />
        <KpiCard
          label={t("customers.kpiCustomers")}
          kpi={summary?.customers}
          icon={<UserRound size={18} className="text-blue-600" />}
          iconClass="bg-blue-50"
          testId="kpi-customers"
        />
        <KpiCard
          label={t("customers.kpiRecipients")}
          kpi={summary?.recipients}
          icon={<Gift size={18} className="text-purple-600" />}
          iconClass="bg-purple-50"
          testId="kpi-recipients"
        />
        <KpiCard
          label={t("customers.kpiRepeatCustomers")}
          kpi={summary?.repeat_customers}
          icon={<Repeat size={18} className="text-amber-600" />}
          iconClass="bg-amber-50"
          testId="kpi-repeat-customers"
        />
      </div>

      <div className="border-b">
        <nav className="flex gap-6 -mb-px overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-testid={`tab-contacts-${tab.key}`}
              onClick={() => {
                setType(tab.key);
                setPage(1);
              }}
              className={`whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
          <Link
            href="/audiences?prefill=vip"
            className="whitespace-nowrap border-b-2 border-transparent px-1 pb-3 text-sm font-medium text-muted-foreground hover:text-foreground"
            data-testid="link-vip-audience"
          >
            {t("customers.tabVip")} →
          </Link>
        </nav>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative max-w-xs w-full">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="input-customers-search"
            placeholder={t("customers.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            className="ps-8"
          />
        </div>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-52" data-testid="select-customers-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={typeDropdownValue}
          onValueChange={(v) => {
            setType(v as TypeFilter);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" data-testid="select-customers-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("customers.typeAll")}</SelectItem>
            <SelectItem value="customer">{t("customers.roleCustomer")}</SelectItem>
            <SelectItem value="recipient">{t("customers.roleRecipient")}</SelectItem>
            <SelectItem value="both">{t("customers.roleBoth")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={countryFilter}
          onValueChange={(v) => {
            setCountryFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44" data-testid="select-customers-country">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("customers.countryAll")}</SelectItem>
            {availableCountries.map((cn) => (
              <SelectItem key={cn} value={cn}>{cn}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={tagFilter}
          onValueChange={(v) => {
            setTagFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40" data-testid="select-customers-tag">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("customers.tagAll")}</SelectItem>
            {availableTags.map((tg) => (
              <SelectItem key={tg} value={tg}>{tg}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          className="h-9 ms-auto"
          data-testid="button-customers-filters"
          onClick={clearFilters}
          disabled={activeFilterCount === 0}
        >
          <SlidersHorizontal size={14} className="me-1.5" />
          {t("customers.filters")}
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ms-1.5 h-5 px-1.5 text-xs">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p>{t("customers.empty")}</p>
        </div>
      ) : (
        <>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("customers.colName")}</TableHead>
                  <TableHead>{t("customers.colContact")}</TableHead>
                  <TableHead>{t("customers.colType")}</TableHead>
                  <TableHead>{t("customers.colCountry")}</TableHead>
                  <TableHead className="text-right">{t("customers.colOrders")}</TableHead>
                  <TableHead className="text-right">{t("customers.colTotalSpent")}</TableHead>
                  <TableHead>{t("customers.colLastOrder")}</TableHead>
                  <TableHead>{t("customers.colTags")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c) => {
                  const hasOrders = c.orders_placed > 0;
                  return (
                    <TableRow key={c.id} data-testid={`row-contact-${c.id}`}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/contacts/${c.id}`}
                          className="hover:underline"
                          data-testid={`link-contact-${c.id}`}
                        >
                          {fullName(c, t("customers.unnamed"))}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="flex items-center gap-1.5">
                          {c.phone ? (
                            <>
                              <Phone size={13} className="text-emerald-600 shrink-0" />
                              <span dir="ltr">{c.phone}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                        <div className="text-muted-foreground">{c.email ?? ""}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {c.is_customer && (
                            <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100 text-xs">
                              {t("customers.badgeCustomer")}
                            </Badge>
                          )}
                          {c.is_recipient && (
                            <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100 text-xs">
                              {t("customers.badgeRecipient")}
                            </Badge>
                          )}
                          {c.is_vip && (
                            <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100 text-xs">
                              {t("customers.badgeVip")}
                            </Badge>
                          )}
                          {c.is_repeat && (
                            <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 text-xs">
                              {t("customers.badgeRepeat")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.country ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-sm text-right">
                        {hasOrders ? c.orders_placed : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-sm text-right">
                        {hasOrders && c.is_customer ? (
                          formatMoney(c.total_spent_usd)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{formatDate(c.last_order_at)}</TableCell>
                      <TableCell>
                        <ContactTags contact={c} addTag={addTag} removeTag={removeTag} />
                      </TableCell>
                      <TableCell className="text-sm">
                        <Link
                          href={`/contacts/${c.id}`}
                          className="text-primary hover:underline whitespace-nowrap inline-flex items-center gap-1"
                          data-testid={`link-open-contact-${c.id}`}
                        >
                          {t("customers.openContact")}
                          <ArrowRight size={13} className="rtl:rotate-180" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {t("customers.showingRange", { start: rangeStart, end: rangeEnd, total })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPage((p) => p - 1)}
                disabled={page <= 1}
                data-testid="button-page-prev"
              >
                <ChevronLeft size={14} className="rtl:rotate-180" />
              </Button>
              {pageNumbers(page, totalPages).map((p, i) =>
                p === "…" ? (
                  <span key={`gap-${i}`} className="px-1.5 text-muted-foreground">
                    …
                  </span>
                ) : (
                  <Button
                    key={p}
                    size="sm"
                    variant={p === page ? "default" : "outline"}
                    className="h-8 min-w-8 px-2"
                    onClick={() => setPage(p)}
                    data-testid={`button-page-${p}`}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages}
                data-testid="button-page-next"
              >
                <ChevronRight size={14} className="rtl:rotate-180" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ContactTags({
  contact,
  addTag,
  removeTag,
}: {
  contact: ContactListItem;
  addTag: ReturnType<typeof useAddContactTag>;
  removeTag: ReturnType<typeof useRemoveContactTag>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");

  const submit = () => {
    const tag = value.trim();
    if (!tag) return;
    if (RESERVED_TAGS.includes(tag.toLowerCase())) {
      toast({ title: t("customers.tagReserved", { tag }), variant: "destructive" });
      return;
    }
    addTag.mutate(
      { id: contact.id, data: { tag } },
      {
        onSuccess: () => {
          setValue("");
          setOpen(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {contact.tags.length === 0 && (
        <span className="text-muted-foreground text-xs">{t("customers.noTags")}</span>
      )}
      {contact.tags.map((tag) => (
        <Badge key={tag} className={`text-xs gap-1 pr-1 border-transparent ${tagBadgeClass(tag)}`}>
          {AUTO_TAG_LABEL_KEYS[tag.toLowerCase()]
            ? t(AUTO_TAG_LABEL_KEYS[tag.toLowerCase()])
            : tag}
          <button
            type="button"
            aria-label={t("customers.removeTag")}
            className="rounded-sm hover:bg-muted-foreground/20"
            data-testid={`button-remove-tag-${contact.id}-${tag}`}
            onClick={() => removeTag.mutate({ id: contact.id, tag })}
          >
            <X size={12} />
          </button>
        </Badge>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            data-testid={`button-add-tag-${contact.id}`}
          >
            <Plus size={12} className="mr-0.5" />
            {t("customers.addTag")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <div className="flex gap-2">
            <Input
              autoFocus
              value={value}
              placeholder={t("customers.addTagPlaceholder")}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              className="h-8 text-sm"
              data-testid={`input-add-tag-${contact.id}`}
            />
            <Button size="sm" className="h-8" onClick={submit} disabled={addTag.isPending}>
              {t("customers.add")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
