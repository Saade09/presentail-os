import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, Search, UserPlus, X } from "lucide-react";
import {
  useWizardSearchContacts,
  useWizardDuplicateCheckContact,
  useWizardCreateContact,
  getWizardSearchContactsQueryKey,
  getWizardDuplicateCheckContactQueryKey,
} from "@workspace/api-client-react";
import type { WizardContact } from "@workspace/api-client-react";
import {
  getCountries,
  getCountryCallingCode,
  isPossiblePhoneNumber,
  parsePhoneNumber,
} from "react-phone-number-input";
import type { Country, Labels } from "react-phone-number-input";
import enPhoneLabels from "react-phone-number-input/locale/en.json";
import arPhoneLabels from "react-phone-number-input/locale/ar.json";
import { PhoneInputField } from "@/components/PhoneInputField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { EXCLUDED_COUNTRY_CODES } from "@/lib/countries";

export type { WizardContact };

/**
 * Keep the contact phone selector in sync with libphonenumber-js instead of
 * maintaining a second, inevitably incomplete, country list. The shared
 * catalogue's exclusion policy still applies (for example, Israel is
 * intentionally unavailable throughout country-aware UI).
 */
export const CREATE_CONTACT_PHONE_COUNTRIES: Country[] = getCountries().filter(
  (country) => !EXCLUDED_COUNTRY_CODES.includes(country),
);

function getContactPhoneLabels(language: string | undefined): Labels {
  const source = language?.startsWith("ar") ? arPhoneLabels : enPhoneLabels;
  const labels: Labels = { ...source };

  for (const country of CREATE_CONTACT_PHONE_COUNTRIES) {
    const countryName = source[country] ?? country;
    labels[country] = `${countryName} (+${getCountryCallingCode(country)})`;
  }

  return labels;
}

/**
 * Best-effort conversion of a free-text search query into a value the
 * international phone input can use. Accepts inputs with or without a leading
 * "+": bare digit strings (e.g. "961703...") are tried as international
 * numbers first, so the country selector picks up the right flag.
 */
export function seedPhoneFromQuery(q: string): string {
  const digits = q.replace(/[^\d]/g, "");
  if (!digits) return "";
  const candidate = `+${digits}`;
  if (q.trim().startsWith("+")) return candidate;
  // Bare digits: treat as international if a country can be derived.
  const parsed = parsePhoneNumber(candidate);
  if (parsed?.country) return candidate;
  return digits;
}

export function contactDisplayName(c: WizardContact): string {
  const full = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return c.display_name?.trim() || full || c.email || c.phone || "—";
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * Search-first contact picker for the Create Order wizard.
 *
 * Renders a combobox-style search input over the workspace contact pool with
 * selectable result cards, plus an inline "create new" form with a live
 * duplicate check. Accessible: input is a `combobox`, results a `listbox`
 * with arrow-key navigation and Enter-to-select.
 */
export function ContactSearchPicker({
  mode,
  customerContactId,
  selected,
  onSelect,
  testIdPrefix,
}: {
  mode: "customer" | "recipient";
  /** Selected customer id — enables saved-recipient metadata in recipient mode. */
  customerContactId?: string | null;
  selected: WizardContact | null;
  onSelect: (contact: WizardContact | null) => void;
  testIdPrefix: string;
}) {
  const { t, i18n } = useTranslation();
  const listboxId = useId();
  const phoneLabels = useMemo(
    () => getContactPhoneLabels(i18n?.language),
    [i18n?.language],
  );

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showCreate, setShowCreate] = useState(false);

  // Create-new form
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);

  const searchParams = {
    q: debouncedQuery,
    ...(mode === "recipient" && customerContactId
      ? { customer_contact_id: customerContactId }
      : {}),
  };
  const searchQuery = useWizardSearchContacts(searchParams, {
    query: {
      enabled: debouncedQuery.length >= 2 && !selected,
      queryKey: getWizardSearchContactsQueryKey(searchParams),
    },
  });
  const results = useMemo(
    () => (debouncedQuery.length >= 2 ? (searchQuery.data?.results ?? []) : []),
    [searchQuery.data, debouncedQuery],
  );

  useEffect(() => setActiveIndex(-1), [debouncedQuery]);

  const debouncedPhone = useDebounced(newPhone.trim(), 400);
  const debouncedEmail = useDebounced(newEmail.trim(), 400);
  const dupParams = { phone: debouncedPhone, email: debouncedEmail };
  const dupQuery = useWizardDuplicateCheckContact(dupParams, {
    query: {
      enabled: showCreate && (debouncedPhone.length >= 3 || debouncedEmail.includes("@")),
      queryKey: getWizardDuplicateCheckContactQueryKey(dupParams),
    },
  });
  const duplicate = showCreate ? (dupQuery.data?.match ?? null) : null;

  const createMut = useWizardCreateContact();

  const pick = (c: WizardContact) => {
    onSelect(c);
    setQuery("");
    setShowCreate(false);
  };

  // Screen-reader status announcements (loading / result count / failure).
  const searchStatus =
    debouncedQuery.length < 2
      ? ""
      : searchQuery.isError
        ? t("orders.co.searchError")
        : searchQuery.isLoading
          ? t("orders.co.searching")
          : results.length === 0
            ? t("orders.co.noContactsFound")
            : t("orders.co.resultsCount", { count: results.length });

  const handleCreate = () => {
    setCreateError(null);
    const name = newName.trim();
    const phone = newPhone.trim();
    const email = newEmail.trim();
    if (!phone && !email) {
      setCreateError(t("orders.co.contactNeedsPhoneOrEmail"));
      return;
    }
    if (!name && !phone) {
      setCreateError(t("orders.co.contactNeedsNameOrPhone"));
      return;
    }
    if (phone && !isPossiblePhoneNumber(phone)) {
      setCreateError(t("orders.co.contactPhoneInvalid"));
      return;
    }
    createMut.mutate(
      {
        data: {
          display_name: name || null,
          email: email || null,
          phone: phone || null,
        },
      },
      {
        onSuccess: (res) => {
          pick(res.contact);
          setNewName("");
          setNewEmail("");
          setNewPhone("");
        },
        onError: (err) => {
          setCreateError(t("orders.co.contactCreateError"));
        },
      },
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0 && results[activeIndex]) {
      e.preventDefault();
      pick(results[activeIndex]);
    } else if (e.key === "Escape") {
      setQuery("");
    }
  };

  if (selected) {
    return (
      <div
        className="flex items-start justify-between gap-3 rounded-md border border-teal-200 bg-teal-50 p-3"
        data-testid={`${testIdPrefix}-selected`}
      >
        <span role="status" aria-live="polite" className="sr-only">
          {t("orders.co.contactSelected", { name: contactDisplayName(selected) })}
        </span>
        <div className="flex items-start gap-2 min-w-0">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-teal-700" />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{contactDisplayName(selected)}</p>
            <p className="text-xs text-muted-foreground truncate">
              {[selected.phone, selected.email].filter(Boolean).join(" · ")}
            </p>
            <ContactMeta contact={selected} mode={mode} />
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onSelect(null)}
          data-testid={`${testIdPrefix}-clear`}
        >
          <X size={14} className="me-1" />
          {t("orders.co.changeContact")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={16} className="absolute start-2.5 top-2.5 text-muted-foreground" />
        <Input
          ref={inputRef}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={
            activeIndex >= 0 && results[activeIndex]
              ? `${listboxId}-opt-${results[activeIndex].id}`
              : undefined
          }
          aria-autocomplete="list"
          className="ps-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            mode === "customer"
              ? t("orders.co.searchCustomerPlaceholder")
              : t("orders.co.searchRecipientPlaceholder")
          }
          data-testid={`${testIdPrefix}-search`}
        />
      </div>

      <span role="status" aria-live="polite" className="sr-only">
        {searchStatus}
      </span>

      {debouncedQuery.length >= 2 && searchQuery.isError && (
        <div
          className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-center"
          data-testid={`${testIdPrefix}-search-error`}
        >
          <p className="text-sm text-destructive">{t("orders.co.searchError")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => searchQuery.refetch()}
            data-testid={`${testIdPrefix}-search-retry`}
          >
            {t("orders.co.retry")}
          </Button>
        </div>
      )}

      {debouncedQuery.length >= 2 && !searchQuery.isError && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={
            mode === "customer" ? t("orders.co.stepCustomer") : t("orders.co.stepRecipient")
          }
          className="max-h-56 overflow-y-auto rounded-md border divide-y"
        >
          {searchQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin text-muted-foreground" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("orders.co.noContactsFound")}
            </p>
          ) : (
            results.map((c, i) => (
              <ContactResultCard
                key={c.id}
                contact={c}
                mode={mode}
                active={i === activeIndex}
                optionId={`${listboxId}-opt-${c.id}`}
                onPick={() => pick(c)}
                testIdPrefix={testIdPrefix}
              />
            ))
          )}
        </div>
      )}

      {!showCreate ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setShowCreate(true);
            // Seed the form from what they were searching for.
            const q = query.trim();
            if (q) {
              if (/^[+\d][\d\s()-]*$/.test(q)) setNewPhone(seedPhoneFromQuery(q));
              else if (q.includes("@")) setNewEmail(q);
              else setNewName(q);
            }
          }}
          data-testid={`${testIdPrefix}-show-create`}
        >
          <UserPlus size={14} className="me-1.5" />
          {mode === "customer" ? t("orders.co.createNewCustomer") : t("orders.co.createNewRecipient")}
        </Button>
      ) : (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label>{t("orders.co.name")}</Label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("orders.co.namePlaceholder")}
              data-testid={`${testIdPrefix}-new-name`}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("orders.co.phone")}</Label>
              <PhoneInputField
                international
                countryCallingCodeEditable={false}
                defaultCountry="LB"
                countries={CREATE_CONTACT_PHONE_COUNTRIES}
                labels={phoneLabels}
                countrySelectProps={{
                  "aria-label": t("orders.co.phoneCountry", "Phone country"),
                  "data-testid": `${testIdPrefix}-new-phone-country`,
                }}
                value={newPhone || undefined}
                onChange={(val) => setNewPhone(val ?? "")}
                placeholder="+971..."
                data-testid={`${testIdPrefix}-new-phone`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("orders.co.email")}</Label>
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="name@example.com"
                data-testid={`${testIdPrefix}-new-email`}
              />
            </div>
          </div>

          {duplicate && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm"
              data-testid={`${testIdPrefix}-duplicate-hint`}
            >
              <p className="text-amber-800">
                {t("orders.co.duplicateFound", { name: contactDisplayName(duplicate) })}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-1.5"
                onClick={() => pick(duplicate)}
                data-testid={`${testIdPrefix}-use-existing`}
              >
                {t("orders.co.useExistingContact")}
              </Button>
            </div>
          )}

          {createError && <p className="text-xs text-destructive">{createError}</p>}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              className="bg-teal-700 text-white hover:bg-teal-800"
              onClick={handleCreate}
              disabled={createMut.isPending}
              data-testid={`${testIdPrefix}-create-submit`}
            >
              {createMut.isPending && <Loader2 size={14} className="me-1.5 animate-spin" />}
              {t("orders.co.saveContact")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setShowCreate(false);
                setCreateError(null);
              }}
            >
              {t("orders.co.cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ContactMeta({ contact, mode }: { contact: WizardContact; mode: "customer" | "recipient" }) {
  const { t } = useTranslation();
  const parts: React.ReactNode[] = [];
  if (mode === "recipient" && contact.is_saved_recipient) {
    parts.push(
      <Badge key="saved" variant="secondary" className="bg-teal-100 text-teal-800">
        {t("orders.co.savedRecipient")}
      </Badge>,
    );
  }
  if (mode === "customer") {
    parts.push(
      <span key="orders">{t("orders.co.ordersCount", { count: contact.orders_placed })}</span>,
    );
    if (contact.last_order_at) {
      parts.push(
        <span key="last">
          {t("orders.co.lastOrder", {
            date: new Date(contact.last_order_at).toLocaleDateString(),
          })}
        </span>,
      );
    }
  } else {
    if ((contact.deliveries_count ?? 0) > 0) {
      parts.push(
        <span key="deliveries">
          {t("orders.co.deliveriesCount", { count: contact.deliveries_count })}
        </span>,
      );
    }
    if (contact.last_delivery_city) {
      parts.push(<span key="city">{contact.last_delivery_city}</span>);
    }
  }
  if (parts.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {parts}
    </div>
  );
}

function ContactResultCard({
  contact,
  mode,
  active,
  optionId,
  onPick,
  testIdPrefix,
}: {
  contact: WizardContact;
  mode: "customer" | "recipient";
  active: boolean;
  optionId: string;
  onPick: () => void;
  testIdPrefix: string;
}) {
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={active}
      onClick={onPick}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-start hover:bg-muted",
        active && "bg-muted",
      )}
      data-testid={`${testIdPrefix}-result-${contact.id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{contactDisplayName(contact)}</p>
        <p className="text-xs text-muted-foreground truncate">
          {[contact.phone, contact.email].filter(Boolean).join(" · ")}
        </p>
        <ContactMeta contact={contact} mode={mode} />
      </div>
    </button>
  );
}
