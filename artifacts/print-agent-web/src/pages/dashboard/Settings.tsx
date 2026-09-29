import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Settings2, Bell, Mail, Lock, Globe, MapPin, Search, X, GripVertical, ArrowRightLeft, RefreshCw, Save, Info, AlertTriangle, Bot, Eye, EyeOff, CheckCircle2, Circle, Tag, Plus, Pencil, Trash2, Check, Store, Receipt, ExternalLink, Printer } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { WORLD_COUNTRIES, COUNTRY_CATALOGUE, EXCLUDED_COUNTRY_NAMES, findCountryByName, getDefaultFlagUrl, getCountryMetadata, isExcludedCountry } from "@/lib/countries";
import { FlagImage } from "@/components/FlagImage";
import { useUpload } from "@workspace/object-storage-web";
import { cn } from "@/lib/utils";
import {
  usePutCountryFlag,
  useDeleteCountryFlag,
  useListMarketplaceBrandAliases,
  getListMarketplaceBrandAliasesQueryKey,
  useCreateMarketplaceBrandAlias,
  useDeleteMarketplaceBrandAlias,
  useCreateOmnichannelTag,
  useUpdateOmnichannelTag,
  useDeleteOmnichannelTag,
  useListSuppliers,
  type OmniTag,
  type Supplier,
} from "@workspace/api-client-react";

type ResolvedCountry = {
  name: string;
  code: string | null;
  flagImageUrl: string | null;
};

type WorkspaceSettings = {
  offline_alert_threshold_minutes: number;
  offline_alert_email_enabled: boolean;
  available_countries: string[];
  available_country_details?: ResolvedCountry[];
  country_catalogue?: ResolvedCountry[];
  undo_duration_seconds: number;
  delivery_webhook_url: string | null;
  workspace_slug?: string | null;
  trustpilot_invitations_enabled?: boolean;
  respondio_enabled?: boolean;
};

const THRESHOLD_OPTIONS = [
  { value: 5, labelKey: "settings.thresholdOptions.5" },
  { value: 15, labelKey: "settings.thresholdOptions.15" },
  { value: 60, labelKey: "settings.thresholdOptions.60" },
];

const UNDO_DURATION_OPTIONS = [3, 5, 10, 15, 30];

export default function SettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner } = useWorkspaceRole();

  const { data, isLoading } = useQuery<WorkspaceSettings>({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<WorkspaceSettings>("/api/settings"),
  });

  const [threshold, setThreshold] = useState<number>(5);
  const [emailEnabled, setEmailEnabled] = useState<boolean>(false);
  const [undoDuration, setUndoDuration] = useState<number>(5);
  const [language, setLanguage] = useState<string>(i18n.language.startsWith("ar") ? "ar" : "en");

  const [selectedCountries, setSelectedCountries] = useState<Set<string>>(new Set(["Lebanon", "United Arab Emirates"]));
  const [countrySearch, setCountrySearch] = useState("");

  useEffect(() => {
    if (data) {
      setThreshold(data.offline_alert_threshold_minutes);
      setEmailEnabled(data.offline_alert_email_enabled);
      setUndoDuration(data.undo_duration_seconds ?? 5);
      if (data.available_countries && data.available_countries.length > 0) {
        setSelectedCountries(new Set(data.available_countries));
      }
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: (payload: WorkspaceSettings) =>
      apiFetch<WorkspaceSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["workspace-settings"], saved);
      toast({ title: t("settings.settingsSaved"), description: t("settings.settingsSavedDesc") });
    },
    onError: () => {
      toast({
        title: t("settings.failedToSave"),
        description: t("settings.failedToSaveDesc"),
        variant: "destructive",
      });
    },
  });

  const countriesMutation = useMutation({
    mutationFn: (countries: string[]) =>
      apiFetch<WorkspaceSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          offline_alert_threshold_minutes: threshold,
          offline_alert_email_enabled: emailEnabled,
          available_countries: countries,
        }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["workspace-settings"], saved);
      queryClient.invalidateQueries({ queryKey: ["workspace-settings"] });
      toast({ title: t("settings.countriesSaved"), description: t("settings.countriesSavedDesc") });
    },
    onError: () => {
      toast({
        title: t("settings.failedToSaveCountries"),
        description: t("settings.failedToSaveCountriesDesc"),
        variant: "destructive",
      });
    },
  });

  function handleSave() {
    mutation.mutate({
      offline_alert_threshold_minutes: threshold,
      offline_alert_email_enabled: emailEnabled,
      available_countries: Array.from(selectedCountries),
      undo_duration_seconds: undoDuration,
      delivery_webhook_url: data?.delivery_webhook_url ?? null,
    });
  }

  function handleLanguageChange(lang: string) {
    setLanguage(lang);
    i18n.changeLanguage(lang);
  }

  function toggleCountry(country: string) {
    setSelectedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(country)) {
        next.delete(country);
      } else {
        next.add(country);
      }
      return next;
    });
  }

  function handleSaveCountries() {
    countriesMutation.mutate(Array.from(selectedCountries));
  }

  const catalogue: ResolvedCountry[] =
    data?.country_catalogue && data.country_catalogue.length > 0
      ? data.country_catalogue
      : WORLD_COUNTRIES.map((name) => {
          const entry = findCountryByName(name);
          return {
            name,
            code: entry?.code ?? null,
            flagImageUrl: entry ? getDefaultFlagUrl(entry.code) : null,
          };
        });

  const filteredCatalogue = catalogue.filter((c) =>
    c.name.toLowerCase().includes(countrySearch.toLowerCase()),
  );

  // ── Task #83: Delivery cities ──────────────────────────────────────────────
  type DeliveryCountrySummary = {
    name: string;
    code: string;
    flag_emoji: string;
    currency: string | null;
    delivery_active: boolean;
    delivery_sort_order: number;
    active_cities_count: number;
  };

  const { data: deliveryData } = useQuery<{ countries: DeliveryCountrySummary[] }>({
    queryKey: ["delivery-countries"],
    queryFn: () => apiFetch("/api/admin/settings/countries"),
    enabled: isOwner,
  });

  const deliveryByCode = new Map<string, DeliveryCountrySummary>();
  for (const c of deliveryData?.countries ?? []) {
    deliveryByCode.set(c.code.toUpperCase(), c);
  }

  const deliveryToggleMutation = useMutation({
    mutationFn: async ({ code, active }: { code: string; active: boolean }) =>
      apiFetch(`/api/admin/settings/countries/${code}/delivery`, {
        method: "PATCH",
        body: JSON.stringify({ delivery_active: active }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["delivery-countries"] });
      toast({ title: t("settings.deliveryActiveSaved") });
    },
    onError: () => {
      toast({ title: t("settings.deliveryActiveSaveFailed"), variant: "destructive" });
    },
  });

  // ── Delivery country reorder ──────────────────────────────────────────────
  const [orderedDeliveryCodes, setOrderedDeliveryCodes] = useState<string[]>([]);

  useEffect(() => {
    if (!deliveryData) return;
    const active = deliveryData.countries
      .filter((c) => c.delivery_active)
      .sort((a, b) => a.delivery_sort_order - b.delivery_sort_order);
    setOrderedDeliveryCodes(active.map((c) => c.code.toUpperCase()));
  }, [deliveryData]);

  const countryReorderMutation = useMutation({
    mutationFn: (codes: string[]) =>
      apiFetch("/api/admin/settings/countries/reorder", {
        method: "PATCH",
        body: JSON.stringify({ codes }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["delivery-countries"] });
    },
    onError: () => {
      toast({ title: t("settings.deliveryActiveSaveFailed"), variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["delivery-countries"] });
    },
  });

  const countrySensors = useSensors(useSensor(PointerSensor));

  function handleCountryDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedDeliveryCodes.indexOf(String(active.id));
    const newIndex = orderedDeliveryCodes.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(orderedDeliveryCodes, oldIndex, newIndex);
    setOrderedDeliveryCodes(next);
    countryReorderMutation.mutate(next);
  }

  const flagOverrideMutation = usePutCountryFlag({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["workspace-settings"] });
        toast({ title: t("settings.flagOverrideSaved") });
      },
      onError: () => {
        toast({
          title: t("settings.flagOverrideFailed"),
          variant: "destructive",
        });
      },
    },
  });

  const flagRemoveMutation = useDeleteCountryFlag({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["workspace-settings"] });
        toast({ title: t("settings.flagOverrideRemoved") });
      },
      onError: () => {
        toast({
          title: t("settings.flagOverrideFailed"),
          variant: "destructive",
        });
      },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("settings.title")}</h1>
        <p className="text-muted-foreground mt-2">
          {t("settings.description")}
        </p>
      </div>

      {!isOwner && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-secondary px-4 py-3 text-sm text-muted-foreground"
          data-testid="settings-read-only-notice"
        >
          <Lock size={14} className="shrink-0" />
          {t("settings.readOnlyNotice")}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Globe size={18} />
            {t("settings.language")}
          </CardTitle>
          <CardDescription>
            {t("settings.languageDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={language} onValueChange={handleLanguageChange}>
            <SelectTrigger className="w-48" data-testid="language-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t("settings.english")}</SelectItem>
              <SelectItem value="ar">{t("settings.arabic")}</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Bell size={18} />
            {t("settings.deviceOfflineAlerts")}
          </CardTitle>
          <CardDescription>
            {t("settings.deviceOfflineAlertsDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="threshold-select">{t("settings.offlineThreshold")}</Label>
                <Select
                  value={String(threshold)}
                  onValueChange={(v) => setThreshold(parseInt(v, 10))}
                  disabled={!isOwner}
                >
                  <SelectTrigger
                    id="threshold-select"
                    className="w-48"
                    data-testid="threshold-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THRESHOLD_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={String(o.value)}>
                        {t(o.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("settings.offlineThresholdHint")}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="undo-duration-select">{t("settings.undoDuration")}</Label>
                <Select
                  value={String(undoDuration)}
                  onValueChange={(v) => setUndoDuration(parseInt(v, 10))}
                  disabled={!isOwner}
                >
                  <SelectTrigger id="undo-duration-select" className="w-48" data-testid="undo-duration-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UNDO_DURATION_OPTIONS.map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s}s
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("settings.undoDurationHint")}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Switch
                  id="email-toggle"
                  checked={emailEnabled}
                  onCheckedChange={setEmailEnabled}
                  disabled={!isOwner}
                  data-testid="email-alert-toggle"
                />
                <div>
                  <Label htmlFor="email-toggle" className="flex items-center gap-1.5 cursor-pointer">
                    <Mail size={14} />
                    {t("settings.emailAlerts")}
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("settings.emailAlertsHint")}
                  </p>
                </div>
              </div>

              {isOwner && (
                <Button
                  onClick={handleSave}
                  disabled={mutation.isPending}
                  data-testid="save-settings-button"
                >
                  {mutation.isPending ? t("common.saving") : t("settings.saveSettings")}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <MapPin size={18} />
            {t("settings.availableCountries")}
          </CardTitle>
          <CardDescription>
            {t("settings.availableCountriesDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : isOwner ? (
            <>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t("settings.availableCountriesSearch")}
                  value={countrySearch}
                  onChange={(e) => setCountrySearch(e.target.value)}
                  className="pl-8"
                  data-testid="country-search-input"
                />
              </div>
              <div
                className="border rounded-md overflow-y-auto max-h-64 divide-y"
                data-testid="country-checklist"
              >
                {filteredCatalogue.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted-foreground">
                    {t("settings.availableCountriesNone")}
                  </p>
                ) : (
                  filteredCatalogue.map((entry) => {
                    const upperCode = entry.code ? entry.code.toUpperCase() : null;
                    const summary = upperCode ? deliveryByCode.get(upperCode) : undefined;
                    return (
                      <CountryChecklistRow
                        key={entry.name}
                        entry={entry}
                        checked={selectedCountries.has(entry.name)}
                        onToggle={() => toggleCountry(entry.name)}
                        onUpload={(objectPath) => {
                          if (entry.code) {
                            flagOverrideMutation.mutate({ code: entry.code, data: { object_path: objectPath } });
                          }
                        }}
                        onRemove={() => {
                          if (entry.code) flagRemoveMutation.mutate({ code: entry.code });
                        }}
                        isMutating={
                          flagOverrideMutation.isPending || flagRemoveMutation.isPending
                        }
                        deliveryActive={summary?.delivery_active ?? false}
                        activeCitiesCount={summary?.active_cities_count ?? 0}
                        onToggleDelivery={(next) => {
                          if (upperCode) {
                            deliveryToggleMutation.mutate({ code: upperCode, active: next });
                          }
                        }}
                        deliveryMutating={deliveryToggleMutation.isPending}
                      />
                    );
                  })
                )}
              </div>
              {selectedCountries.size === 0 && (
                <p
                  className="text-xs text-destructive"
                  data-testid="no-countries-hint"
                >
                  {t("settings.selectAtLeastOneCountry")}
                </p>
              )}

              {orderedDeliveryCodes.length > 0 && (
                <div className="space-y-2" data-testid="delivery-country-order">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t("settings.deliveryCountryOrder")}
                  </p>
                  <DndContext
                    sensors={countrySensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleCountryDragEnd}
                  >
                    <SortableContext
                      items={orderedDeliveryCodes}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="rounded-md border border-border divide-y">
                        {orderedDeliveryCodes.map((code) => {
                          const summary = deliveryByCode.get(code);
                          const entry = catalogue.find(
                            (c) => c.code?.toUpperCase() === code,
                          );
                          if (!summary || !entry) return null;
                          return (
                            <SortableDeliveryCountryRow
                              key={code}
                              id={code}
                              name={summary.name}
                              flagImageUrl={entry.flagImageUrl}
                              code={code}
                            />
                          );
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.deliveryCountryOrderHint")}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {selectedCountries.size} selected
                </p>
                <Button
                  onClick={handleSaveCountries}
                  disabled={countriesMutation.isPending || selectedCountries.size === 0}
                  data-testid="save-countries-button"
                >
                  {countriesMutation.isPending ? t("common.saving") : t("settings.saveCountries")}
                </Button>
              </div>
            </>
          ) : (
            <div data-testid="countries-read-only">
              <p className="text-sm text-muted-foreground mb-3">
                {t("settings.availableCountriesReadOnly")}
              </p>
              {selectedCountries.size === 0 ? (
                <p className="text-sm text-muted-foreground italic">
                  {t("settings.noCountriesSelected")}
                </p>
              ) : (
                <ul className="space-y-1">
                  {Array.from(selectedCountries).sort().map((c) => {
                    const detail = catalogue.find((e) => e.name === c);
                    return (
                      <li key={c} className="flex items-center gap-2 text-sm">
                        <FlagImage
                          country={c}
                          url={detail?.flagImageUrl}
                          size={14}
                        />
                        {c}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Settings2 size={18} />
            {t("settings.aboutAlerts")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>{t("settings.aboutAlertsText1")}</p>
          <p>{t("settings.aboutAlertsText2")}</p>
        </CardContent>
      </Card>

      <ExchangeRatesCard isOwner={isOwner} />

      {isOwner && <OmniTagsCard />}

      {isOwner && <AiSettingsCard />}

      {isOwner && <DeliverySettingsCard />}

      {isOwner && <DeliveryWebhookCard currentSettings={data} />}

      {isOwner && <TrustpilotCard currentSettings={data} />}

      {isOwner && <RespondIoSettingsCard currentSettings={data} />}

      {isOwner && <WorkspaceSlugCard currentSlug={data?.workspace_slug ?? null} />}

      {isOwner && <StorefrontWorkspaceCard />}

      {isOwner && <MarketplaceAliasesLinkCard />}

      {isOwner && <TaxRulesLinkCard />}

      {isOwner && <SuppliersSettingsCard />}

      {isOwner && <BranchPrintersCard />}

      {isOwner && <WeeklyDigestCard />}

    </div>
  );
}

function TaxRulesLinkCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Receipt size={18} />
          Tax Rules
        </CardTitle>
        <CardDescription>
          Define location-based tax rates by tax category and country. Applied to purchase orders and base item costs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <a href="/dashboard/tax-rules" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          Manage Tax Rules <ExternalLink size={13} />
        </a>
      </CardContent>
    </Card>
  );
}

type ExchangeRateSettings = {
  default_markup_percentage: number;
  rounding_rule: string;
  base_currency: string;
  updated_at: string | null;
};

type ExchangeRateRow = {
  base_currency: string;
  target_currency: string;
  rate: number;
  fetched_at: string;
  provider?: string;
};

type ExchangeRatesData = {
  base_currency: string;
  rates: ExchangeRateRow[];
  last_fetched_at: string | null;
};

const ROUNDING_RULES = [
  { value: "round_up_whole", label: "Round up to nearest whole number" },
  { value: "round_nearest_whole", label: "Round to nearest whole number" },
  { value: "none", label: "No rounding (exact amount)" },
];

function formatRelativeTime(isoString: string, now: Date): string {
  const date = new Date(isoString);
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
}

function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const BASE_CURRENCIES = [
  { value: "USD", label: "USD – US Dollar" },
  { value: "AED", label: "AED – UAE Dirham" },
  { value: "SAR", label: "SAR – Saudi Riyal" },
  { value: "QAR", label: "QAR – Qatari Riyal" },
  { value: "KWD", label: "KWD – Kuwaiti Dinar" },
  { value: "BHD", label: "BHD – Bahraini Dinar" },
  { value: "OMR", label: "OMR – Omani Rial" },
  { value: "EUR", label: "EUR – Euro" },
  { value: "GBP", label: "GBP – British Pound" },
];

function ExchangeRatesCard({ isOwner }: { isOwner: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = useNow();

  const { data: ratesData, isLoading: ratesLoading } = useQuery<ExchangeRatesData>({
    queryKey: ["exchange-rates"],
    queryFn: () => apiFetch<ExchangeRatesData>("/api/exchange-rates"),
  });

  const { data: settingsData, isLoading: settingsLoading } = useQuery<ExchangeRateSettings>({
    queryKey: ["exchange-rate-settings"],
    queryFn: () => apiFetch<ExchangeRateSettings>("/api/exchange-rate-settings"),
  });

  const [markupPct, setMarkupPct] = useState<string>("");
  const [roundingRule, setRoundingRule] = useState<string>("round_up_whole");
  const [baseCurrency, setBaseCurrency] = useState<string>("USD");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const prevBaseCurrencyRef = useRef<string | null>(null);

  useEffect(() => {
    if (settingsData) {
      setMarkupPct(String(settingsData.default_markup_percentage ?? 0));
      setRoundingRule(settingsData.rounding_rule ?? "round_up_whole");
      setBaseCurrency(settingsData.base_currency ?? "USD");
      setSettingsDirty(false);
    }
  }, [settingsData]);

  const refreshMutation = useMutation({
    mutationFn: () =>
      apiFetch<ExchangeRatesData>("/api/exchange-rates/refresh", { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["exchange-rates"], data);
      toast({ title: "Exchange rates refreshed successfully" });
    },
    onError: (err) => {
      toast({ title: "Failed to refresh rates", description: String(err.message), variant: "destructive" });
    },
  });

  const saveSettingsMutation = useMutation({
    mutationFn: () => {
      prevBaseCurrencyRef.current = settingsData?.base_currency ?? null;
      return apiFetch<ExchangeRateSettings>("/api/exchange-rate-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_markup_percentage: parseFloat(markupPct) || 0,
          rounding_rule: roundingRule,
          base_currency: baseCurrency,
        }),
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["exchange-rate-settings"], data);
      queryClient.invalidateQueries({ queryKey: ["exchange-rates"] });
      setSettingsDirty(false);
      toast({ title: "Exchange rate settings saved" });
      if (prevBaseCurrencyRef.current !== null && prevBaseCurrencyRef.current !== data.base_currency) {
        refreshMutation.mutate();
      }
    },
    onError: (err) => {
      toast({ title: "Failed to save settings", description: String(err.message), variant: "destructive" });
    },
  });

  const [manualCurrency, setManualCurrency] = useState("");
  const [manualRate, setManualRate] = useState("");

  const addManualMutation = useMutation({
    mutationFn: ({ currency, rate }: { currency: string; rate: number }) =>
      apiFetch("/api/exchange-rates/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency, rate }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exchange-rates"] });
      setManualCurrency("");
      setManualRate("");
      toast({ title: "Manual rate saved" });
    },
    onError: (err) => {
      toast({ title: "Failed to save manual rate", description: String(err.message), variant: "destructive" });
    },
  });

  const deleteManualMutation = useMutation({
    mutationFn: (currency: string) =>
      apiFetch(`/api/exchange-rates/manual/${encodeURIComponent(currency)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exchange-rates"] });
      toast({ title: "Manual rate removed" });
    },
    onError: (err) => {
      toast({ title: "Failed to remove manual rate", description: String(err.message), variant: "destructive" });
    },
  });

  const activeBase = ratesData?.base_currency ?? settingsData?.base_currency ?? "USD";
  const hasStoredRatesForSelected = (ratesData?.rates ?? []).some(
    (r) => r.base_currency === baseCurrency,
  );
  const showNoRatesWarning = baseCurrency !== activeBase && !hasStoredRatesForSelected;
  const displayedCurrencies = BASE_CURRENCIES.map((c) => c.value).filter((c) => c !== activeBase);
  const displayRates = (ratesData?.rates ?? [])
    .filter((r) => displayedCurrencies.includes(r.target_currency) && r.provider !== "manual")
    .sort((a, b) => displayedCurrencies.indexOf(a.target_currency) - displayedCurrencies.indexOf(b.target_currency));

  const manualRates = (ratesData?.rates ?? []).filter((r) => r.provider === "manual");

  const lastFetchedAt = ratesData?.last_fetched_at ?? null;
  const lastFetchedRelative = lastFetchedAt ? formatRelativeTime(lastFetchedAt, now) : null;

  const ratesStale = !ratesLoading && (
    !ratesData?.last_fetched_at ||
    Date.now() - new Date(ratesData.last_fetched_at).getTime() > 24 * 60 * 60 * 1000
  );

  return (
    <Card data-testid="card-exchange-rates">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <ArrowRightLeft size={18} />
          Exchange Rates
        </CardTitle>
        <CardDescription>
          Live exchange rates used for currency conversion in Payment Links. Rates are fetched from exchangerate-api.com twice daily.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Stale rates warning */}
        {ratesStale && (
          <div
            className="flex items-start gap-2 rounded-md border border-yellow-400/60 bg-yellow-50 px-3 py-2.5 text-sm text-yellow-800 dark:border-yellow-500/40 dark:bg-yellow-950/30 dark:text-yellow-300"
            data-testid="exchange-rates-stale-warning"
            role="alert"
          >
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
            <span>
              Exchange rates haven&apos;t been refreshed in over 24 hours.{" "}
              {isOwner ? (
                <>Click &ldquo;<strong>Refresh now</strong>&rdquo; to get the latest rates.</>
              ) : (
                <>Ask your workspace owner to refresh the rates.</>
              )}
            </span>
          </div>
        )}

        {/* Rate grid */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs text-muted-foreground font-medium">
                Current rates (base: {activeBase})
              </p>
              {lastFetchedRelative && (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="text-last-fetched-at"
                  title={lastFetchedAt ? new Date(lastFetchedAt).toLocaleString() : undefined}
                >
                  Last updated: {lastFetchedRelative}
                </span>
              )}
            </div>
            {isOwner && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs"
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                data-testid="button-refresh-rates"
              >
                <RefreshCw size={12} className={refreshMutation.isPending ? "animate-spin" : ""} />
                {refreshMutation.isPending ? "Refreshing…" : "Refresh now"}
              </Button>
            )}
          </div>

          {ratesLoading ? (
            <div className="text-sm text-muted-foreground">Loading rates…</div>
          ) : displayRates.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">
              No rates available yet. Click "Refresh now" to fetch the latest rates.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {displayRates.map((r) => (
                <div key={r.target_currency} className="rounded-md border border-border bg-secondary/30 px-3 py-2">
                  <p className="text-xs text-muted-foreground font-medium">{r.target_currency}</p>
                  <p className="text-sm font-semibold">{Number(r.rate).toFixed(4)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Settings section */}
        <div className="border-t border-border pt-4 space-y-4">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Conversion Settings</p>

          <div className="space-y-1.5">
            <Label htmlFor="er-base-currency">Base Currency</Label>
            <Select
              value={baseCurrency}
              onValueChange={(v) => {
                setBaseCurrency(v);
                setSettingsDirty(true);
              }}
              disabled={!isOwner || settingsLoading}
            >
              <SelectTrigger id="er-base-currency" className="w-72" data-testid="select-base-currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BASE_CURRENCIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Rates are fetched and stored with this currency as the base. Changing this will automatically refresh rates when saved.
            </p>
            {showNoRatesWarning && (
              <div
                className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                data-testid="no-rates-warning"
                role="status"
              >
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>No rates stored yet for <strong>{baseCurrency}</strong> — they will be fetched automatically on save.</span>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="er-markup">Default Markup (%)</Label>
            {isOwner ? (
              <div className="flex items-center gap-2">
                <Input
                  id="er-markup"
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  className="w-32"
                  value={markupPct}
                  disabled={settingsLoading}
                  onChange={(e) => {
                    setMarkupPct(e.target.value);
                    setSettingsDirty(true);
                  }}
                  data-testid="input-exchange-markup"
                />
                <span className="text-sm text-muted-foreground">Added on top of the official rate</span>
              </div>
            ) : (
              <p className="text-sm font-medium" data-testid="text-exchange-markup">
                {markupPct}%
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="er-rounding">Rounding Rule</Label>
            {isOwner ? (
              <>
                <Select
                  value={roundingRule}
                  onValueChange={(v) => {
                    setRoundingRule(v);
                    setSettingsDirty(true);
                  }}
                  disabled={settingsLoading}
                >
                  <SelectTrigger id="er-rounding" className="w-72" data-testid="select-rounding-rule">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROUNDING_RULES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Applied to converted amounts in Payment Links to create cleaner "luxury" prices.
                </p>
              </>
            ) : (
              <p className="text-sm font-medium" data-testid="text-rounding-rule">
                {ROUNDING_RULES.find((r) => r.value === roundingRule)?.label ?? roundingRule}
              </p>
            )}
          </div>

          {isOwner && (
            <Button
              size="sm"
              className="gap-1"
              onClick={() => saveSettingsMutation.mutate()}
              disabled={!settingsDirty || saveSettingsMutation.isPending || refreshMutation.isPending}
              data-testid="button-save-er-settings"
            >
              {refreshMutation.isPending ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  Refreshing rates…
                </>
              ) : saveSettingsMutation.isPending ? (
                <>
                  <Save size={14} />
                  Saving…
                </>
              ) : (
                <>
                  <Save size={14} />
                  Save settings
                </>
              )}
            </Button>
          )}
        </div>

        {/* Manual Rates section */}
        <div className="border-t border-border pt-4 space-y-3" data-testid="manual-rates-section">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Manual Rates</p>
          <p className="text-xs text-muted-foreground">
            Override rates for currencies not covered by the provider (e.g. LBP). Enter how many units of the currency equal 1 USD.
            Manual rates are never overwritten by automatic refreshes.
          </p>

          {/* Existing manual rates list */}
          {manualRates.length > 0 && (
            <div className="space-y-1.5" data-testid="manual-rates-list">
              {manualRates.map((r) => {
                const humanRate = r.rate > 0 ? (1 / r.rate) : 0;
                const formatted = humanRate >= 1
                  ? humanRate.toLocaleString(undefined, { maximumFractionDigits: 4 })
                  : humanRate.toFixed(6);
                return (
                  <div
                    key={r.target_currency}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/30 px-3 py-2"
                    data-testid={`manual-rate-row-${r.target_currency}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{r.target_currency}</span>
                      <Badge variant="secondary" className="text-xs py-0">Manual</Badge>
                      <span className="text-xs text-muted-foreground">1 USD = {formatted} {r.target_currency}</span>
                    </div>
                    {isOwner && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteManualMutation.mutate(r.target_currency)}
                        disabled={deleteManualMutation.isPending}
                        data-testid={`delete-manual-rate-${r.target_currency}`}
                        aria-label={`Remove manual rate for ${r.target_currency}`}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {manualRates.length === 0 && !ratesLoading && (
            <p className="text-sm text-muted-foreground italic" data-testid="no-manual-rates">
              No manual rates configured.
            </p>
          )}

          {/* Add form — owners only */}
          {isOwner && (
            <div className="flex items-end gap-2 flex-wrap" data-testid="manual-rate-form">
              <div className="space-y-1">
                <Label htmlFor="manual-rate-currency" className="text-xs">Currency code</Label>
                <Input
                  id="manual-rate-currency"
                  placeholder="e.g. LBP"
                  value={manualCurrency}
                  onChange={(e) => setManualCurrency(e.target.value.toUpperCase())}
                  className="w-28 uppercase"
                  maxLength={8}
                  data-testid="input-manual-rate-currency"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="manual-rate-value" className="text-xs">1 USD =</Label>
                <Input
                  id="manual-rate-value"
                  type="number"
                  min={0}
                  step="any"
                  placeholder="e.g. 89500"
                  value={manualRate}
                  onChange={(e) => setManualRate(e.target.value)}
                  className="w-40"
                  data-testid="input-manual-rate-value"
                />
              </div>
              <Button
                size="sm"
                className="gap-1"
                onClick={() => {
                  const cur = manualCurrency.trim().toUpperCase();
                  const rate = parseFloat(manualRate);
                  if (!cur || !Number.isFinite(rate) || rate <= 0) {
                    toast({ title: "Enter a valid currency code and rate", variant: "destructive" });
                    return;
                  }
                  addManualMutation.mutate({ currency: cur, rate });
                }}
                disabled={addManualMutation.isPending || !manualCurrency.trim() || !manualRate.trim()}
                data-testid="button-add-manual-rate"
              >
                <Plus size={14} />
                {addManualMutation.isPending ? "Saving…" : "Add"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CountryChecklistRow({
  entry,
  checked,
  onToggle,
  onUpload,
  onRemove,
  isMutating,
  deliveryActive,
  activeCitiesCount,
  onToggleDelivery,
  deliveryMutating,
}: {
  entry: ResolvedCountry;
  checked: boolean;
  onToggle: () => void;
  onUpload: (objectPath: string) => void;
  onRemove: () => void;
  isMutating: boolean;
  deliveryActive: boolean;
  activeCitiesCount: number;
  onToggleDelivery: (next: boolean) => void;
  deliveryMutating: boolean;
}) {
  const { t } = useTranslation();
  const upperCode = entry.code ? entry.code.toUpperCase() : null;
  const meta = upperCode ? getCountryMetadata(entry.name) : null;
  const hasOverride = Boolean(
    entry.code &&
      entry.flagImageUrl &&
      entry.flagImageUrl !== getDefaultFlagUrl(entry.code),
  );
  const { uploadFile, isUploading } = useUpload({
    getAuthToken: getClerkToken,
    onSuccess: (r) => onUpload(r.objectPath),
  });
  const inputId = `flag-upload-${entry.code ?? entry.name.replace(/\s+/g, "-")}`;
  return (
    <div className="flex items-center gap-3 px-4 py-2 hover:bg-secondary/50 text-sm">
      <label className="flex flex-1 items-center gap-3 cursor-pointer">
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          data-testid={`country-checkbox-${entry.name.replace(/\s+/g, "-")}`}
        />
        <FlagImage
          country={entry.name}
          url={entry.flagImageUrl}
          size={24}
          className="shrink-0"
        />
        <span className="flex-1 flex items-center gap-2">
          {entry.name}
          {upperCode && (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`country-code-${upperCode}`}
            >
              ({upperCode})
            </span>
          )}
          {meta?.currency && (
            <span className="text-xs text-muted-foreground">· {meta.currency}</span>
          )}
        </span>
      </label>
      {upperCode && checked && (
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={deliveryActive}
            disabled={deliveryMutating}
            onCheckedChange={onToggleDelivery}
            data-testid={`delivery-toggle-${upperCode}`}
            aria-label={t("settings.deliveryActive")}
          />
          {deliveryActive && (
            <span className="text-xs text-muted-foreground" data-testid={`active-cities-count-${upperCode}`}>
              {t("settings.deliveryActiveCities", { count: activeCitiesCount })}
            </span>
          )}
        </div>
      )}
      {entry.code && checked && (
        <div className="flex items-center gap-1 shrink-0">
          <input
            id={inputId}
            type="file"
            accept="image/svg+xml,image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid={`flag-upload-input-${entry.code}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void uploadFile(file);
                e.currentTarget.value = "";
              }
            }}
          />
          <Button
            asChild
            size="sm"
            variant="outline"
            disabled={isUploading || isMutating}
          >
            <label htmlFor={inputId} className="cursor-pointer">
              {isUploading
                ? "…"
                : hasOverride
                  ? "Replace"
                  : "Upload"}
            </label>
          </Button>
          {hasOverride && (
            <Button
              size="sm"
              variant="ghost"
              disabled={isMutating}
              onClick={onRemove}
              data-testid={`flag-remove-${entry.code}`}
            >
              <X size={12} />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SortableDeliveryCountryRow({
  id,
  name,
  flagImageUrl,
  code,
}: {
  id: string;
  name: string;
  flagImageUrl: string | null;
  code: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm bg-background",
        isDragging && "opacity-50 z-10 shadow-md",
      )}
      data-testid={`delivery-order-row-${code}`}
    >
      <button
        type="button"
        className="text-muted-foreground cursor-grab active:cursor-grabbing touch-none"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>
      <FlagImage country={name} url={flagImageUrl} size={18} className="shrink-0" />
      <span className="flex-1">{name}</span>
      <span className="text-xs text-muted-foreground">{code}</span>
    </div>
  );
}


type AiSettings = {
  has_api_key: boolean;
  is_integration_active: boolean;
  provider: "live" | "mock";
  provider_source: "workspace_key" | "integration" | "mock";
  auto_reply_enabled: boolean;
  confidence_threshold: number;
};

function AiSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<AiSettings>({
    queryKey: ["omni-ai-settings"],
    queryFn: () => apiFetch<AiSettings>("/api/omnichannel/ai/settings"),
  });

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [autoReply, setAutoReply] = useState(false);
  const [threshold, setThreshold] = useState(0.75);

  useEffect(() => {
    if (data) {
      setAutoReply(data.auto_reply_enabled);
      setThreshold(data.confidence_threshold);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: {
      openai_api_key?: string;
      clear_api_key?: boolean;
      auto_reply_enabled: boolean;
      confidence_threshold: number;
    }) =>
      apiFetch<AiSettings>("/api/omnichannel/ai/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["omni-ai-settings"], saved);
      setApiKeyInput("");
      toast({ title: "AI settings saved" });
    },
    onError: () => {
      toast({ title: "Failed to save AI settings", variant: "destructive" });
    },
  });

  function handleSave() {
    const payload: Parameters<typeof saveMutation.mutate>[0] = {
      auto_reply_enabled: autoReply,
      confidence_threshold: threshold,
    };
    if (apiKeyInput.trim().length > 0) {
      payload.openai_api_key = apiKeyInput.trim();
    }
    saveMutation.mutate(payload);
  }

  function handleClearKey() {
    saveMutation.mutate({
      clear_api_key: true,
      auto_reply_enabled: autoReply,
      confidence_threshold: threshold,
    });
  }

  const thresholdPct = Math.round(threshold * 100);

  return (
    <Card data-testid="card-ai-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Bot size={18} />
          AI Settings
          {!isLoading && data && (
            data.provider === "live" ? (
              <span
                className="ml-1 inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400"
                data-testid="ai-provider-status-live"
                title={
                  data.provider_source === "workspace_key"
                    ? "Using your workspace OpenAI API key"
                    : "Using the Replit-managed OpenAI integration"
                }
              >
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                Live AI
                <span className="font-normal opacity-75">
                  {data.provider_source === "workspace_key" ? "· workspace key" : "· Replit integration"}
                </span>
              </span>
            ) : (
              <span
                className="ml-1 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                data-testid="ai-provider-status-mock"
                title="No API key or integration configured — AI responses are mocked"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
                Mock AI
              </span>
            )
          )}
        </CardTitle>
        <CardDescription>
          Connect an OpenAI API key to enable live AI-powered replies and summaries in the inbox.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor="ai-api-key">OpenAI API key</Label>
                {data?.has_api_key ? (
                  <span
                    className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"
                    data-testid="ai-api-key-status-connected"
                  >
                    <CheckCircle2 size={12} />
                    Connected
                  </span>
                ) : (
                  <span
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid="ai-api-key-status-none"
                  >
                    <Circle size={12} />
                    Not set — using mock AI
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-api-key"
                    type={showKey ? "text" : "password"}
                    placeholder={data?.has_api_key ? "Enter a new key to replace the existing one" : "sk-…"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className="pr-10"
                    data-testid="input-ai-api-key"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {data?.has_api_key && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleClearKey}
                    disabled={saveMutation.isPending}
                    data-testid="button-clear-ai-api-key"
                  >
                    Remove key
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Your key is stored securely. It overrides the Replit-managed OpenAI integration for this workspace.
              </p>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center gap-3">
                <Switch
                  id="ai-auto-reply"
                  checked={autoReply}
                  onCheckedChange={setAutoReply}
                  data-testid="toggle-ai-auto-reply"
                />
                <div>
                  <Label htmlFor="ai-auto-reply" className="cursor-pointer">Enable auto-reply</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Automatically send AI replies when confidence exceeds the threshold and the conversation is set to auto-send.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai-threshold">
                  Confidence threshold — <span className="font-semibold" data-testid="ai-threshold-value">{thresholdPct}%</span>
                </Label>
                <input
                  id="ai-threshold"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={threshold}
                  onChange={(e) => setThreshold(parseFloat(e.target.value))}
                  className="w-full accent-primary"
                  data-testid="slider-ai-threshold"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>0% (always)</span>
                  <span>100% (never)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  AI replies below this confidence level will be suggested to agents but not auto-sent.
                </p>
              </div>
            </div>

            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              data-testid="button-save-ai-settings"
            >
              {saveMutation.isPending ? "Saving…" : "Save AI settings"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

type BrandOption = { id: number; name: string };
type LocationOption = { id: number; name: string };

const MARKETPLACE_OPTIONS = ["toters", "talabat", "careem", "deliveroo", "noon"];

function MarketplaceAliasesCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: aliasesData, isLoading } = useListMarketplaceBrandAliases();

  const { data: brandsData } = useQuery<{ brands: BrandOption[] }>({
    queryKey: ["brands-list"],
    queryFn: () => apiFetch<{ brands: BrandOption[] }>("/api/brands"),
  });

  const { data: locationsData } = useQuery<{ locations: LocationOption[] }>({
    queryKey: ["locations-list"],
    queryFn: () => apiFetch<{ locations: LocationOption[] }>("/api/locations"),
  });

  const brands = brandsData?.brands ?? [];
  const locations = locationsData?.locations ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [marketplace, setMarketplace] = useState("");
  const [marketplaceCustom, setMarketplaceCustom] = useState("");
  const [aliasName, setAliasName] = useState("");
  const [brandId, setBrandId] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("none");

  function resetForm() {
    setEditId(null);
    setMarketplace("");
    setMarketplaceCustom("");
    setAliasName("");
    setBrandId("");
    setLocationId("");
    setFormOpen(false);
  }

  function openAdd() {
    resetForm();
    setFormOpen(true);
  }

  function openEdit(alias: NonNullable<typeof aliasesData>["aliases"][number]) {
    setEditId(alias.id);
    const knownMp = MARKETPLACE_OPTIONS.includes(alias.marketplace);
    setMarketplace(knownMp ? alias.marketplace : "__custom__");
    setMarketplaceCustom(knownMp ? "" : alias.marketplace);
    setAliasName(alias.alias_name);
    setBrandId(String(alias.brand_id ?? ""));
    setLocationId(alias.location_id ? String(alias.location_id) : "");
    setFormOpen(true);
  }

  const createMutation = useCreateMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: editId ? "Alias updated" : "Alias added" });
        resetForm();
      },
      onError: () => {
        toast({ title: "Failed to save alias", variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeleteMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Alias deleted" });
      },
      onError: () => {
        toast({ title: "Failed to delete alias", variant: "destructive" });
      },
    },
  });

  function handleSubmit() {
    const resolvedMarketplace = marketplace === "__custom__" ? marketplaceCustom.trim() : marketplace.trim();
    if (!resolvedMarketplace || !aliasName.trim() || !brandId) {
      toast({ title: "Marketplace, alias name, and brand are required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      data: {
        marketplace: resolvedMarketplace,
        alias_name: aliasName.trim(),
        brand_id: parseInt(brandId, 10),
        location_id: locationId && locationId !== "none" ? parseInt(locationId, 10) : undefined,
      },
    });
  }

  const aliases = aliasesData?.aliases ?? [];

  return (
    <Card data-testid="marketplace-aliases-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <ArrowRightLeft size={18} />
              Marketplace Aliases
            </CardTitle>
            <CardDescription className="text-sm mt-1">
              Map merchant names in imported marketplace reports to your internal brands and locations.
            </CardDescription>
          </div>
          {!formOpen && (
            <Button size="sm" onClick={openAdd} data-testid="add-alias-button">
              Add alias
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {formOpen && (
          <div className="border border-border rounded-md p-4 space-y-3 bg-muted/30">
            <p className="text-sm font-medium">{editId ? "Edit alias" : "New alias"}</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="alias-marketplace">Marketplace</Label>
                <Select value={marketplace} onValueChange={setMarketplace}>
                  <SelectTrigger id="alias-marketplace" data-testid="alias-marketplace-select">
                    <SelectValue placeholder="Select marketplace…" />
                  </SelectTrigger>
                  <SelectContent>
                    {MARKETPLACE_OPTIONS.map((mp) => (
                      <SelectItem key={mp} value={mp} className="capitalize">{mp}</SelectItem>
                    ))}
                    <SelectItem value="__custom__">Other…</SelectItem>
                  </SelectContent>
                </Select>
                {marketplace === "__custom__" && (
                  <Input
                    placeholder="e.g. hungerstation"
                    value={marketplaceCustom}
                    onChange={(e) => setMarketplaceCustom(e.target.value)}
                    data-testid="alias-marketplace-custom"
                    className="mt-1.5"
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="alias-name">Alias name (merchant name in report)</Label>
                <Input
                  id="alias-name"
                  placeholder="e.g. Brand XYZ - Hamra"
                  value={aliasName}
                  onChange={(e) => setAliasName(e.target.value)}
                  data-testid="alias-name-input"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="alias-brand">Brand</Label>
                <Select value={brandId} onValueChange={setBrandId}>
                  <SelectTrigger id="alias-brand" data-testid="alias-brand-select">
                    <SelectValue placeholder="Select brand…" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="alias-location">Location (optional)</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger id="alias-location" data-testid="alias-location-select">
                    <SelectValue placeholder="Any location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Any location</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="alias-save-button"
              >
                {createMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button size="sm" variant="outline" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading aliases…</p>
        ) : aliases.length === 0 ? (
          <p className="text-sm text-muted-foreground italic" data-testid="no-aliases-message">
            No aliases configured yet.
          </p>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm" data-testid="aliases-table">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Marketplace</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Alias name</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Brand</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Location</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Last used</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {aliases.map((alias) => (
                  <tr
                    key={alias.id}
                    className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                    data-testid={`alias-row-${alias.id}`}
                  >
                    <td className="px-3 py-2 capitalize font-medium">{alias.marketplace}</td>
                    <td className="px-3 py-2 text-muted-foreground">{alias.alias_name}</td>
                    <td className="px-3 py-2">{alias.brand_name ?? <span className="text-muted-foreground italic">—</span>}</td>
                    <td className="px-3 py-2">{alias.location_name ?? <span className="text-muted-foreground italic">Any</span>}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {alias.last_used_at
                        ? new Date(alias.last_used_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
                        : <span className="italic">Never</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          onClick={() => openEdit(alias)}
                          data-testid={`edit-alias-${alias.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={() => deleteMutation.mutate({ id: alias.id })}
                          disabled={deleteMutation.isPending}
                          data-testid={`delete-alias-${alias.id}`}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MarketplaceAliasesLinkCard() {
  return (
    <Card data-testid="marketplace-aliases-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <ArrowRightLeft size={18} />
              Statement Aliases
            </CardTitle>
            <CardDescription className="mt-1 text-sm">
              Manage marketplace statement-name mappings next to the canonical brands they resolve to.
            </CardDescription>
          </div>
          <Link href="/brands?tab=statement-aliases">
            <Button size="sm">Manage aliases</Button>
          </Link>
        </div>
      </CardHeader>
    </Card>
  );
}

function WorkspaceSlugCard({ currentSlug }: { currentSlug: string | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [slug, setSlug] = useState(currentSlug ?? "");
  const [dirty, setDirty] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setSlug(currentSlug ?? "");
    setDirty(false);
    setValidationError(null);
  }, [currentSlug]);

  const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

  function validateSlug(value: string): string | null {
    if (value === "") return null;
    if (value.length > 80) return t("settings.workspaceSlugTooLong");
    if (!SLUG_PATTERN.test(value)) return t("settings.workspaceSlugInvalid");
    return null;
  }

  function handleChange(value: string) {
    const lower = value.toLowerCase();
    setSlug(lower);
    setDirty(true);
    setValidationError(validateSlug(lower));
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ workspace_slug: string | null }>("/api/settings/workspace-slug", {
        method: "PATCH",
        body: JSON.stringify({ workspace_slug: slug.trim() || null }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData<WorkspaceSettings>(["workspace-settings"], (prev) =>
        prev ? { ...prev, workspace_slug: data.workspace_slug } : prev,
      );
      setDirty(false);
      toast({ title: t("settings.workspaceSlugSaved"), description: t("settings.workspaceSlugSavedDesc") });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("taken")) {
        setValidationError(t("settings.workspaceSlugTaken"));
      } else {
        toast({ title: t("settings.workspaceSlugSaveFailed"), variant: "destructive" });
      }
    },
  });

  const publicUrl = slug.trim()
    ? `${window.location.origin}?workspace=${encodeURIComponent(slug.trim())}`
    : null;

  const canSave = dirty && !validationError && !saveMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Globe size={18} />
          {t("settings.workspaceSlug")}
        </CardTitle>
        <CardDescription>{t("settings.workspaceSlugDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="workspace-slug-input">{t("settings.workspaceSlugLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id="workspace-slug-input"
              data-testid="workspace-slug-input"
              value={slug}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={t("settings.workspaceSlugPlaceholder")}
              className="flex-1"
              maxLength={80}
            />
            {slug && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { setSlug(""); setDirty(true); setValidationError(null); }}
                aria-label={t("settings.workspaceSlugClear")}
              >
                <X size={16} />
              </Button>
            )}
          </div>
          {validationError && (
            <p className="text-xs text-destructive" data-testid="workspace-slug-error">{validationError}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("settings.workspaceSlugHint")}</p>
        </div>

        {publicUrl && (
          <div
            className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground break-all"
            data-testid="workspace-slug-public-url"
          >
            <Info size={13} className="shrink-0 text-muted-foreground" />
            {publicUrl}
          </div>
        )}

        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={!canSave}
          data-testid="workspace-slug-save"
        >
          {saveMutation.isPending ? t("common.saving") : t("settings.workspaceSlugSave")}
        </Button>
      </CardContent>
    </Card>
  );
}

type StorefrontWorkspaceStatus = {
  connected: boolean;
  configured_via: "setting" | "env" | null;
  is_current_workspace: boolean;
};

function StorefrontWorkspaceCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["storefront-workspace"],
    queryFn: () => apiFetch<StorefrontWorkspaceStatus>("/api/admin/storefront-workspace"),
  });

  const connectMutation = useMutation({
    mutationFn: () =>
      apiFetch<StorefrontWorkspaceStatus>("/api/admin/storefront-workspace", { method: "PUT" }),
    onSuccess: (status) => {
      queryClient.setQueryData(["storefront-workspace"], status);
      toast({ title: t("settings.storefrontConnected") });
    },
    onError: () => toast({ title: t("settings.storefrontUpdateFailed"), variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      apiFetch<StorefrontWorkspaceStatus>("/api/admin/storefront-workspace", { method: "DELETE" }),
    onSuccess: (status) => {
      queryClient.setQueryData(["storefront-workspace"], status);
      toast({ title: t("settings.storefrontDisconnected") });
    },
    onError: () => toast({ title: t("settings.storefrontUpdateFailed"), variant: "destructive" }),
  });

  const busy = connectMutation.isPending || disconnectMutation.isPending;

  let statusText: string;
  if (!data?.connected) {
    statusText = t("settings.storefrontStatusNone");
  } else if (data.is_current_workspace) {
    statusText = t("settings.storefrontStatusThis");
  } else if (data.configured_via === "env") {
    statusText = t("settings.storefrontStatusEnv");
  } else {
    statusText = t("settings.storefrontStatusOther");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Store size={18} />
          {t("settings.storefrontWorkspace")}
        </CardTitle>
        <CardDescription>{t("settings.storefrontWorkspaceDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          data-testid="storefront-workspace-status"
        >
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{isLoading ? t("common.loading") : statusText}</span>
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => connectMutation.mutate()}
            disabled={busy || isLoading || data?.is_current_workspace}
            data-testid="storefront-workspace-connect"
          >
            {connectMutation.isPending ? t("common.saving") : t("settings.storefrontConnect")}
          </Button>
          {data?.is_current_workspace && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => disconnectMutation.mutate()}
              disabled={busy}
              data-testid="storefront-workspace-disconnect"
            >
              {disconnectMutation.isPending ? t("common.saving") : t("settings.storefrontDisconnect")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type DeliverySettings = {
  workspace_owner_id: string;
  standard_delivery_active: boolean;
  express_delivery_active: boolean;
  same_day_express_active: boolean;
  global_standard_fee: string | null;
  global_express_fee: string | null;
  global_free_delivery_threshold: string | null;
  global_express_free_threshold: string | null;
  updated_at: string;
};

function DeliverySettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const [stdActive, setStdActive] = useState(true);
  const [expActive, setExpActive] = useState(false);
  const [sameDayActive, setSameDayActive] = useState(false);
  const [globalStdFee, setGlobalStdFee] = useState("");
  const [globalExpFee, setGlobalExpFee] = useState("");
  const [globalFreeThr, setGlobalFreeThr] = useState("");
  const [globalExpFreeThr, setGlobalExpFreeThr] = useState("");

  const { data, isLoading } = useQuery<{ success: boolean; data: DeliverySettings }>({
    queryKey: ["delivery-settings"],
    queryFn: () => apiFetch("/api/settings/delivery"),
  });

  const settings = data?.data;

  function startEditing() {
    setStdActive(settings?.standard_delivery_active ?? true);
    setExpActive(settings?.express_delivery_active ?? false);
    setSameDayActive(settings?.same_day_express_active ?? false);
    setGlobalStdFee(settings?.global_standard_fee != null ? String(parseFloat(settings.global_standard_fee)) : "");
    setGlobalExpFee(settings?.global_express_fee != null ? String(parseFloat(settings.global_express_fee)) : "");
    setGlobalFreeThr(settings?.global_free_delivery_threshold != null ? String(parseFloat(settings.global_free_delivery_threshold)) : "");
    setGlobalExpFreeThr(settings?.global_express_free_threshold != null ? String(parseFloat(settings.global_express_free_threshold)) : "");
    setEditing(true);
  }

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ success: boolean; data: DeliverySettings }>("/api/settings/delivery", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (res) => {
      queryClient.setQueryData(["delivery-settings"], res);
      toast({ title: "Delivery settings saved" });
      setEditing(false);
    },
    onError: (err: unknown) => {
      toast({
        title: "Failed to save",
        description: err instanceof Error ? err.message : "Error",
        variant: "destructive",
      });
    },
  });

  function handleSave() {
    patchMutation.mutate({
      standard_delivery_active: stdActive,
      express_delivery_active: expActive,
      same_day_express_active: sameDayActive,
      global_standard_fee: globalStdFee !== "" ? parseFloat(globalStdFee) : null,
      global_express_fee: globalExpFee !== "" ? parseFloat(globalExpFee) : null,
      global_free_delivery_threshold: globalFreeThr !== "" ? parseFloat(globalFreeThr) : null,
      global_express_free_threshold: globalExpFreeThr !== "" ? parseFloat(globalExpFreeThr) : null,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Settings2 size={18} />
          Global Delivery Settings
        </CardTitle>
        <CardDescription>
          Configure global delivery availability toggles and default fees. These apply workspace-wide unless overridden at the city level.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !editing ? (
          <>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Delivery modes</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { label: "Standard delivery", value: settings?.standard_delivery_active },
                  { label: "Express delivery", value: settings?.express_delivery_active },
                  { label: "Same-day express", value: settings?.same_day_express_active },
                ].map(({ label, value }) => (
                  <div key={label} className="flex items-center gap-2 rounded-md border px-3 py-2 bg-card">
                    <span className={`w-2 h-2 rounded-full ${value ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                    <span className="text-sm">{label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{value ? "On" : "Off"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Default fees &amp; thresholds</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Standard fee</p>
                  <p className="font-medium text-sm">
                    {settings?.global_standard_fee != null ? `$${parseFloat(settings.global_standard_fee).toFixed(2)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Express fee</p>
                  <p className="font-medium text-sm">
                    {settings?.global_express_fee != null ? `$${parseFloat(settings.global_express_fee).toFixed(2)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Free standard above</p>
                  <p className="font-medium text-sm">
                    {settings?.global_free_delivery_threshold != null ? `$${parseFloat(settings.global_free_delivery_threshold).toFixed(2)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Free express above</p>
                  <p className="font-medium text-sm">
                    {settings?.global_express_free_threshold != null ? `$${parseFloat(settings.global_express_free_threshold).toFixed(2)}` : "—"}
                  </p>
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={startEditing} className="gap-1.5">
              <Save size={14} />
              Edit delivery settings
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Delivery modes</p>
              <div className="space-y-2">
                {[
                  { id: "ds-std", label: "Standard delivery active", value: stdActive, set: setStdActive },
                  { id: "ds-exp", label: "Express delivery active", value: expActive, set: setExpActive },
                  { id: "ds-sde", label: "Same-day express active", value: sameDayActive, set: setSameDayActive },
                ].map(({ id, label, value, set }) => (
                  <div key={id} className="flex items-center gap-3">
                    <Switch id={id} checked={value} onCheckedChange={set} />
                    <Label htmlFor={id}>{label}</Label>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Default fees &amp; thresholds</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Global standard fee ($)</Label>
                  <Input type="number" min="0" step="0.01" value={globalStdFee} onChange={(e) => setGlobalStdFee(e.target.value)} placeholder="—" />
                </div>
                <div className="space-y-1.5">
                  <Label>Global express fee ($)</Label>
                  <Input type="number" min="0" step="0.01" value={globalExpFee} onChange={(e) => setGlobalExpFee(e.target.value)} placeholder="—" />
                </div>
                <div className="space-y-1.5">
                  <Label>Free standard above ($)</Label>
                  <Input type="number" min="0" step="0.01" value={globalFreeThr} onChange={(e) => setGlobalFreeThr(e.target.value)} placeholder="—" />
                </div>
                <div className="space-y-1.5">
                  <Label>Free express above ($)</Label>
                  <Input type="number" min="0" step="0.01" value={globalExpFreeThr} onChange={(e) => setGlobalExpFreeThr(e.target.value)} placeholder="—" />
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={patchMutation.isPending}>
                {patchMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RespondIoSettingsCard({ currentSettings }: { currentSettings: WorkspaceSettings | undefined }) {
  const { t } = useTranslation();
  const enabled = currentSettings?.respondio_enabled ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{t("settings.respondioTitle")}</CardTitle>
        <CardDescription className="text-sm">{t("settings.respondioDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t("settings.respondioStatus")}</span>
          {currentSettings === undefined ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : enabled ? (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
              {t("settings.respondioActive")}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
              {t("settings.respondioNotConfigured")}
            </span>
          )}
        </div>
        <div className="rounded-md border bg-muted/40 p-4 space-y-3">
          <p className="text-sm font-medium">{t("settings.respondioKeysRequired")}</p>
          <div className="space-y-2">
            <div className="flex flex-col gap-0.5">
              <code className="text-xs font-mono bg-muted rounded px-1.5 py-0.5 w-fit">
                RESPONDIO_API_TOKEN
              </code>
              <span className="text-xs text-muted-foreground ps-1">
                {t("settings.respondioApiTokenDesc")}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.respondioKeyHint")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

type TrustpilotTestFireResult = {
  success: boolean;
  testModeActive?: boolean;
  order?: {
    id: string;
    referenceId: string;
    locale: string;
    preferredSendTime: string;
    hasCustomerEmail: boolean;
    missingEmail: boolean;
  };
  invitation?: {
    id: string;
    status: string;
    attemptCount: number;
    lastError: string | null;
    responsePayload: unknown;
    createdAt: string;
    updatedAt: string;
  } | null;
  note?: string;
  error?: string;
  hint?: string;
};

function TrustpilotCard({ currentSettings }: { currentSettings: WorkspaceSettings | undefined }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [testOrderId, setTestOrderId] = useState("");
  const [testResult, setTestResult] = useState<TrustpilotTestFireResult | null>(null);

  const enabled = currentSettings?.trustpilot_invitations_enabled ?? true;

  const saveMutation = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch<WorkspaceSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          offline_alert_threshold_minutes: currentSettings?.offline_alert_threshold_minutes ?? 5,
          offline_alert_email_enabled: currentSettings?.offline_alert_email_enabled ?? false,
          available_countries: currentSettings?.available_countries ?? [],
          undo_duration_seconds: currentSettings?.undo_duration_seconds ?? 5,
          trustpilot_invitations_enabled: next,
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["workspace-settings"], data);
      toast({ title: t("settings.trustpilotSaved") });
    },
    onError: () => {
      toast({ title: t("settings.trustpilotSaveFailed"), variant: "destructive" });
    },
  });

  const testFireMutation = useMutation({
    mutationFn: (orderId: string) =>
      apiFetch<TrustpilotTestFireResult>("/api/admin/trustpilot/test-fire", {
        method: "POST",
        body: JSON.stringify({ orderId }),
      }),
    onSuccess: (data) => {
      setTestResult(data);
      if (data.success) {
        toast({ title: t("settings.trustpilotTestFireSuccess") });
      } else {
        toast({ title: data.error ?? t("settings.trustpilotTestFireFailed"), variant: "destructive" });
      }
    },
    onError: () => {
      setTestResult(null);
      toast({ title: t("settings.trustpilotTestFireFailed"), variant: "destructive" });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{t("settings.trustpilotTitle")}</CardTitle>
        <CardDescription className="text-sm">{t("settings.trustpilotDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="trustpilot-invitations-switch" className="text-sm">
            {t("settings.trustpilotToggleLabel")}
          </Label>
          <Switch
            id="trustpilot-invitations-switch"
            checked={enabled}
            disabled={saveMutation.isPending || currentSettings === undefined}
            onCheckedChange={(v) => saveMutation.mutate(v)}
          />
        </div>

        <div className="border-t pt-5 space-y-3">
          <div>
            <p className="text-sm font-medium">{t("settings.trustpilotTestFireTitle")}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t("settings.trustpilotTestFireDesc")}</p>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder={t("settings.trustpilotTestFirePlaceholder")}
              value={testOrderId}
              onChange={(e) => setTestOrderId(e.target.value)}
              className="h-8 text-sm flex-1"
              aria-label={t("settings.trustpilotTestFireLabel")}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={testFireMutation.isPending || !testOrderId.trim()}
              onClick={() => testFireMutation.mutate(testOrderId.trim())}
            >
              {testFireMutation.isPending ? t("settings.trustpilotTestFireFiring") : t("settings.trustpilotTestFireButton")}
            </Button>
          </div>

          {testResult && (
            <div className="rounded-md border bg-muted/40 p-3 space-y-3 text-xs">
              {/* Test mode status badge */}
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{t("settings.trustpilotTestFireTestModeLabel")}:</span>
                <Badge variant={testResult.testModeActive ? "default" : "destructive"} className="text-xs py-0">
                  {testResult.testModeActive ? "Active" : "Not active"}
                </Badge>
              </div>

              {/* No-email warning */}
              {testResult.order?.missingEmail && (
                <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{t("settings.trustpilotTestFireNoEmail")}</span>
                </div>
              )}

              {/* Error / hint from server (e.g. test mode not enabled) */}
              {!testResult.success && testResult.error && (
                <div className="space-y-1">
                  <p className="text-destructive font-medium">{testResult.error}</p>
                  {testResult.hint && (
                    <p className="text-muted-foreground">{testResult.hint}</p>
                  )}
                </div>
              )}

              {/* Order metadata */}
              {testResult.order && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="font-medium text-muted-foreground">Ref</dt>
                  <dd>{testResult.order.referenceId}</dd>
                  <dt className="font-medium text-muted-foreground">Locale</dt>
                  <dd>{testResult.order.locale}</dd>
                  <dt className="font-medium text-muted-foreground">Send time</dt>
                  <dd>{testResult.order.preferredSendTime}</dd>
                </dl>
              )}

              {/* Invitation row status */}
              {testResult.invitation && (
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-muted-foreground">Invitation status:</span>
                  <Badge variant={testResult.invitation.status === "created" ? "default" : "secondary"} className="text-xs py-0">
                    {testResult.invitation.status}
                  </Badge>
                  {testResult.invitation.attemptCount > 0 && (
                    <span className="text-muted-foreground">({testResult.invitation.attemptCount} attempt{testResult.invitation.attemptCount !== 1 ? "s" : ""})</span>
                  )}
                </div>
              )}

              {/* Would-be Trustpilot API payload (stored in response_payload) */}
              {testResult.invitation?.responsePayload != null && (
                <div className="space-y-1">
                  <p className="font-medium text-muted-foreground">{t("settings.trustpilotTestFirePayloadLabel")}</p>
                  <pre className="overflow-x-auto rounded bg-background border p-2 text-[11px] leading-relaxed">
                    {JSON.stringify(testResult.invitation.responsePayload, null, 2)}
                  </pre>
                </div>
              )}

              {/* Last error if processing failed */}
              {testResult.invitation?.lastError && (
                <div className="flex items-start gap-1.5 text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>{testResult.invitation.lastError}</span>
                </div>
              )}

              {testResult.note && (
                <p className="text-muted-foreground italic">{testResult.note}</p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryWebhookCard({ currentSettings }: { currentSettings: WorkspaceSettings | undefined }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (currentSettings !== undefined) {
      setUrl(currentSettings.delivery_webhook_url ?? "");
      setDirty(false);
    }
  }, [currentSettings]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<WorkspaceSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          offline_alert_threshold_minutes: currentSettings?.offline_alert_threshold_minutes ?? 5,
          offline_alert_email_enabled: currentSettings?.offline_alert_email_enabled ?? false,
          available_countries: currentSettings?.available_countries ?? [],
          undo_duration_seconds: currentSettings?.undo_duration_seconds ?? 5,
          delivery_webhook_url: url.trim() || null,
        }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["workspace-settings"], data);
      setDirty(false);
      toast({ title: t("settings.deliveryWebhookSaved"), description: t("settings.deliveryWebhookSavedDesc") });
    },
    onError: () => {
      toast({ title: t("settings.deliveryWebhookSaveFailed"), variant: "destructive" });
    },
  });

  const handleTest = async () => {
    const saved = currentSettings?.delivery_webhook_url;
    if (!saved) {
      toast({ title: t("settings.deliveryWebhookNoUrl"), variant: "destructive" });
      return;
    }
    setTesting(true);
    try {
      await apiFetch("/api/settings/delivery-webhook/test", { method: "POST" });
      toast({ title: t("settings.deliveryWebhookTestSuccess"), description: t("settings.deliveryWebhookTestSuccessDesc") });
    } catch {
      toast({ title: t("settings.deliveryWebhookTestFailed"), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{t("settings.deliveryWebhook")}</CardTitle>
        <CardDescription className="text-sm">{t("settings.deliveryWebhookDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="delivery-webhook-url">{t("settings.deliveryWebhookUrl")}</Label>
          <div className="flex gap-2">
            <Input
              id="delivery-webhook-url"
              type="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setDirty(true); }}
              placeholder={t("settings.deliveryWebhookUrlPlaceholder")}
              className="flex-1"
            />
            {url && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => { setUrl(""); setDirty(true); }}
                aria-label={t("settings.deliveryWebhookClear")}
              >
                <X size={16} />
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            size="sm"
          >
            {t("settings.deliveryWebhookSave")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing || !currentSettings?.delivery_webhook_url}
          >
            {testing ? <RefreshCw size={14} className="animate-spin mr-1" /> : null}
            {t("settings.deliveryWebhookTest")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// OmniTagsCard — manage inbox tag vocabulary (owner only)
// ---------------------------------------------------------------------------
const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#6b7280",
];

function OmniTagsCard() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<{ tags: OmniTag[] }>({
    queryKey: ["/api/omnichannel/tags"],
    queryFn: () => apiFetch<{ tags: OmniTag[] }>("/api/omnichannel/tags"),
  });

  const tags = data?.tags ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>("#3b82f6");

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<string>("#6b7280");

  const createMutation = useCreateOmnichannelTag({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/omnichannel/tags"] });
        setShowCreate(false);
        setNewName("");
        setNewColor("#3b82f6");
        toast({ title: "Tag created" });
      },
      onError: () => toast({ title: "Failed to create tag", variant: "destructive" }),
    },
  });

  const updateMutation = useUpdateOmnichannelTag({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/omnichannel/tags"] });
        setEditingId(null);
        toast({ title: "Tag updated" });
      },
      onError: () => toast({ title: "Failed to update tag", variant: "destructive" }),
    },
  });

  const deleteMutation = useDeleteOmnichannelTag({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/api/omnichannel/tags"] });
        toast({ title: "Tag deleted" });
      },
      onError: () => toast({ title: "Failed to delete tag", variant: "destructive" }),
    },
  });

  function startEdit(tag: OmniTag) {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color ?? "#6b7280");
    setShowCreate(false);
  }

  function handleCreate() {
    if (!newName.trim()) return;
    createMutation.mutate({ data: { name: newName.trim(), color: newColor } });
  }

  function handleUpdate() {
    if (!editingId || !editName.trim()) return;
    updateMutation.mutate({ id: editingId, data: { name: editName.trim(), color: editColor } });
  }

  return (
    <Card data-testid="card-inbox-tags">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Tag size={18} />
          Inbox Tags
        </CardTitle>
        <CardDescription>
          Pre-create and manage the tag vocabulary for inbox conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {tags.length === 0 && !showCreate && (
              <p className="text-sm text-muted-foreground">No tags yet.</p>
            )}

            <div className="space-y-1">
              {tags.map((tag) =>
                editingId === tag.id ? (
                  <div key={tag.id} className="flex flex-col gap-2 p-2 rounded-md bg-muted/50">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-shrink-0">
                        <span
                          className="inline-block w-5 h-5 rounded-full border border-border cursor-pointer"
                          style={{ backgroundColor: editColor }}
                          title="Click to change color"
                        />
                        <input
                          type="color"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                          className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                          aria-label="Tag color"
                        />
                      </div>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-7 text-sm flex-1"
                        onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(); if (e.key === "Escape") setEditingId(null); }}
                        autoFocus
                      />
                      <Button size="sm" className="h-7 px-2" onClick={handleUpdate} disabled={updateMutation.isPending || !editName.trim()}>
                        <Check size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingId(null)}>
                        <X size={14} />
                      </Button>
                    </div>
                    <div className="flex gap-1.5 flex-wrap pl-7">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setEditColor(c)}
                          className={cn(
                            "w-4 h-4 rounded-full border-2 transition-transform hover:scale-110",
                            editColor === c ? "border-foreground" : "border-transparent",
                          )}
                          style={{ backgroundColor: c }}
                          aria-label={c}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={tag.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 group">
                    <span
                      className="inline-block w-3.5 h-3.5 rounded-full flex-shrink-0 border border-border/50"
                      style={{ backgroundColor: tag.color ?? "#6b7280" }}
                    />
                    <span className="text-sm flex-1">{tag.name}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => startEdit(tag)} aria-label="Edit tag">
                        <Pencil size={12} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate({ id: tag.id })}
                        disabled={deleteMutation.isPending}
                        aria-label="Delete tag"
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </div>
                )
              )}
            </div>

            {showCreate ? (
              <div className="space-y-2 p-3 rounded-md border border-border bg-muted/30">
                <div className="flex items-center gap-2">
                  <div className="relative flex-shrink-0">
                    <span
                      className="inline-block w-5 h-5 rounded-full border border-border cursor-pointer"
                      style={{ backgroundColor: newColor }}
                    />
                    <input
                      type="color"
                      value={newColor}
                      onChange={(e) => setNewColor(e.target.value)}
                      className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
                      aria-label="New tag color"
                    />
                  </div>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Tag name…"
                    className="h-7 text-sm flex-1"
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setShowCreate(false); }}
                    autoFocus
                  />
                </div>
                <div className="flex gap-1.5 flex-wrap pl-7">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewColor(c)}
                      className={cn(
                        "w-4 h-4 rounded-full border-2 transition-transform hover:scale-110",
                        newColor === c ? "border-foreground" : "border-transparent",
                      )}
                      style={{ backgroundColor: c }}
                      aria-label={c}
                    />
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={createMutation.isPending || !newName.trim()}>
                    Create
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setShowCreate(false); setNewName(""); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => { setShowCreate(true); setEditingId(null); }}
              >
                <Plus size={12} />
                Add tag
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── SuppliersSettingsCard ─────────────────────────────────────────────────────

const SUPPLIER_CATEGORIES_SETTINGS = [
  "Raw Materials",
  "Packaging Materials",
  "Office Supplies",
  "Equipment & Machinery",
  "Maintenance & Repairs",
  "IT & Technology",
  "Logistics & Freight",
  "Professional Services",
  "Catering & Food Service",
  "Uniforms & Apparel",
  "Marketing & Advertising",
  "Security Services",
  "Cleaning & Facilities",
  "Construction & Real Estate",
  "Utilities & Energy",
  "Other",
] as const;

function supplierInitialsSettings(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function SuppliersSettingsCard() {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const { data, isLoading } = useListSuppliers();

  const suppliers: Supplier[] = data?.suppliers ?? [];

  const categories = Array.from(
    new Set(suppliers.map((s) => s.category).filter((c): c is string => Boolean(c))),
  ).sort();

  const filtered = suppliers.filter((s) => {
    if (s.is_archived) return false;
    if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const name = (s.display_name || s.name).toLowerCase();
      if (!name.includes(q) && !(s.category ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Store size={16} />
            Suppliers
          </CardTitle>
          <Link
            href="/suppliers"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
          </Link>
        </div>
        <CardDescription>Workspace supplier list</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search suppliers…"
              className="pl-8 h-8 text-sm"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-8 text-sm w-44">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {(categories.length > 0 ? categories : [...SUPPLIER_CATEGORIES_SETTINGS]).map((cat) => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {categoryFilter !== "all" && (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-xs gap-1 pr-1">
              {categoryFilter}
              <button
                type="button"
                onClick={() => setCategoryFilter("all")}
                className="ml-0.5 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label="Clear category filter"
              >
                <X size={10} />
              </button>
            </Badge>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <div className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1">
                  <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                  <div className="h-2.5 w-20 bg-muted animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {search || categoryFilter !== "all" ? "No suppliers match the current filters." : "No suppliers yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((s) => (
              <li key={s.id} className="flex items-center gap-2.5 py-2">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {supplierInitialsSettings(s.name)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">
                    {s.display_name || s.name}
                  </p>
                  {s.display_name && (
                    <p className="truncate text-xs text-muted-foreground">{s.name}</p>
                  )}
                </div>
                {s.category && (
                  <Badge variant="outline" className="shrink-0 text-[10px] h-5 px-1.5">
                    {s.category}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        {filtered.length > 0 && (
          <p className="text-xs text-muted-foreground text-right">
            {filtered.length} supplier{filtered.length !== 1 ? "s" : ""}
            {categoryFilter !== "all" ? ` in "${categoryFilter}"` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── BranchPrintersCard ────────────────────────────────────────────────────────

type BranchPrintConfigRow = {
  id: number;
  name: string;
  machine_id: string;
  printer_id: string;
};

function BranchPrintersCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BranchPrintConfigRow | null>(null);
  const [name, setName] = useState("");
  const [machineId, setMachineId] = useState("");
  const [printerId, setPrinterId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<BranchPrintConfigRow | null>(null);

  const { data, isLoading } = useQuery<{ configs: BranchPrintConfigRow[] }>({
    queryKey: ["branch-print-configs"],
    queryFn: () => apiFetch("/api/card-message/branch-configs"),
  });
  const configs = data?.configs ?? [];

  function openAdd() {
    setEditing(null);
    setName("");
    setMachineId("");
    setPrinterId("");
    setDialogOpen(true);
  }

  function openEdit(cfg: BranchPrintConfigRow) {
    setEditing(cfg);
    setName(cfg.name);
    setMachineId(cfg.machine_id);
    setPrinterId(cfg.printer_id);
    setDialogOpen(true);
  }

  function saveErrorMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : "";
    return msg.includes("already exists")
      ? t("settings.branchPrintersDuplicate")
      : t("settings.branchPrintersSaveFailed");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = JSON.stringify({
        name: name.trim(),
        machineId: machineId.trim(),
        printerId: printerId.trim(),
      });
      if (editing) {
        await apiFetch(`/api/card-message/branch-configs/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } else {
        await apiFetch("/api/card-message/branch-configs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branch-print-configs"] });
      setDialogOpen(false);
      toast({ title: t("settings.branchPrintersSaved") });
    },
    onError: (err) => {
      toast({ title: saveErrorMessage(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiFetch(`/api/card-message/branch-configs/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branch-print-configs"] });
      setDeleteTarget(null);
      toast({ title: t("settings.branchPrintersDeleted") });
    },
    onError: () => {
      toast({ title: t("settings.branchPrintersDeleteFailed"), variant: "destructive" });
    },
  });

  const canSave =
    !!name.trim() && !!machineId.trim() && !!printerId.trim() && !saveMutation.isPending;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Printer size={16} />
            {t("settings.branchPrinters")}
          </CardTitle>
          <Button size="sm" variant="outline" className="h-8" onClick={openAdd}>
            <Plus size={14} className="mr-1" />
            {t("settings.branchPrintersAdd")}
          </Button>
        </div>
        <CardDescription>{t("settings.branchPrintersDesc")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-9 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : configs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            {t("settings.branchPrintersEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {configs.map((cfg) => (
              <li key={cfg.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium leading-tight">{cfg.name}</p>
                  <p className="truncate text-xs text-muted-foreground" dir="ltr">
                    {t("settings.branchPrintersMachineId")}: {cfg.machine_id} ·{" "}
                    {t("settings.branchPrintersPrinterId")}: {cfg.printer_id}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => openEdit(cfg)}
                  aria-label={t("settings.branchPrintersEdit")}
                >
                  <Pencil size={13} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(cfg)}
                  aria-label={t("settings.branchPrintersDelete")}
                >
                  <Trash2 size={13} />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("settings.branchPrintersEdit") : t("settings.branchPrintersAdd")}
            </DialogTitle>
            <DialogDescription>{t("settings.branchPrintersNameHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bp-name">{t("settings.branchPrintersName")}</Label>
              <Input
                id="bp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("settings.branchPrintersNamePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-machine">{t("settings.branchPrintersMachineId")}</Label>
              <Input
                id="bp-machine"
                value={machineId}
                onChange={(e) => setMachineId(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bp-printer">{t("settings.branchPrintersPrinterId")}</Label>
              <Input
                id="bp-printer"
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
                dir="ltr"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("settings.branchPrintersCancel")}
            </Button>
            <Button disabled={!canSave} onClick={() => saveMutation.mutate()}>
              {t("settings.branchPrintersSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.branchPrintersDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings.branchPrintersDeleteDesc", { name: deleteTarget?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("settings.branchPrintersCancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {t("settings.branchPrintersDelete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface WeeklyDigestSettings {
  enabled: boolean;
  extra_recipients: string[];
}

function WeeklyDigestCard() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<WeeklyDigestSettings>({
    queryKey: ["weekly-digest-settings"],
    queryFn: () => apiFetch<WeeklyDigestSettings>("/api/digest/settings"),
  });

  const [emailInput, setEmailInput] = useState("");

  const saveMutation = useMutation({
    mutationFn: (payload: Partial<WeeklyDigestSettings>) =>
      apiFetch<WeeklyDigestSettings>("/api/digest/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["weekly-digest-settings"], saved);
      toast({ title: t("settings.weeklyDigest.saved") });
    },
    onError: () => {
      toast({ title: t("settings.weeklyDigest.saveFailed"), variant: "destructive" });
    },
  });

  const sendNowMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ sent: boolean; recipients: string[] }>("/api/digest/send-now", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      toast({
        title: t("settings.weeklyDigest.sendNowSuccess"),
        description: result.recipients.join(", "),
      });
    },
    onError: () => {
      toast({ title: t("settings.weeklyDigest.sendNowFailed"), variant: "destructive" });
    },
  });

  const recipients = data?.extra_recipients ?? [];

  function handleAddRecipient() {
    const email = emailInput.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast({ title: t("settings.weeklyDigest.invalidEmail"), variant: "destructive" });
      return;
    }
    if (recipients.includes(email)) {
      setEmailInput("");
      return;
    }
    saveMutation.mutate({ extra_recipients: [...recipients, email] });
    setEmailInput("");
  }

  function handleRemoveRecipient(email: string) {
    saveMutation.mutate({ extra_recipients: recipients.filter((r) => r !== email) });
  }

  return (
    <Card data-testid="card-weekly-digest">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Mail size={18} />
          {t("settings.weeklyDigest.title")}
        </CardTitle>
        <CardDescription>{t("settings.weeklyDigest.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("settings.weeklyDigest.loading")}</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="weekly-digest-enabled">
                  {t("settings.weeklyDigest.enableLabel")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("settings.weeklyDigest.enableHint")}
                </p>
              </div>
              <Switch
                id="weekly-digest-enabled"
                checked={data?.enabled ?? false}
                disabled={saveMutation.isPending}
                onCheckedChange={(checked) => saveMutation.mutate({ enabled: checked })}
                data-testid="switch-weekly-digest-enabled"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="weekly-digest-email">
                {t("settings.weeklyDigest.recipientsLabel")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t("settings.weeklyDigest.recipientsHint")}
              </p>
              <div className="flex gap-2">
                <Input
                  id="weekly-digest-email"
                  type="email"
                  placeholder={t("settings.weeklyDigest.emailPlaceholder")}
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddRecipient();
                    }
                  }}
                  data-testid="input-weekly-digest-email"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleAddRecipient}
                  disabled={saveMutation.isPending}
                  data-testid="button-weekly-digest-add-recipient"
                >
                  <Plus size={16} className="mr-1" />
                  {t("settings.weeklyDigest.addRecipient")}
                </Button>
              </div>
              {recipients.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {recipients.map((email) => (
                    <Badge
                      key={email}
                      variant="secondary"
                      className="flex items-center gap-1"
                      data-testid={`badge-digest-recipient-${email}`}
                    >
                      {email}
                      <button
                        type="button"
                        onClick={() => handleRemoveRecipient(email)}
                        className="ml-1 rounded-full hover:bg-muted-foreground/20"
                        aria-label={t("settings.weeklyDigest.removeRecipient")}
                      >
                        <X size={12} />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-4 border-t pt-4">
              <p className="text-sm text-muted-foreground">
                {t("settings.weeklyDigest.sendNowHint")}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => sendNowMutation.mutate()}
                disabled={sendNowMutation.isPending}
                data-testid="button-weekly-digest-send-now"
              >
                {sendNowMutation.isPending
                  ? t("settings.weeklyDigest.sending")
                  : t("settings.weeklyDigest.sendNow")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
