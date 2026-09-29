import { useEffect, useMemo, useState } from "react";
import {
  ORDER_STATUS_LABEL_KEYS,
  normalizeOrderStatus,
  orderStatusBadgeClass,
  type OrderStatus,
} from "../../lib/orderStatus";
import { Link, useRoute } from "wouter";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useAuth } from "@clerk/react";
import {
  useGetContact,
  useListContactOrders,
  useAddContactTag,
  useRemoveContactTag,
  useUpdateContact,
  useCreateContactNote,
  useUpdateContactNote,
  useDeleteContactNote,
  useListContactActivity,
  useListContactDuplicates,
  useMergeContact,
  useArchiveContact,
  useUnarchiveContact,
  useRespondIoSyncContact,
  useDeleteRespondIoSyncContact,
  useUpdateContactConsent,
  getGetContactQueryKey,
  getListContactsQueryKey,
  getListContactOrdersQueryKey,
  getListContactActivityQueryKey,
  getListContactDuplicatesQueryKey,
  type ContactOrderRow,
  type ContactDetail,
  type ContactActivityItem,
  type ContactDuplicate,
  type ContactConflictError,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { orderDetailPath } from "@/lib/orderLink";
import { CreateOrderWizard } from "@/components/CreateOrderWizard";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Gift,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Plus,
  ShoppingBag,
  Trash2,
  Users,
  Wallet,
  Clock,
  X,
} from "lucide-react";

const RESERVED_TAGS = ["customer", "recipient"];


type OrderTab = "all" | "placed" | "received";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function formatAmount(total: string | null, currency: string | null): string {
  if (!total) return "—";
  const curr = currency ?? "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: curr }).format(
      parseFloat(total),
    );
  } catch {
    return `${total} ${curr}`;
  }
}

function formatUsd(v: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(v);
}

function orderTotals(o: ContactOrderRow): { total: string | null; currency: string | null } {
  const t = o.totals as { total?: unknown; currency?: unknown } | null | undefined;
  return {
    total: t && t.total != null ? String(t.total) : null,
    currency: t && typeof t.currency === "string" ? t.currency : null,
  };
}

export function contactFullName(
  c: { display_name?: string | null; first_name?: string | null; last_name?: string | null },
  fallback: string,
): string {
  const display = (c.display_name ?? "").trim();
  if (display) return display;
  const n = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
  return n || fallback;
}

export function initialsFor(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function whatsappHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 7) return null;
  return `https://wa.me/${digits}`;
}

function MetricCard({
  label,
  value,
  icon,
  iconClass,
  testId,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  iconClass: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground truncate">{label}</p>
          <p className="text-xl font-bold mt-1 truncate">{value}</p>
        </div>
        <div className={`rounded-md p-2 shrink-0 ${iconClass}`}>{icon}</div>
      </div>
    </div>
  );
}

function RoleBadges({ contact }: { contact: ContactDetail }) {
  const { t } = useTranslation();
  return (
    <>
      {contact.is_customer && (
        <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 text-xs">
          {t("customers.badgeCustomer")}
        </Badge>
      )}
      {contact.is_recipient && (
        <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100 text-xs">
          {t("customers.badgeRecipient")}
        </Badge>
      )}
      {contact.is_vip && (
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 text-xs">
          {t("customers.badgeVip")}
        </Badge>
      )}
    </>
  );
}

function sourceLabel(source: string | null | undefined, t: (k: string) => string): string {
  if (!source) return t("customers.sourceUnknown");
  const key = source.toLowerCase();
  const map: Record<string, string> = {
    website: t("customers.sourceWebsite"),
    pos: t("customers.sourcePos"),
    manual: t("customers.sourceManual"),
    imported: t("customers.sourceImported"),
    api: t("customers.sourceApi"),
  };
  return map[key] ?? source;
}

function genderLabel(gender: string | undefined, t: (k: string) => string): string {
  switch (gender) {
    case "male":
      return t("customers.genderMale");
    case "female":
      return t("customers.genderFemale");
    default:
      return t("customers.genderUnknown");
  }
}

function activityLabel(item: ContactActivityItem, t: (k: string) => string): string {
  switch (item.type) {
    case "note":
      return t("customers.activityNote");
    case "contact_created":
      return t("customers.activityCreated");
    case "contact_updated":
      return t("customers.activityUpdated");
    case "gender_updated":
      return t("customers.activityGenderUpdated");
    case "contact_merged":
      return t("customers.activityMerged");
    case "tag_added":
      return t("customers.activityTagAdded");
    case "tag_removed":
      return t("customers.activityTagRemoved");
    case "order_placed":
      return t("customers.activityOrderPlaced");
    case "gift_received":
      return t("customers.activityGiftReceived");
    case "contact_archived":
      return t("customers.activityArchived");
    case "contact_unarchived":
      return t("customers.activityUnarchived");
    default:
      return item.type.replace(/_/g, " ");
  }
}

export default function ContactProfile() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { userId } = useAuth();
  const { isOwner } = useWorkspaceRole();
  const [, params] = useRoute("/contacts/:id");
  const id = params?.id ?? "";

  const [orderTab, setOrderTab] = useState<OrderTab>("all");
  const [page, setPage] = useState(1);
  const limit = 10;

  const [activityPage, setActivityPage] = useState(1);
  const activityLimit = 15;

  const [editOpen, setEditOpen] = useState(false);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const { data, isLoading, error } = useGetContact(id);
  const typeParam = orderTab === "all" ? undefined : orderTab;
  const { data: ordersData, isLoading: loadingOrders } = useListContactOrders(id, {
    page,
    limit,
    ...(typeParam ? { type: typeParam } : {}),
  });
  const { data: activityData, isLoading: loadingActivity } = useListContactActivity(id, {
    page: activityPage,
    limit: activityLimit,
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: getGetContactQueryKey(id) });
    void qc.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });
    void qc.invalidateQueries({ queryKey: getListContactOrdersQueryKey(id) });
    void qc.invalidateQueries({ queryKey: getListContactActivityQueryKey(id) });
  };

  const addTag = useAddContactTag({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.tagAdded") });
        invalidateAll();
      },
      onError: () => toast({ title: t("customers.tagError"), variant: "destructive" }),
    },
  });

  const removeTag = useRemoveContactTag({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.tagRemoved") });
        invalidateAll();
      },
      onError: () => toast({ title: t("customers.tagError"), variant: "destructive" }),
    },
  });

  const [tagOpen, setTagOpen] = useState(false);
  const [tagValue, setTagValue] = useState("");

  const archiveContact = useArchiveContact({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.contactArchived") });
        setArchiveConfirmOpen(false);
        invalidateAll();
      },
      onError: () =>
        toast({ title: t("customers.archiveError"), variant: "destructive" }),
    },
  });
  const unarchiveContact = useUnarchiveContact({
    mutation: {
      onSuccess: () => {
        toast({ title: t("customers.contactUnarchived") });
        invalidateAll();
      },
      onError: () =>
        toast({ title: t("customers.archiveError"), variant: "destructive" }),
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid lg:grid-cols-3 gap-6">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  const contact = data?.contact;
  if (error || !contact) {
    return (
      <div className="space-y-4">
        <Link
          href="/customers"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronLeft size={14} className="rtl:rotate-180" />
          {t("customers.backToContacts")}
        </Link>
        <p className="text-muted-foreground" data-testid="text-contact-not-found">
          {t("customers.profileNotFound")}
        </p>
      </div>
    );
  }

  const name = contactFullName(contact, t("customers.unnamed"));
  const waHref = whatsappHref(contact.phone);

  const orders = ordersData?.orders ?? [];
  const totalOrders = ordersData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalOrders / limit));

  const activityItems = activityData?.items ?? [];
  const activityTotal = activityData?.total ?? 0;
  const activityPages = Math.max(1, Math.ceil(activityTotal / activityLimit));

  const submitTag = () => {
    const tag = tagValue.trim();
    if (!tag) return;
    if (RESERVED_TAGS.includes(tag.toLowerCase())) {
      toast({ title: t("customers.tagReserved", { tag }), variant: "destructive" });
      return;
    }
    if (contact.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      toast({ title: t("customers.tagDuplicate"), variant: "destructive" });
      return;
    }
    addTag.mutate(
      { id: contact.id, data: { tag } },
      {
        onSuccess: () => {
          setTagValue("");
          setTagOpen(false);
        },
      },
    );
  };

  const countLabel =
    orderTab === "placed"
      ? t("customers.ordersPlacedCount", { count: totalOrders })
      : orderTab === "received"
        ? t("customers.giftsReceivedCount", { count: totalOrders })
        : t("customers.profileOrdersCount", { count: totalOrders });

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div>
        <Link
          href="/customers"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          data-testid="link-back-to-contacts"
        >
          <ChevronLeft size={14} className="rtl:rotate-180" />
          {t("customers.backToContacts")}
        </Link>
      </div>

      {/* Identity header */}
      <div className="rounded-lg border bg-card p-5 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-teal-100 text-teal-800 text-lg font-semibold"
            data-testid="avatar-contact-initials"
            aria-hidden="true"
          >
            {initialsFor(name)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold truncate" data-testid="text-contact-name">
                {name}
              </h1>
              <RoleBadges contact={contact} />
              {contact.archived_at != null && (
                <Badge
                  variant="secondary"
                  className="bg-gray-200 text-gray-700"
                  data-testid="badge-contact-archived"
                >
                  {t("customers.archivedBadge")}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t("customers.createdOn", { date: formatDate(contact.created_at) })}
            </p>
            <p className="text-sm mt-0.5" data-testid="text-contact-header-phone">
              {contact.phone ?? t("customers.phoneNotProvided")}
              {" · "}
              {contact.email ?? t("customers.emailNotProvided")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => setCreateOrderOpen(true)}
            data-testid="button-create-order-from-contact"
          >
            <Plus size={16} className="me-1" />
            {t("customers.createOrder")}
          </Button>
          {waHref && (
            <Button asChild variant="outline" data-testid="button-whatsapp-contact">
              <a href={waHref} target="_blank" rel="noopener noreferrer" aria-label="WhatsApp">
                <MessageCircle size={16} className="me-1" />
                WhatsApp
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setEditOpen(true)}
            data-testid="button-edit-contact"
          >
            <Pencil size={16} className="me-1" />
            {t("customers.editContact")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label={t("customers.moreActions")}
                data-testid="button-contact-overflow"
              >
                <MoreHorizontal size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setDuplicatesOpen(true)}
                data-testid="menu-check-duplicates"
              >
                {t("customers.checkDuplicates")}
              </DropdownMenuItem>
              {contact.customer_id != null && (
                <DropdownMenuItem asChild>
                  <Link href={`/customers/${contact.customer_id}`}>
                    {t("customers.profileViewCustomer")}
                  </Link>
                </DropdownMenuItem>
              )}
              {isOwner && (
                <DropdownMenuItem
                  onClick={() => setDuplicatesOpen(true)}
                  data-testid="menu-merge-contact"
                >
                  {t("customers.mergeContact")}
                </DropdownMenuItem>
              )}
              {isOwner &&
                (contact.archived_at != null ? (
                  <DropdownMenuItem
                    onClick={() => unarchiveContact.mutate({ id: contact.id })}
                    data-testid="menu-unarchive-contact"
                  >
                    {t("customers.unarchiveContact")}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setArchiveConfirmOpen(true)}
                    data-testid="menu-archive-contact"
                  >
                    {t("customers.archiveContact")}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("customers.archiveConfirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("customers.archiveConfirmBody", { name })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("customers.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => archiveContact.mutate({ id: contact.id })}
                  data-testid="button-confirm-archive"
                >
                  {t("customers.archiveContact")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label={t("customers.metricOrdersPlaced")}
          value={String(contact.orders_placed)}
          icon={<ShoppingBag size={18} className="text-blue-600" />}
          iconClass="bg-blue-50"
          testId="metric-orders-placed"
        />
        <MetricCard
          label={t("customers.metricGiftsReceived")}
          value={String(contact.gifts_received)}
          icon={<Gift size={18} className="text-purple-600" />}
          iconClass="bg-purple-50"
          testId="metric-gifts-received"
        />
        <MetricCard
          label={t("customers.metricTotalValue")}
          value={formatUsd(contact.total_spent_usd)}
          icon={<Wallet size={18} className="text-teal-600" />}
          iconClass="bg-teal-50"
          testId="metric-total-value"
        />
        <MetricCard
          label={t("customers.metricLastActivity")}
          value={formatDate(contact.last_activity_at)}
          icon={<Clock size={18} className="text-amber-600" />}
          iconClass="bg-amber-50"
          testId="metric-last-activity"
        />
      </div>

      {/* Two-column layout */}
      <div className="grid lg:grid-cols-3 gap-6 items-start">
        {/* LEFT */}
        <div className="lg:col-span-2 space-y-6 min-w-0">
          {/* Order history */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="font-semibold">{t("customers.profileOrderHistory")}</h2>
              {totalOrders > 0 && (
                <span
                  className="text-sm text-muted-foreground"
                  data-testid="text-order-count"
                >
                  {countLabel}
                </span>
              )}
            </div>
            <Tabs
              value={orderTab}
              onValueChange={(v) => {
                setOrderTab(v as OrderTab);
                setPage(1);
              }}
            >
              <TabsList>
                <TabsTrigger value="all" data-testid="tab-orders-all">
                  {t("customers.tabOrdersAll")}
                </TabsTrigger>
                <TabsTrigger value="placed" data-testid="tab-orders-placed">
                  {t("customers.tabOrdersPlaced")}
                </TabsTrigger>
                <TabsTrigger value="received" data-testid="tab-orders-received">
                  {t("customers.tabGiftsReceived")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {loadingOrders ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : orders.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4" data-testid="text-no-orders">
                {orderTab === "placed"
                  ? t("customers.noOrdersPlaced")
                  : orderTab === "received"
                    ? t("customers.noGiftsReceived")
                    : t("customers.profileNoOrders")}
              </p>
            ) : (
              <>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("customers.profileColOrder")}</TableHead>
                        <TableHead>{t("customers.profileColDate")}</TableHead>
                        <TableHead>{t("customers.profileColStatus")}</TableHead>
                        <TableHead>{t("customers.profileColRole")}</TableHead>
                        <TableHead>{t("customers.profileColTotal")}</TableHead>
                        <TableHead className="w-8" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {orders.map((o) => {
                        const { total, currency } = orderTotals(o);
                        const href = orderDetailPath(o);
                        return (
                          <TableRow
                            key={o.id}
                            data-testid={`row-contact-order-${o.id}`}
                            className="cursor-pointer"
                            onClick={() => {
                              window.location.hash = "";
                              window.history.pushState(null, "", href);
                              window.dispatchEvent(new PopStateEvent("popstate"));
                            }}
                          >
                            <TableCell className="font-mono text-sm">
                              <Link
                                href={href}
                                className="text-primary hover:underline"
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                data-testid={`link-order-${o.id}`}
                              >
                                {o.display_order_number ?? `#${o.id.slice(0, 8)}`}
                              </Link>
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatDate(o.ordered_at ?? o.created_at)}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary" className={orderStatusBadgeClass(o.status)}>
                                {t(ORDER_STATUS_LABEL_KEYS[normalizeOrderStatus(o.status) as OrderStatus] ?? "orders.statusPending")}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {o.roles.includes("customer") && (
                                  <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 text-xs">
                                    {t("customers.badgeCustomer")}
                                  </Badge>
                                )}
                                {o.roles.includes("recipient") && (
                                  <Badge className="bg-purple-100 text-purple-800 hover:bg-purple-100 text-xs">
                                    {t("customers.badgeRecipient")}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm">
                              {formatAmount(total, currency)}
                            </TableCell>
                            <TableCell>
                              <ChevronRight
                                size={16}
                                className="text-muted-foreground rtl:rotate-180"
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((p) => p - 1)}
                      disabled={page <= 1}
                      data-testid="button-orders-prev"
                    >
                      <ChevronLeft size={14} className="rtl:rotate-180" />
                    </Button>
                    <span>{t("customers.pageOf", { page, total: totalPages })}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page >= totalPages}
                      data-testid="button-orders-next"
                    >
                      <ChevronRight size={14} className="rtl:rotate-180" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Activity & notes */}
          <ActivityNotesCard
            contactId={contact.id}
            items={activityItems}
            loading={loadingActivity}
            page={activityPage}
            pages={activityPages}
            onPageChange={setActivityPage}
            isOwner={isOwner}
            userId={userId ?? null}
            onChanged={invalidateAll}
            labelFor={(item) => activityLabel(item, t)}
          />
        </div>

        {/* RIGHT */}
        <div className="space-y-6 min-w-0">
          {/* Contact details */}
          <div className="rounded-lg border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{t("customers.contactDetails")}</h2>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => setEditOpen(true)}
                data-testid="button-edit-contact-details"
              >
                <Pencil size={12} className="me-1" />
                {t("customers.edit")}
              </Button>
            </div>
            <div className="space-y-3 text-sm">
              <DetailRow label={t("customers.profilePhone")}>
                {contact.phone ? (
                  <span className="flex items-center gap-1.5">
                    <span data-testid="text-contact-phone">{contact.phone}</span>
                    <button
                      type="button"
                      aria-label={t("customers.copyPhone")}
                      className="text-muted-foreground hover:text-foreground"
                      data-testid="button-copy-phone"
                      onClick={() => {
                        void navigator.clipboard.writeText(contact.phone ?? "");
                        toast({ title: t("customers.copied") });
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    {waHref && (
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="WhatsApp"
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <MessageCircle size={13} />
                      </a>
                    )}
                  </span>
                ) : (
                  <MissingValue
                    label={t("customers.notProvided")}
                    action={t("customers.addPhone")}
                    onAction={() => setEditOpen(true)}
                    testId="button-add-phone"
                  />
                )}
              </DetailRow>
              <DetailRow label={t("customers.profileEmail")}>
                {contact.email ? (
                  <span className="flex items-center gap-1.5">
                    <span data-testid="text-contact-email">{contact.email}</span>
                    <button
                      type="button"
                      aria-label={t("customers.copyEmail")}
                      className="text-muted-foreground hover:text-foreground"
                      data-testid="button-copy-email"
                      onClick={() => {
                        void navigator.clipboard.writeText(contact.email ?? "");
                        toast({ title: t("customers.copied") });
                      }}
                    >
                      <Copy size={13} />
                    </button>
                  </span>
                ) : (
                  <MissingValue
                    label={t("customers.notProvided")}
                    action={t("customers.addEmail")}
                    onAction={() => setEditOpen(true)}
                    testId="button-add-email"
                  />
                )}
              </DetailRow>
              <DetailRow label={t("customers.language")}>
                {contact.preferred_language ? (
                  <span data-testid="text-contact-language">
                    {contact.preferred_language}
                  </span>
                ) : (
                  <MissingValue
                    label={t("customers.notSet")}
                    action={t("customers.edit")}
                    onAction={() => setEditOpen(true)}
                    testId="button-add-language"
                  />
                )}
              </DetailRow>
              <DetailRow label={t("customers.gender")}>
                <span className="flex items-center gap-1.5 flex-wrap">
                  <span data-testid="text-contact-gender">
                    {genderLabel(contact.gender, t)}
                  </span>
                  {contact.gender_source === "ai" && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] px-1.5 py-0"
                      data-testid="badge-gender-ai"
                      title={
                        contact.gender_confidence != null
                          ? t("customers.genderAiConfidence", {
                              pct: Math.round(contact.gender_confidence * 100),
                            })
                          : undefined
                      }
                    >
                      {t("customers.genderAiBadge")}
                    </Badge>
                  )}
                </span>
              </DetailRow>
              <DetailRow label={t("customers.source")}>
                <span data-testid="text-contact-source">
                  {sourceLabel(contact.source, t)}
                </span>
              </DetailRow>
              {contact.country && (
                <DetailRow label={t("customers.country")}>
                  <span>{contact.country}</span>
                </DetailRow>
              )}
              <DetailRow label={t("customers.profileCreated")}>
                <span title={formatDateTime(contact.created_at)}>
                  {formatDate(contact.created_at)}
                </span>
              </DetailRow>
            </div>
          </div>

          {/* respond.io sync card */}
          <RespondIoCard contact={contact} onSynced={invalidateAll} />

          {/* Linked relationships */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <h2 className="font-semibold">{t("customers.linkedRelationships")}</h2>
            {contact.relationships.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-relationships">
                {t("customers.noRelationships")}
              </p>
            ) : (
              <ul className="space-y-1">
                {contact.relationships.map((rel) => (
                  <li key={rel.id}>
                    <Link
                      href={`/contacts/${rel.id}`}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-2 -mx-2 hover:bg-muted"
                      data-testid={`link-relationship-${rel.id}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">
                          {rel.name ?? t("customers.unnamed")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {rel.their_role === "customer"
                            ? t("customers.relationshipSender")
                            : t("customers.relationshipRecipient")}
                          {" · "}
                          {t("customers.sharedOrders", { count: rel.shared_orders })}
                        </span>
                      </span>
                      <ChevronRight
                        size={16}
                        className="text-muted-foreground shrink-0 rtl:rotate-180"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Tags */}
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{t("customers.profileTags")}</h2>
              <Popover open={tagOpen} onOpenChange={setTagOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    data-testid="button-add-tag"
                  >
                    <Plus size={12} className="me-0.5" />
                    {t("customers.add")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-2" align="end">
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={tagValue}
                      placeholder={t("customers.addTagPlaceholder")}
                      onChange={(e) => setTagValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitTag();
                        }
                      }}
                      className="h-8 text-sm"
                      data-testid="input-add-tag"
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      onClick={submitTag}
                      disabled={addTag.isPending}
                    >
                      {t("customers.add")}
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {contact.tags.length === 0 && (
                <span className="text-muted-foreground text-sm" data-testid="text-no-tags">
                  {t("customers.noTagsAdded")}
                </span>
              )}
              {contact.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs gap-1 pr-1">
                  {tag}
                  <button
                    type="button"
                    aria-label={t("customers.removeTag")}
                    className="rounded-sm hover:bg-muted-foreground/20"
                    data-testid={`button-remove-tag-${tag}`}
                    onClick={() => removeTag.mutate({ id: contact.id, tag })}
                  >
                    <X size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          </div>

          {/* Duplicate review */}
          <div className="rounded-lg border bg-card p-5 space-y-2">
            <h2 className="font-semibold">{t("customers.duplicateReview")}</h2>
            {contact.duplicate_count > 0 ? (
              <p className="text-sm text-amber-700" data-testid="text-duplicate-warning">
                {t("customers.possibleDuplicates", { count: contact.duplicate_count })}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("customers.noDuplicatesHint")}
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDuplicatesOpen(true)}
              data-testid="button-check-duplicates"
            >
              <Users size={14} className="me-1" />
              {t("customers.checkDuplicates")}
            </Button>
          </div>
        </div>
      </div>

      <EditContactDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={contact}
        onSaved={invalidateAll}
      />

      <DuplicatesDialog
        open={duplicatesOpen}
        onOpenChange={setDuplicatesOpen}
        contact={contact}
        contactName={name}
        isOwner={isOwner}
        onMerged={invalidateAll}
      />

      <CreateOrderWizard
        open={createOrderOpen}
        onOpenChange={setCreateOrderOpen}
        onCreated={() => invalidateAll()}
        {...(contact.is_customer || !contact.is_recipient
          ? {
              initialCustomer: {
                name,
                email: contact.email,
                phone: contact.phone,
              },
            }
          : {
              initialRecipient: {
                name,
                phone: contact.phone,
              },
            })}
      />
    </div>
  );
}

function RespondIoCard({
  contact,
  onSynced,
}: {
  contact: ContactDetail;
  onSynced: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [respondioEnabled, setRespondioEnabled] = useState<boolean | null>(null);
  const [respondioContactId, setRespondioContactId] = useState<string | null>(
    contact.respondio_contact_id ?? null,
  );
  const [rioUrl, setRioUrl] = useState<string | null>(contact.respondio_url ?? null);
  const [whatsappConsent, setWhatsappConsent] = useState<boolean>(
    contact.whatsapp_consent ?? false,
  );

  useEffect(() => {
    apiFetch<{ respondio_enabled?: boolean }>("/api/settings")
      .then((s) => setRespondioEnabled(s.respondio_enabled ?? false))
      .catch(() => setRespondioEnabled(false));
  }, []);

  const syncMutation = useRespondIoSyncContact({
    mutation: {
      onSuccess: (data) => {
        setRespondioContactId(data.contactId);
        setRioUrl(data.url ?? null);
        onSynced();
      },
      onError: (err) => {
        const errorCode =
          err &&
          typeof err === "object" &&
          "data" in err &&
          err.data != null &&
          typeof err.data === "object" &&
          "error" in err.data
            ? (err.data as { error?: string }).error
            : undefined;
        toast({
          title:
            errorCode === "phone_format_invalid"
              ? t("contacts.respondio.syncPhoneFormatInvalid")
              : t("contacts.respondio.syncError"),
          variant: "destructive",
        });
      },
    },
  });

  const resetMutation = useDeleteRespondIoSyncContact({
    mutation: {
      onSuccess: () => {
        setRespondioContactId(null);
        setRioUrl(null);
        onSynced();
      },
      onError: () => {
        toast({
          title: t("contacts.respondio.resetError", "Failed to reset respond.io sync"),
          variant: "destructive",
        });
      },
    },
  });

  const consentMutation = useUpdateContactConsent({
    mutation: {
      onSuccess: () => {
        onSynced();
      },
      onError: () => {
        // Revert the optimistic flip on failure.
        setWhatsappConsent((v) => !v);
        toast({
          title: t("contacts.respondio.consentError", "Failed to update WhatsApp notification preference"),
          variant: "destructive",
        });
      },
    },
  });

  if (respondioEnabled === null || !respondioEnabled) return null;

  return (
    <div className="rounded-lg border bg-card p-5 space-y-3" data-testid="card-respondio">
      <h2 className="font-semibold">{t("contacts.respondio.title")}</h2>
      {respondioContactId ? (
        <div className="space-y-2">
          <p className="text-sm text-green-700" data-testid="text-respondio-synced">
            {t("contacts.respondio.synced")}
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            {rioUrl && (
              <a
                href={rioUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                data-testid="link-respondio-open"
              >
                <ExternalLink size={14} />
                {t("contacts.respondio.openInRespondio")}
              </a>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-muted-foreground h-auto py-0 px-1"
              disabled={resetMutation.isPending}
              onClick={() => resetMutation.mutate({ id: contact.id })}
              data-testid="button-respondio-reset"
            >
              {t("contacts.respondio.resetSync", "Reset sync")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground" data-testid="text-respondio-not-synced">
            {t("contacts.respondio.notSynced")}
          </p>
          {!contact.phone ? (
            <p className="text-xs text-muted-foreground">
              {t("contacts.respondio.phoneRequired")}
            </p>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate({ id: contact.id })}
              data-testid="button-respondio-sync"
            >
              {syncMutation.isPending
                ? t("contacts.respondio.syncing")
                : t("contacts.respondio.syncNow")}
            </Button>
          )}
        </div>
      )}
      <div className="border-t pt-3 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <Label
            htmlFor="whatsapp-consent-toggle"
            className="text-sm font-normal cursor-pointer"
          >
            {t("contacts.respondio.whatsappOptIn", "WhatsApp order notifications")}
          </Label>
          <Switch
            id="whatsapp-consent-toggle"
            checked={whatsappConsent}
            disabled={consentMutation.isPending || !contact.phone}
            onCheckedChange={(checked) => {
              setWhatsappConsent(checked);
              consentMutation.mutate({
                id: contact.id,
                data: { whatsapp_consent: checked },
              });
            }}
            data-testid="switch-whatsapp-consent"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {contact.phone
            ? t(
                "contacts.respondio.whatsappOptInHint",
                "With explicit customer consent, order updates (placed, ready, delivered) are sent on WhatsApp.",
              )
            : t("contacts.respondio.phoneRequired")}
        </p>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function MissingValue({
  label,
  action,
  onAction,
  testId,
}: {
  label: string;
  action: string;
  onAction: () => void;
  testId: string;
}) {
  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      {label}
      <button
        type="button"
        className="text-primary text-xs hover:underline"
        onClick={onAction}
        data-testid={testId}
      >
        {action}
      </button>
    </span>
  );
}

function EditContactDialog({
  open,
  onOpenChange,
  contact,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contact: ContactDetail;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [firstName, setFirstName] = useState(contact.first_name ?? "");
  const [lastName, setLastName] = useState(contact.last_name ?? "");
  const [displayName, setDisplayName] = useState(contact.display_name ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [preferredLanguage, setPreferredLanguage] = useState(
    contact.preferred_language ?? "",
  );
  const [gender, setGender] = useState<string>(contact.gender ?? "unknown");

  const update = useUpdateContact();

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setFirstName(contact.first_name ?? "");
      setLastName(contact.last_name ?? "");
      setDisplayName(contact.display_name ?? "");
      setEmail(contact.email ?? "");
      setPhone(contact.phone ?? "");
      setPreferredLanguage(contact.preferred_language ?? "");
      setGender(contact.gender ?? "unknown");
    }
    onOpenChange(next);
  };

  const save = () => {
    update.mutate(
      {
        id: contact.id,
        data: {
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
          display_name: displayName.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          preferred_language: preferredLanguage.trim() || null,
          // Only send gender when the user actually changed it, so an
          // untouched save doesn't convert an AI value into a manual override.
          ...(gender !== (contact.gender ?? "unknown")
            ? { gender: gender as "male" | "female" | "unknown" }
            : {}),
        },
      },
      {
        onSuccess: () => {
          toast({ title: t("customers.contactSaved") });
          onSaved();
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          const conflict = (err as { field?: string } & Partial<ContactConflictError>) ?? {};
          if (conflict.field === "email") {
            toast({ title: t("customers.emailConflict"), variant: "destructive" });
          } else if (conflict.field === "phone") {
            toast({ title: t("customers.phoneConflict"), variant: "destructive" });
          } else {
            toast({ title: t("customers.saveError"), variant: "destructive" });
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("customers.editContact")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("customers.firstName")}</Label>
              <Input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                data-testid="input-edit-first-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("customers.lastName")}</Label>
              <Input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                data-testid="input-edit-last-name"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("customers.displayName")}</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              data-testid="input-edit-display-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("customers.profileEmail")}</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="input-edit-email"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("customers.profilePhone")}</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+961..."
              data-testid="input-edit-phone"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("customers.language")}</Label>
            <Input
              value={preferredLanguage}
              onChange={(e) => setPreferredLanguage(e.target.value)}
              placeholder={t("customers.languagePlaceholder")}
              data-testid="input-edit-language"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("customers.gender")}</Label>
            <Select value={gender} onValueChange={setGender}>
              <SelectTrigger data-testid="select-edit-gender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">{t("customers.genderUnknown")}</SelectItem>
                <SelectItem value="male">{t("customers.genderMale")}</SelectItem>
                <SelectItem value="female">{t("customers.genderFemale")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("customers.genderEditHint")}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("customers.cancel")}
          </Button>
          <Button onClick={save} disabled={update.isPending} data-testid="button-save-contact">
            {update.isPending && <Spinner className="size-4 me-1" />}
            {t("customers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActivityNotesCard({
  contactId,
  items,
  loading,
  page,
  pages,
  onPageChange,
  isOwner,
  userId,
  onChanged,
  labelFor,
}: {
  contactId: string;
  items: ContactActivityItem[];
  loading: boolean;
  page: number;
  pages: number;
  onPageChange: (p: number) => void;
  isOwner: boolean;
  userId: string | null;
  onChanged: () => void;
  labelFor: (item: ContactActivityItem) => string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState("");
  const [deleteNoteId, setDeleteNoteId] = useState<number | null>(null);

  const createNote = useCreateContactNote();
  const updateNote = useUpdateContactNote();
  const deleteNote = useDeleteContactNote();

  const submitNote = () => {
    const body = noteBody.trim();
    if (!body) return;
    createNote.mutate(
      { id: contactId, data: { body } },
      {
        onSuccess: () => {
          toast({ title: t("customers.noteAdded") });
          setNoteBody("");
          setNoteOpen(false);
          onChanged();
        },
        onError: () => toast({ title: t("customers.noteError"), variant: "destructive" }),
      },
    );
  };

  const saveEdit = () => {
    if (editingNoteId == null) return;
    const body = editBody.trim();
    if (!body) return;
    updateNote.mutate(
      { id: contactId, noteId: editingNoteId, data: { body } },
      {
        onSuccess: () => {
          toast({ title: t("customers.noteSaved") });
          setEditingNoteId(null);
          onChanged();
        },
        onError: () => toast({ title: t("customers.noteError"), variant: "destructive" }),
      },
    );
  };

  const confirmDelete = () => {
    if (deleteNoteId == null) return;
    deleteNote.mutate(
      { id: contactId, noteId: deleteNoteId },
      {
        onSuccess: () => {
          toast({ title: t("customers.noteDeleted") });
          setDeleteNoteId(null);
          onChanged();
        },
        onError: () => toast({ title: t("customers.noteError"), variant: "destructive" }),
      },
    );
  };

  const canManageNote = (item: ContactActivityItem) =>
    isOwner || (item.actor_user_id != null && item.actor_user_id === userId);

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{t("customers.activityNotes")}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setNoteOpen((v) => !v)}
          data-testid="button-add-note"
        >
          <Plus size={14} className="me-1" />
          {t("customers.addNote")}
        </Button>
      </div>

      {noteOpen && (
        <div className="space-y-2">
          <Textarea
            autoFocus
            rows={3}
            maxLength={5000}
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
            placeholder={t("customers.notePlaceholder")}
            data-testid="input-note-body"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNoteOpen(false)}>
              {t("customers.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={submitNote}
              disabled={createNote.isPending || !noteBody.trim()}
              data-testid="button-save-note"
            >
              {t("customers.save")}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-activity">
          {t("customers.noNotesYet")}
        </p>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => {
            const isNote = item.type === "note";
            const noteId = isNote ? Number(item.ref_id) : null;
            const editing = isNote && editingNoteId != null && editingNoteId === noteId;
            return (
              <li
                key={`${item.type}-${item.ref_id}`}
                className="flex gap-3"
                data-testid={`activity-item-${item.type}-${item.ref_id}`}
              >
                <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-600" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{labelFor(item)}</p>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDateTime(item.created_at)}
                    </span>
                  </div>
                  {editing ? (
                    <div className="mt-1 space-y-2">
                      <Textarea
                        rows={2}
                        maxLength={5000}
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        data-testid="input-edit-note-body"
                      />
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setEditingNoteId(null)}>
                          {t("customers.cancel")}
                        </Button>
                        <Button size="sm" onClick={saveEdit} disabled={updateNote.isPending}>
                          {t("customers.save")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    item.body && (
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-0.5">
                        {item.body}
                      </p>
                    )
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.actor_name && (
                      <span className="text-xs text-muted-foreground">{item.actor_name}</span>
                    )}
                    {isNote && noteId != null && canManageNote(item) && !editing && (
                      <>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground"
                          aria-label={t("customers.editNote")}
                          data-testid={`button-edit-note-${noteId}`}
                          onClick={() => {
                            setEditingNoteId(noteId);
                            setEditBody(item.body ?? "");
                          }}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-destructive"
                          aria-label={t("customers.deleteNote")}
                          data-testid={`button-delete-note-${noteId}`}
                          onClick={() => setDeleteNoteId(noteId)}
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            data-testid="button-activity-prev"
          >
            <ChevronLeft size={14} className="rtl:rotate-180" />
          </Button>
          <span>{t("customers.pageOf", { page, total: pages })}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pages}
            data-testid="button-activity-next"
          >
            <ChevronRight size={14} className="rtl:rotate-180" />
          </Button>
        </div>
      )}

      <AlertDialog open={deleteNoteId != null} onOpenChange={(o) => !o && setDeleteNoteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("customers.deleteNoteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("customers.deleteNoteConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("customers.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-note"
            >
              {t("customers.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DuplicatesDialog({
  open,
  onOpenChange,
  contact,
  contactName,
  isOwner,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contact: ContactDetail;
  contactName: string;
  isOwner: boolean;
  onMerged: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useListContactDuplicates(contact.id, {
    query: {
      enabled: open,
      queryKey: getListContactDuplicatesQueryKey(contact.id),
    },
  });
  const duplicates = data?.duplicates ?? [];

  const [mergeCandidate, setMergeCandidate] = useState<ContactDuplicate | null>(null);
  const [survivorId, setSurvivorId] = useState<string>(contact.id);

  const merge = useMergeContact();

  const doMerge = () => {
    if (!mergeCandidate) return;
    // The route merges :id INTO targetId (targetId survives).
    const loserId = survivorId === contact.id ? mergeCandidate.id : contact.id;
    merge.mutate(
      { id: loserId, data: { targetId: survivorId } },
      {
        onSuccess: (res) => {
          toast({ title: t("customers.mergeSuccess") });
          setMergeCandidate(null);
          onOpenChange(false);
          void qc.invalidateQueries({ queryKey: [getListContactsQueryKey()[0]] });
          void qc.invalidateQueries({
            queryKey: getListContactDuplicatesQueryKey(contact.id),
          });
          if (res.survivorId !== contact.id) {
            window.history.pushState(null, "", `/contacts/${res.survivorId}`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          } else {
            onMerged();
          }
        },
        onError: () => toast({ title: t("customers.mergeError"), variant: "destructive" }),
      },
    );
  };

  const dupName = (d: ContactDuplicate) =>
    contactFullName(d, t("customers.unnamed"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("customers.duplicateReview")}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner className="size-6 text-primary" />
          </div>
        ) : duplicates.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4" data-testid="text-no-duplicates">
            {t("customers.noDuplicatesFound")}
          </p>
        ) : mergeCandidate == null ? (
          <ul className="space-y-2 max-h-80 overflow-y-auto">
            {duplicates.map((d) => (
              <li
                key={d.id}
                className="rounded-md border p-3 flex items-center justify-between gap-3"
                data-testid={`row-duplicate-${d.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{dupName(d)}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[d.phone, d.email].filter(Boolean).join(" · ") || "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("customers.matchedOn")}{" "}
                    {d.matched_on === "both"
                      ? `${t("customers.profilePhone")} + ${t("customers.profileEmail")}`
                      : d.matched_on === "phone"
                        ? t("customers.profilePhone")
                        : t("customers.profileEmail")}
                    {" · "}
                    {t("customers.ordersPlacedCount", { count: d.orders_placed })}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/contacts/${d.id}`} onClick={() => onOpenChange(false)}>
                      {t("customers.view")}
                    </Link>
                  </Button>
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setMergeCandidate(d);
                        setSurvivorId(contact.id);
                      }}
                      data-testid={`button-merge-${d.id}`}
                    >
                      {t("customers.merge")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("customers.mergePickSurvivor")}</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { id: contact.id, name: contactName, email: contact.email, phone: contact.phone },
                {
                  id: mergeCandidate.id,
                  name: dupName(mergeCandidate),
                  email: mergeCandidate.email,
                  phone: mergeCandidate.phone,
                },
              ].map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSurvivorId(c.id)}
                  className={`rounded-md border p-3 text-start ${
                    survivorId === c.id ? "border-primary ring-1 ring-primary" : ""
                  }`}
                  data-testid={`button-survivor-${c.id}`}
                >
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {[c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {survivorId === c.id && (
                    <p className="text-xs text-primary mt-1">{t("customers.survivor")}</p>
                  )}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("customers.mergeWarning")}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setMergeCandidate(null)}>
                {t("customers.cancel")}
              </Button>
              <Button
                onClick={doMerge}
                disabled={merge.isPending}
                data-testid="button-confirm-merge"
              >
                {merge.isPending && <Spinner className="size-4 me-1" />}
                {t("customers.confirmMerge")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
