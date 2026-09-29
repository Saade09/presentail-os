import { useRef, useState, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Upload, FileSpreadsheet, AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";

type LbBankAccount = {
  id: number;
  bank_name: string;
  account_name: string;
  masked_account_number: string | null;
  currency: string;
  odoo_journal_name: string | null;
};

interface UploadStatementModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called on successful upload instead of navigating automatically. */
  onSuccess?: (statementId: number) => void;
  /** Pre-select a specific account when opening for a specific card. */
  preselectedAccountId?: number | null;
}

const ACCEPTED_EXTENSIONS = [".xls", ".xlsx"];

function formatAccountLabel(account: LbBankAccount): string {
  const parts: string[] = [`${account.bank_name} — ${account.account_name}`];
  if (account.masked_account_number) parts.push(`(${account.masked_account_number})`);
  parts.push(account.currency);
  return parts.join(" ");
}

export default function UploadStatementModal({
  open,
  onOpenChange,
  onSuccess,
  preselectedAccountId,
}: UploadStatementModalProps) {
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset state when modal opens (apply preselection)
  useEffect(() => {
    if (open) {
      setSelectedAccountId(preselectedAccountId ? String(preselectedAccountId) : "");
      setSelectedFile(null);
      setIsDragOver(false);
      setUploadProgress(0);
      setIsUploading(false);
      setErrorMessage(null);
    }
  }, [open]);

  const { data: accountsData, isLoading: accountsLoading } = useQuery<{
    accounts: LbBankAccount[];
  }>({
    queryKey: ["lb-bank-recon-accounts"],
    queryFn: () => apiFetch("/api/lb-bank-recon/accounts"),
    enabled: open,
    staleTime: 60_000,
  });

  const accounts = accountsData?.accounts ?? [];

  const validateFile = (file: File): string | null => {
    const name = file.name.toLowerCase();
    const hasValidExt = ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext));
    if (!hasValidExt) {
      return `Invalid file type. Please upload an Excel file (.xls or .xlsx).`;
    }
    if (file.size > 10 * 1024 * 1024) {
      return "File exceeds the 10 MB limit. Please select a smaller file.";
    }
    return null;
  };

  const handleFileSelect = useCallback((file: File) => {
    const err = validateFile(file);
    if (err) {
      setErrorMessage(err);
      setSelectedFile(null);
    } else {
      setErrorMessage(null);
      setSelectedFile(file);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    // Reset so same file can be re-selected after an error
    e.target.value = "";
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  };

  const handleUpload = async () => {
    if (!selectedFile || !selectedAccountId) return;

    setIsUploading(true);
    setUploadProgress(0);
    setErrorMessage(null);

    const token = await getClerkToken();

    const formData = new FormData();
    formData.append("statement", selectedFile);
    formData.append("account_id", selectedAccountId);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        // Reserve the last 10% for server-side parse
        setUploadProgress(Math.round((e.loaded / e.total) * 88));
      }
    });

    xhr.addEventListener("load", () => {
      setUploadProgress(100);
      if (xhr.status === 201) {
        try {
          const body = JSON.parse(xhr.responseText) as {
            preview: { statementId: number };
          };
          const id = body.preview.statementId;
          setIsUploading(false);
          onOpenChange(false);
          if (onSuccess) {
            onSuccess(id);
          } else {
            navigate(`/finance/accounting/reconciliation/review/${id}`);
          }
        } catch {
          setIsUploading(false);
          setErrorMessage("Unexpected server response. Please try again.");
        }
      } else {
        setIsUploading(false);
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          setErrorMessage(body.error ?? `Upload failed (HTTP ${xhr.status}).`);
        } catch {
          setErrorMessage(`Upload failed (HTTP ${xhr.status}). Please try again.`);
        }
      }
    });

    xhr.addEventListener("error", () => {
      setIsUploading(false);
      setErrorMessage("Network error during upload. Check your connection and try again.");
    });

    xhr.addEventListener("abort", () => {
      setIsUploading(false);
      setErrorMessage("Upload was cancelled.");
    });

    xhr.withCredentials = true;
    xhr.open("POST", "/api/lb-bank-recon/statements/upload");
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(formData);
  };

  const canUpload = !!selectedAccountId && !!selectedFile && !isUploading;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isUploading) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Upload Bank Statement</DialogTitle>
          <DialogDescription>
            Select the bank account this statement belongs to, then upload your file.
            Excel or CSV (.xls, .xlsx) formats are accepted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Bank account selector */}
          <div className="space-y-1.5">
            <Label htmlFor="account-select">Bank Account</Label>
            {accountsLoading ? (
              <div className="h-9 rounded-md border bg-muted animate-pulse" />
            ) : accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Lebanese bank accounts are configured for this workspace.
              </p>
            ) : (
              <Select
                value={selectedAccountId}
                onValueChange={setSelectedAccountId}
                disabled={isUploading}
              >
                <SelectTrigger id="account-select">
                  <SelectValue placeholder="Select a bank account…" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {formatAccountLabel(acc)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* File drop zone */}
          <div className="space-y-1.5">
            <Label>Statement File</Label>
            <div
              className={cn(
                "relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors cursor-pointer",
                isDragOver
                  ? "border-primary bg-primary/5"
                  : selectedFile
                  ? "border-green-400 bg-green-50"
                  : "border-muted-foreground/25 hover:border-primary/40 hover:bg-muted/30",
                isUploading && "pointer-events-none opacity-60",
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !isUploading && fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !isUploading) {
                  fileInputRef.current?.click();
                }
              }}
              aria-label="Drop file here or click to browse"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xls,.xlsx"
                className="hidden"
                onChange={handleInputChange}
                disabled={isUploading}
              />

              {selectedFile ? (
                <>
                  <FileSpreadsheet className="w-10 h-10 text-green-600" />
                  <div>
                    <p className="text-sm font-medium text-green-700">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {(selectedFile.size / 1024).toFixed(0)} KB
                    </p>
                  </div>
                  {!isUploading && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute top-2 right-2 h-7 w-7 p-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFile(null);
                        setErrorMessage(null);
                      }}
                      aria-label="Remove selected file"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Upload className="w-10 h-10 text-muted-foreground/60" />
                  <div>
                    <p className="text-sm font-medium">
                      Drop your file here, or{" "}
                      <span className="text-primary">browse</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Excel or CSV · Max 10 MB
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Uploading and parsing…</span>
                <span>{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-2" />
            </div>
          )}

          {/* Error message */}
          {errorMessage && (
            <Alert variant="destructive" className="py-3">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">{errorMessage}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => { void handleUpload(); }}
            disabled={!canUpload}
          >
            {isUploading ? "Uploading…" : "Upload Statement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
