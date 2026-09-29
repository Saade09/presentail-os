import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/queryClient";
import { Printer } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

type Config = {
  shops: string[];
};

type LocationRow = {
  id: number;
  name: string;
};

export default function CardMessageForm() {
  const { t } = useTranslation();

  const [config, setConfig] = useState<Config | null>(null);
  const [location, setLocation] = useState("");
  const [shopName, setShopName] = useState("");
  const [orderId, setOrderId] = useState("");
  const [toName, setToName] = useState("");
  const [fromName, setFromName] = useState("");
  const [cardMessage, setCardMessage] = useState("");
  const [cakeMode, setCakeMode] = useState(false);
  const [cakeLocation, setCakeLocation] = useState("");
  const [cakeMessage, setCakeMessage] = useState("");

  const [printing, setPrinting] = useState(false);
  const [result, setResult] = useState<"success" | "error" | "no_printer" | null>(null);

  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: LocationRow[] }>("/api/locations"),
  });
  const locations = locationsData?.locations ?? [];

  useEffect(() => {
    apiFetch("/api/card-message/config")
      .then((data: Config) => setConfig(data))
      .catch(() => setConfig({ shops: [] }));
  }, []);

  const shops = config?.shops ?? [];

  // Card message textarea appears once a shop is selected.
  const showCardMessage = !!shopName;

  const selectedLocation = locations.find((l) => String(l.id) === location);
  const locationLabel = selectedLocation?.name ?? location;

  const canPrint =
    cakeMode ? !!cakeLocation && !!cakeMessage.trim()
      : !!location && !!shopName && !!orderId.trim() && !!cardMessage.trim();

  const buttonLabel = printing
    ? t("cardMessage.printing")
    : cakeMode ? t("cardMessage.printCake")
    : location && shopName
    ? t("cardMessage.printButtonWithDetails", { location: locationLabel, shop: shopName })
    : t("cardMessage.printButton");

  async function handlePrint() {
    if (!canPrint) return;
    setPrinting(true);
    setResult(null);
    try {
      await apiFetch(cakeMode ? "/api/card-message/print-cake" : "/api/card-message/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cakeMode ? {
          location: cakeLocation,
          cakeMessage: cakeMessage.trim(),
        } : {
          location: locationLabel,
          shopName,
          orderId: orderId.trim(),
          cardMessage: cardMessage.trim(),
          ...(toName.trim() ? { toName: toName.trim() } : {}),
          ...(fromName.trim() ? { fromName: fromName.trim() } : {}),
        }),
      });
      setResult("success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!cakeMode && msg.includes("no_printer_configured")) {
        setResult("no_printer");
      } else {
        setResult("error");
      }
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <div className="bg-white rounded-2xl border border-border shadow-sm p-8 space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("cardMessage.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("cardMessage.subtitle")}</p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox id="cm-cake-mode" checked={cakeMode} onCheckedChange={(checked) => {
              setCakeMode(checked === true);
              setResult(null);
            }} />
            <Label htmlFor="cm-cake-mode">{t("cardMessage.cakeMode")}</Label>
          </div>
          {cakeMode ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="cm-cake-location">{t("cardMessage.location")}</Label>
                <Select value={cakeLocation} onValueChange={(value) => { setCakeLocation(value); setResult(null); }}>
                  <SelectTrigger id="cm-cake-location"><SelectValue placeholder={t("cardMessage.locationPlaceholder")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Achrafieh">Achrafieh</SelectItem>
                    <SelectItem value="Jdeideh">Jdeideh</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cm-cake-message">{t("cardMessage.cakeMessage")}</Label>
                <Textarea id="cm-cake-message" value={cakeMessage} placeholder={t("cardMessage.cakeMessagePlaceholder")}
                  onChange={(e) => { setCakeMessage(e.target.value); setResult(null); }} />
              </div>
            </>
          ) : (
          <>
          {/* Location */}
          <div className="space-y-1.5">
            <Label htmlFor="cm-location">{t("cardMessage.location")}</Label>
            <Select
              value={location}
              onValueChange={(v) => {
                setLocation(v);
                setResult(null);
              }}
            >
              <SelectTrigger id="cm-location" className="w-full rounded-lg">
                <SelectValue placeholder={t("cardMessage.locationPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={String(loc.id)}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Shop Name */}
          <div className="space-y-1.5">
            <Label htmlFor="cm-shop">{t("cardMessage.shopName")}</Label>
            <Select
              value={shopName}
              onValueChange={(v) => {
                setShopName(v);
                setToName("");
                setFromName("");
                setResult(null);
              }}
            >
              <SelectTrigger id="cm-shop" className="w-full rounded-lg">
                <SelectValue placeholder={t("cardMessage.shopNamePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {shops.length === 0 ? (
                  <SelectItem value="__none" disabled>
                    {t("cardMessage.noShopsConfigured")}
                  </SelectItem>
                ) : (
                  shops.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Order ID */}
          <div className="space-y-1.5">
            <Label htmlFor="cm-order-id">{t("cardMessage.orderId")}</Label>
            <Input
              id="cm-order-id"
              className="rounded-lg"
              placeholder={t("cardMessage.orderIdPlaceholder")}
              value={orderId}
              onChange={(e) => {
                setOrderId(e.target.value);
                setResult(null);
              }}
            />
          </div>

          {/* Optional To / From fields are available for every shop. */}
          {showCardMessage && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="cm-to">{t("cardMessage.toName")}</Label>
                <Input
                  id="cm-to"
                  className="rounded-lg"
                  placeholder={t("cardMessage.toNamePlaceholder")}
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cm-from">{t("cardMessage.fromName")}</Label>
                <Input
                  id="cm-from"
                  className="rounded-lg"
                  placeholder={t("cardMessage.fromNamePlaceholder")}
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                />
              </div>
            </>
          )}

          {/* Card Message — shown once Shop Name is selected */}
          {showCardMessage && (
            <div className="space-y-1.5">
              <Label htmlFor="cm-message">{t("cardMessage.cardMessage")}</Label>
              <Textarea
                id="cm-message"
                className="rounded-lg w-full min-h-[120px] resize-y"
                placeholder={t("cardMessage.cardMessagePlaceholder")}
                value={cardMessage}
                onChange={(e) => {
                  setCardMessage(e.target.value);
                  setResult(null);
                }}
              />
            </div>
          )}
          </>
          )}
        </div>

        {/* Feedback messages */}
        {result === "success" && (
          <p className="text-sm font-medium text-green-600">{t(cakeMode ? "cardMessage.cakeSuccessMessage" : "cardMessage.successMessage")}</p>
        )}
        {result === "error" && (
          <p className="text-sm font-medium text-destructive">{t(cakeMode ? "cardMessage.cakeErrorMessage" : "cardMessage.errorMessage")}</p>
        )}
        {result === "no_printer" && (
          <p className="text-sm font-medium text-amber-600">{t("cardMessage.noPrinterMessage")}</p>
        )}

        {/* Print Button */}
        <Button
          className="w-full bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg"
          disabled={!canPrint || printing}
          onClick={handlePrint}
        >
          <Printer className="mr-2 h-4 w-4" />
          {buttonLabel}
        </Button>
      </div>
    </div>
  );
}
