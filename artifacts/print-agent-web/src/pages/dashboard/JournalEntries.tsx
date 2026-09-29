import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";

export default function JournalEntriesPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center p-8">
      <FileText className="w-12 h-12 text-muted-foreground" />
      <h1 className="text-2xl font-semibold">{t("nav.journalEntries")}</h1>
      <p className="text-muted-foreground max-w-sm">{t("common.comingSoon")}</p>
    </div>
  );
}
