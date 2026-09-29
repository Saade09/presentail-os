import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "wouter";
import { useTranslation } from "react-i18next";
import {
  MapPin,
  Loader2,
  CheckCircle2,
  XCircle,
  Navigation,
  ShieldCheck,
  Gift,
  MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { LeafletPinMap } from "@/components/LeafletPinMap";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

type Lang = "en" | "ar";

type AddressState = "open" | "submitted" | "closed" | "expired";

type AddressDetails = {
  state: AddressState;
  language?: Lang;
  recipient_first_name?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  timezone?: string | null;
};

type FetchResult =
  | { kind: "ok"; data: AddressDetails }
  | { kind: "gone"; state: AddressState }
  | { kind: "not_found" }
  | { kind: "rate_limited" }
  | { kind: "error" };

// Default map center — Beirut. Overridden as soon as we have geolocation or a pin.
const DEFAULT_CENTER: [number, number] = [33.8938, 35.5018];

async function fetchAddress(token: string): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(`${basePath}/api/address/${token}`);
  } catch {
    return { kind: "error" };
  }
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 429) return { kind: "rate_limited" };
  if (res.status === 410) {
    const body = (await res.json().catch(() => ({}))) as { state?: AddressState };
    return { kind: "gone", state: body.state ?? "expired" };
  }
  if (!res.ok) return { kind: "error" };
  const data = (await res.json()) as AddressDetails;
  return { kind: "ok", data };
}

type SubmitPayload = {
  latitude: number;
  longitude: number;
  area: string;
  street: string;
  building?: string;
  floor?: string;
  apartment?: string;
  landmark?: string;
  notes?: string;
  save_for_future?: boolean;
};

type SubmitResult =
  | { kind: "ok" }
  | { kind: "validation" }
  | { kind: "gone" }
  | { kind: "error" };

async function submitAddress(token: string, payload: SubmitPayload): Promise<SubmitResult> {
  let res: Response;
  try {
    res = await fetch(`${basePath}/api/address/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "error" };
  }
  if (res.ok) return { kind: "ok" };
  if (res.status === 400) return { kind: "validation" };
  if (res.status === 410) return { kind: "gone" };
  return { kind: "error" };
}

function formatWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  timezone: string | null | undefined,
  locale: string,
): string | null {
  if (!start) return null;
  try {
    const opts: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || undefined,
    };
    const startStr = new Date(start).toLocaleTimeString(locale, opts);
    if (!end) return startStr;
    const endStr = new Date(end).toLocaleTimeString(locale, opts);
    return `${startStr} – ${endStr}`;
  } catch {
    return null;
  }
}

export default function AddressCollectPage() {
  const { token } = useParams<{ token: string }>();
  const { t, i18n } = useTranslation();

  const [lang, setLang] = useState<Lang>("en");
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<FetchResult | null>(null);

  // Form state
  const [coords, setCoords] = useState<[number, number] | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [area, setArea] = useState("");
  const [street, setStreet] = useState("");
  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("");
  const [apartment, setApartment] = useState("");
  const [landmark, setLandmark] = useState("");
  const [notes, setNotes] = useState("");
  const [saveForFuture, setSaveForFuture] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<"idle" | "submitted" | "gone" | "error">("idle");

  // Track whether we set the initial language from the API yet.
  const langInitialized = useRef(false);

  useEffect(() => {
    if (!token) return;
    let active = true;
    setLoading(true);
    fetchAddress(token).then((r) => {
      if (!active) return;
      setResult(r);
      setLoading(false);
      if (r.kind === "ok" && r.data.language && !langInitialized.current) {
        langInitialized.current = true;
        setLang(r.data.language);
        void i18n.changeLanguage(r.data.language);
      }
    });
    return () => {
      active = false;
    };
  }, [token, i18n]);

  const isRtl = lang === "ar";

  function toggleLang(next: Lang) {
    setLang(next);
    void i18n.changeLanguage(next);
  }

  function handleUseLocation() {
    if (!("geolocation" in navigator)) {
      setGeoError(t("addressCollect.geoUnsupported"));
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords([pos.coords.latitude, pos.coords.longitude]);
        setLocating(false);
      },
      () => {
        setGeoError(t("addressCollect.geoDenied"));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const coordsValid = coords != null;
  const areaValid = area.trim().length > 0;
  const streetValid = street.trim().length > 0;
  const formValid = coordsValid && areaValid && streetValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!formValid || !token || !coords || submitting) return;
    setSubmitting(true);
    const r = await submitAddress(token, {
      latitude: coords[0],
      longitude: coords[1],
      area: area.trim(),
      street: street.trim(),
      building: building.trim() || undefined,
      floor: floor.trim() || undefined,
      apartment: apartment.trim() || undefined,
      landmark: landmark.trim() || undefined,
      notes: notes.trim() || undefined,
      save_for_future: saveForFuture || undefined,
    });
    setSubmitting(false);
    if (r.kind === "ok") setSubmitState("submitted");
    else if (r.kind === "gone") setSubmitState("gone");
    else if (r.kind === "validation") setSubmitState("error");
    else setSubmitState("error");
  }

  const details = result?.kind === "ok" ? result.data : null;
  const recipientName = details?.recipient_first_name?.trim() || "";
  const windowLabel = useMemo(
    () => formatWindow(details?.window_start, details?.window_end, details?.timezone, lang),
    [details, lang],
  );

  const showConfirmation =
    submitState === "submitted" || (details && details.state === "submitted");
  const isGone =
    result?.kind === "gone" ||
    result?.kind === "not_found" ||
    submitState === "gone";

  return (
    <div
      dir={isRtl ? "rtl" : "ltr"}
      className="min-h-[100dvh] bg-[#f5f5f0]"
      data-testid="address-collect-page"
    >
      <div className="mx-auto w-full max-w-[440px] px-4 py-6">
        {/* Header bar: brand + language toggle */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-[#0d6e7a] flex items-center justify-center text-white">
              <Gift size={16} strokeWidth={2.5} />
            </div>
            <span className="font-bold text-base tracking-tight text-foreground">Presentail</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-full border border-border bg-white overflow-hidden text-xs">
              <button
                type="button"
                data-testid="address-collect-lang-en"
                onClick={() => toggleLang("en")}
                className={`px-2.5 py-1 font-medium ${lang === "en" ? "bg-[#0d6e7a] text-white" : "text-muted-foreground"}`}
              >
                EN
              </button>
              <button
                type="button"
                data-testid="address-collect-lang-ar"
                onClick={() => toggleLang("ar")}
                className={`px-2.5 py-1 font-medium ${lang === "ar" ? "bg-[#0d6e7a] text-white" : "text-muted-foreground"}`}
              >
                العربية
              </button>
            </div>
            <span className="inline-flex items-center gap-1 text-xs text-[#0d6e7a] font-medium">
              <ShieldCheck size={12} />
              {t("addressCollect.secure")}
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted-foreground" size={28} />
          </div>
        ) : isGone ? (
          <div className="bg-white border border-border rounded-2xl shadow-sm p-8 text-center space-y-3">
            <XCircle size={40} className="text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">
              {t("addressCollect.expiredTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("addressCollect.expiredBody")}</p>
          </div>
        ) : showConfirmation ? (
          <div
            className="bg-white border border-border rounded-2xl shadow-sm p-8 text-center space-y-3"
            data-testid="address-collect-confirmation"
          >
            <CheckCircle2 size={44} className="text-green-500 mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">
              {t("addressCollect.confirmTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("addressCollect.confirmBody")}</p>
          </div>
        ) : result?.kind === "error" ? (
          <div className="bg-white border border-border rounded-2xl shadow-sm p-8 text-center space-y-3">
            <XCircle size={40} className="text-destructive mx-auto" />
            <h2 className="text-lg font-semibold text-foreground">
              {t("addressCollect.errorTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("addressCollect.errorBody")}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Friendly header — surprise safe: never mention sender/gift/price */}
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">
                {recipientName
                  ? t("addressCollect.headingNamed", { name: recipientName })
                  : t("addressCollect.heading")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {windowLabel
                  ? t("addressCollect.subheadingWindow", { window: windowLabel })
                  : t("addressCollect.subheading")}
              </p>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-[#e6f4f5] border border-[#b2dde3] px-3 py-1.5 text-xs text-[#0d6e7a]">
                <ShieldCheck size={12} />
                {t("addressCollect.surpriseSafe")}
              </div>
            </div>

            {/* Use my current location */}
            <Button
              type="button"
              data-testid="address-collect-use-location"
              onClick={handleUseLocation}
              disabled={locating}
              className="w-full h-12 gap-2 bg-[#0d6e7a] hover:bg-[#0a5c67] text-white"
            >
              {locating ? <Loader2 size={18} className="animate-spin" /> : <Navigation size={18} />}
              {t("addressCollect.useLocation")}
            </Button>
            {geoError && <p className="text-xs text-destructive text-center">{geoError}</p>}

            <p className="text-center text-xs text-muted-foreground">
              {t("addressCollect.orPin")}
            </p>

            {/* Interactive map with movable pin */}
            <div className="rounded-2xl overflow-hidden border border-border bg-white">
              <LeafletPinMap
                center={coords ?? DEFAULT_CENTER}
                value={coords}
                onChange={setCoords}
              />
              <div className="border-t border-border px-4 py-2.5 text-center text-xs text-muted-foreground">
                {t("addressCollect.moveMap")}
              </div>
            </div>
            {attempted && !coordsValid && (
              <p className="text-xs text-destructive text-center">
                {t("addressCollect.pinRequired")}
              </p>
            )}

            {/* Delivery details */}
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-foreground">
                {t("addressCollect.detailsTitle")}
              </h2>

              <div className="space-y-1.5">
                <Label htmlFor="ac-area" className="text-xs text-muted-foreground">
                  {t("addressCollect.area")}
                </Label>
                <Input
                  id="ac-area"
                  data-testid="address-collect-area"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className={`h-11 ${attempted && !areaValid ? "border-destructive" : ""}`}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ac-street" className="text-xs text-muted-foreground">
                  {t("addressCollect.street")}
                </Label>
                <Input
                  id="ac-street"
                  data-testid="address-collect-street"
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  className={`h-11 ${attempted && !streetValid ? "border-destructive" : ""}`}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ac-floor" className="text-xs text-muted-foreground">
                    {t("addressCollect.floor")}
                  </Label>
                  <Input
                    id="ac-floor"
                    data-testid="address-collect-floor"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ac-apartment" className="text-xs text-muted-foreground">
                    {t("addressCollect.apartment")}
                  </Label>
                  <Input
                    id="ac-apartment"
                    data-testid="address-collect-apartment"
                    value={apartment}
                    onChange={(e) => setApartment(e.target.value)}
                    className="h-11"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ac-building" className="text-xs text-muted-foreground">
                  {t("addressCollect.building")}
                </Label>
                <Input
                  id="ac-building"
                  data-testid="address-collect-building"
                  value={building}
                  onChange={(e) => setBuilding(e.target.value)}
                  className="h-11"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ac-landmark" className="text-xs text-muted-foreground">
                  {t("addressCollect.landmark")}
                </Label>
                <Input
                  id="ac-landmark"
                  data-testid="address-collect-landmark"
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  className="h-11"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ac-notes" className="text-xs text-muted-foreground">
                  {t("addressCollect.notes")}
                </Label>
                <Textarea
                  id="ac-notes"
                  data-testid="address-collect-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer pt-1">
                <Checkbox
                  data-testid="address-collect-save-future"
                  checked={saveForFuture}
                  onCheckedChange={(v) => setSaveForFuture(v === true)}
                />
                <span className="text-sm text-foreground">
                  {t("addressCollect.saveForFuture")}
                </span>
              </label>
            </div>

            {/* Privacy note */}
            <div className="flex items-center gap-2 rounded-xl bg-[#e6f4f5] border border-[#b2dde3] px-3 py-2.5">
              <ShieldCheck size={16} className="text-[#0d6e7a] shrink-0" />
              <p className="text-xs text-[#0d6e7a]">{t("addressCollect.privacyNote")}</p>
            </div>

            {submitState === "error" && (
              <p className="text-sm text-destructive text-center">
                {t("addressCollect.errorBody")}
              </p>
            )}

            <Button
              type="submit"
              data-testid="address-collect-submit"
              disabled={submitting}
              className="w-full h-12 text-base gap-2 bg-[#0d6e7a] hover:bg-[#0a5c67] text-white"
            >
              {submitting ? <Loader2 size={18} className="animate-spin" /> : null}
              {t("addressCollect.confirmButton")}
            </Button>

            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <MessageCircle size={12} />
              {t("addressCollect.needHelp")}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
