import { useRef, useState } from "react";
import { ImageIcon, Upload, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useUpload } from "@workspace/object-storage-web";
import { getClerkToken } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { cn } from "@/lib/utils";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

type Props = {
  currentImageUrl: string | null;
  onChange: (url: string | null) => void;
  onUploadingChange?: (uploading: boolean) => void;
  label: string;
  disabled?: boolean;
};

export function AttributeImageUpload({
  currentImageUrl,
  onChange,
  onUploadingChange,
  label,
  disabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const { uploadFile, isUploading, progress } = useUpload({
    getAuthToken: getClerkToken,
    onSuccess: (res) => {
      onUploadingChange?.(false);
      onChange(res.objectPath);
    },
    onError: (err) => {
      onUploadingChange?.(false);
      setLocalError(err.message);
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLocalError(null);

    if (!ALLOWED_TYPES.includes(file.type)) {
      setLocalError("Unsupported file type. Allowed: JPEG, PNG, WebP.");
      e.target.value = "";
      return;
    }

    if (file.size > MAX_SIZE_BYTES) {
      setLocalError(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 5 MB.`,
      );
      e.target.value = "";
      return;
    }

    onUploadingChange?.(true);
    uploadFile(file);
    e.target.value = "";
  }

  const resolvedUrl = imageUrl(currentImageUrl);

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || isUploading}
      />

      {resolvedUrl ? (
        <div className="flex items-start gap-3">
          <img
            src={resolvedUrl}
            alt=""
            className="h-20 w-20 rounded-md object-cover border border-border shrink-0"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || isUploading}
            >
              {isUploading ? (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              ) : (
                <Upload size={14} className="mr-1.5" />
              )}
              {isUploading ? `Uploading ${progress}%` : "Replace"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => onChange(null)}
              disabled={disabled || isUploading}
            >
              <X size={14} className="mr-1.5" />
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border p-6 cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/30",
            (disabled || isUploading) &&
              "cursor-not-allowed opacity-50 pointer-events-none",
          )}
          onClick={() =>
            !disabled && !isUploading && inputRef.current?.click()
          }
        >
          {isUploading ? (
            <>
              <Loader2
                size={24}
                className="text-muted-foreground animate-spin"
              />
              <p className="text-sm text-muted-foreground">
                Uploading… {progress}%
              </p>
            </>
          ) : (
            <>
              <ImageIcon size={24} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground text-center">
                Click to upload image
                <span className="block text-xs mt-0.5">
                  PNG, JPG, WebP · Max 5 MB
                </span>
              </p>
            </>
          )}
        </div>
      )}

      {localError && (
        <p className="text-xs text-destructive">{localError}</p>
      )}
    </div>
  );
}
