import { useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getClerkToken } from "@/lib/queryClient";
import { Download, Plus } from "lucide-react";

const CURRENCIES = ["USD", "AED", "EUR", "GBP", "SAR", "LBP"] as const;

interface CreateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CreateInvoiceDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateInvoiceDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [item, setItem] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [generating, setGenerating] = useState(false);

  const amountTrimmed = amount.trim();
  const amountNumber = amountTrimmed === "" ? null : Number(amountTrimmed);
  const amountInvalid =
    amountTrimmed !== "" &&
    (!Number.isFinite(amountNumber) || (amountNumber as number) < 0);

  function resetForm() {
    setName("");
    setEmail("");
    setAddress("");
    setItem("");
    setAmount("");
    setCurrency("USD");
  }

  async function handleGenerate() {
    if (amountInvalid || generating) return;
    setGenerating(true);
    try {
      const token = await getClerkToken();
      const res = await fetch("/api/invoices/generate", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: name.trim() || null,
          email: email.trim() || null,
          address: address.trim() || null,
          item: item.trim() || null,
          amount: amountNumber,
          currency,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? "Invoice.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast({ title: t("generateInvoice.successTitle") });
      onSuccess();
      onOpenChange(false);
      resetForm();
    } catch {
      toast({
        title: t("generateInvoice.errorTitle"),
        description: t("generateInvoice.errorDesc"),
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("generateInvoice.title")}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-2">
          {t("generateInvoice.subtitle")}
        </p>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ci-name">{t("generateInvoice.name")}</Label>
            <Input
              id="ci-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("generateInvoice.namePlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ci-email">{t("generateInvoice.email")}</Label>
            <Input
              id="ci-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("generateInvoice.emailPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ci-address">{t("generateInvoice.address")}</Label>
            <Input
              id="ci-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t("generateInvoice.addressPlaceholder")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ci-item">{t("generateInvoice.item")}</Label>
            <Textarea
              id="ci-item"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              placeholder={t("generateInvoice.itemPlaceholder")}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ci-amount">{t("generateInvoice.amount")}</Label>
              <Input
                id="ci-amount"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={t("generateInvoice.amountPlaceholder")}
              />
              {amountInvalid && (
                <p className="text-xs text-destructive">
                  {t("generateInvoice.amountInvalid")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ci-currency">{t("generateInvoice.currency")}</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger id="ci-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">{t("generateInvoice.issuerNote")}</p>

        <Button
          className="w-full"
          onClick={handleGenerate}
          disabled={generating || amountInvalid}
        >
          <Download className="h-4 w-4 me-2" />
          {generating
            ? t("generateInvoice.generating")
            : t("generateInvoice.generateButton")}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

interface CreateInvoiceButtonProps {
  onSuccess: () => void;
}

export function CreateInvoiceButton({ onSuccess }: CreateInvoiceButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4 me-2" />
        {t("invoices.createButton")}
      </Button>
      <CreateInvoiceDialog open={open} onOpenChange={setOpen} onSuccess={onSuccess} />
    </>
  );
}
