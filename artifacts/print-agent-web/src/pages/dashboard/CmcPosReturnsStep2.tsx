import { useRef, useState, useId } from "react";
import {
  Truck,
  Clock,
  Send,
  ImageIcon,
  X,
  Loader2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { COLLECTION_METHODS } from "@/hooks/useCmcReturns";
import type { CollectionMethod } from "@/hooks/useCmcReturns";
import { useReturnsContext } from "./CmcPosReturnsContext";
import { apiFetch } from "@/lib/queryClient";

const MAX_PHOTOS = 5;
const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const COLLECTION_ICONS: Record<CollectionMethod, React.ElementType> = {
  next_delivery: Truck,
  asap: Clock,
  self_send: Send,
};

interface PhotoEntry {
  id: string;
  file: File;
  url: string | null;
  progress: "uploading" | "done" | "error";
  error: string | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function CmcPosReturnsStep2() {
  const { draft, updateDetails, setStep } = useReturnsContext();
  const { notes, collection_method, collection_date, photo_urls } = draft.details;

  const [photos, setPhotos] = useState<PhotoEntry[]>(
    // Initialise from already-uploaded URLs so going back preserves photos
    photo_urls.map((url, i) => ({
      id: `existing-${i}`,
      file: new File([], ""),
      url,
      progress: "done" as const,
      error: null,
    })),
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const notesId = useId();
  const dateId = useId();

  const canAddMore = photos.length < MAX_PHOTOS;

  const handleFilesSelected = async (files: FileList | null) => {
    if (!files) return;
    const toAdd = Array.from(files).slice(0, MAX_PHOTOS - photos.length);
    const newEntries: PhotoEntry[] = toAdd.map((f) => ({
      id: `photo-${Date.now()}-${Math.random()}`,
      file: f,
      url: null,
      progress: "uploading" as const,
      error: f.size > MAX_PHOTO_SIZE_BYTES ? "File exceeds 10 MB" : null,
    }));
    setPhotos((prev) => [...prev, ...newEntries]);

    for (const entry of newEntries) {
      if (entry.error) {
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === entry.id ? { ...p, progress: "error" } : p,
          ),
        );
        continue;
      }
      try {
        const fd = new FormData();
        fd.append("photo", entry.file);
        const res = await apiFetch<{ url: string }>(
          "/api/cmc-pos/returns/upload-photo",
          { method: "POST", body: fd },
        );
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === entry.id
              ? { ...p, url: res.url, progress: "done" }
              : p,
          ),
        );
      } catch {
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === entry.id
              ? { ...p, progress: "error", error: "Upload failed" }
              : p,
          ),
        );
      }
    }
  };

  const retryUpload = async (id: string) => {
    const entry = photos.find((p) => p.id === id);
    if (!entry) return;
    setPhotos((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, progress: "uploading", error: null } : p,
      ),
    );
    try {
      const fd = new FormData();
      fd.append("photo", entry.file);
      const res = await apiFetch<{ url: string }>(
        "/api/cmc-pos/returns/upload-photo",
        { method: "POST", body: fd },
      );
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, url: res.url, progress: "done", error: null } : p,
        ),
      );
    } catch {
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, progress: "error", error: "Upload failed" } : p,
        ),
      );
    }
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const doneUrls = photos.filter((p) => p.progress === "done" && p.url).map((p) => p.url!);
  const hasUploading = photos.some((p) => p.progress === "uploading");
  const hasError = photos.some((p) => p.progress === "error");

  const canContinue =
    collection_method &&
    collection_date &&
    !hasUploading;

  const handleContinue = () => {
    updateDetails({ photo_urls: doneUrls });
    setStep(2);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Step header */}
      <div>
        <h2 className="text-base font-semibold" id="step2-heading" tabIndex={-1}>
          Step 2 of 3 — Return details
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Provide collection preferences and any condition notes.
        </p>
      </div>

      {/* Condition notes */}
      <div className="space-y-1.5">
        <Label htmlFor={notesId}>
          Condition notes <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id={notesId}
          value={notes}
          onChange={(e) =>
            updateDetails({ notes: e.target.value.slice(0, 300) })
          }
          placeholder="Describe the condition of the items…"
          className="resize-none"
          rows={3}
          maxLength={300}
          aria-label="Condition notes"
        />
        <p className="text-xs text-muted-foreground text-right">
          {notes.length}/300
        </p>
      </div>

      {/* Collection method */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Collection method</Label>
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Collection method">
          {COLLECTION_METHODS.map((m) => {
            const Icon = COLLECTION_ICONS[m.value];
            const selected = collection_method === m.value;
            return (
              <label
                key={m.value}
                className={`flex items-start gap-3 rounded-lg border p-3.5 cursor-pointer transition-colors ${
                  selected
                    ? "border-teal-700 bg-teal-50/50"
                    : "border-border hover:bg-muted/30"
                }`}
              >
                <input
                  type="radio"
                  name="collection_method"
                  value={m.value}
                  checked={selected}
                  onChange={() => updateDetails({ collection_method: m.value })}
                  className="sr-only"
                  aria-label={m.label}
                />
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    selected ? "bg-teal-700" : "bg-muted"
                  }`}
                >
                  <Icon className={`h-5 w-5 ${selected ? "text-white" : "text-muted-foreground"}`} />
                </div>
                <div>
                  <p className={`text-sm font-medium ${selected ? "text-teal-800" : ""}`}>
                    {m.label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>
                </div>
                {selected && (
                  <div className="ml-auto mt-1 h-4 w-4 rounded-full border-2 border-teal-700 bg-teal-700 flex items-center justify-center">
                    <div className="h-1.5 w-1.5 rounded-full bg-white" />
                  </div>
                )}
              </label>
            );
          })}
        </div>
      </div>

      {/* Collection date */}
      <div className="space-y-1.5">
        <Label htmlFor={dateId}>
          Collection date <span className="text-destructive">*</span>
        </Label>
        <Input
          id={dateId}
          type="date"
          value={collection_date}
          min={todayIso()}
          onChange={(e) => updateDetails({ collection_date: e.target.value })}
          aria-required="true"
          aria-label="Collection date"
          className="max-w-xs"
        />
      </div>

      {/* Photo upload */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>
            Photos <span className="text-muted-foreground font-normal text-xs">(optional, up to {MAX_PHOTOS}, 10 MB each)</span>
          </Label>
          <span className="text-xs text-muted-foreground">
            {photos.length}/{MAX_PHOTOS}
          </span>
        </div>

        {/* Thumbnails */}
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {photos.map((p) => (
              <div
                key={p.id}
                className="relative h-16 w-16 rounded-lg border overflow-hidden bg-muted"
              >
                {p.url ? (
                  <img
                    src={p.url}
                    alt="Return photo"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center">
                    {p.progress === "uploading" ? (
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-destructive" />
                    )}
                  </div>
                )}
                {p.progress === "error" && (
                  <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => retryUpload(p.id)}
                      className="text-white"
                      aria-label="Retry upload"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePhoto(p.id)}
                  className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-black/60 flex items-center justify-center hover:bg-black/80"
                  aria-label="Remove photo"
                >
                  <X className="h-3 w-3 text-white" />
                </button>
                {p.error && p.progress === "error" && (
                  <div className="absolute bottom-0 left-0 right-0 bg-red-600/90 text-white text-[9px] px-1 py-0.5 truncate">
                    {p.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Upload area */}
        {canAddMore && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png"
              multiple
              className="hidden"
              id="return-photos-input"
              aria-label="Upload return photos"
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center justify-center w-full rounded-lg border-2 border-dashed border-border py-6 gap-2 text-muted-foreground hover:border-teal-700/50 hover:bg-muted/20 transition-colors"
              aria-label="Upload photos"
            >
              <ImageIcon className="h-6 w-6" />
              <span className="text-sm">Click to upload photos</span>
              <span className="text-xs">JPG or PNG, up to 10 MB each</span>
            </button>
          </div>
        )}

        {hasError && (
          <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Some photos failed to upload. Use the retry button on each failed photo.</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep(0)}
          aria-label="Back to step 1"
        >
          Back
        </Button>
        <Button
          className="bg-teal-700 hover:bg-teal-800 text-white"
          disabled={!canContinue}
          onClick={handleContinue}
          aria-label="Continue to step 3"
        >
          {hasUploading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Uploading…
            </>
          ) : (
            "Continue"
          )}
        </Button>
      </div>
    </div>
  );
}
