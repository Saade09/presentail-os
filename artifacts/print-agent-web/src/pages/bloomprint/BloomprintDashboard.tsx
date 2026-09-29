import { useRef, useState } from "react";
import { useLocation, Link } from "wouter";
import {
  bloomprintErrorMessage,
  useBloomprintDrafts,
  useCreateBloomprintDraft,
} from "@/hooks/use-bloomprint";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  ArrowRight,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import { StyleProfilesPanel } from "./StyleProfilesPanel";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { imageUrl } from "@/lib/imageUrl";
import { getClerkToken } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";

const MAX_INSPIRATION_IMAGE_BYTES = 12 * 1024 * 1024;
const INSPIRATION_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

function validateInspirationImage(file: File): string | null {
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
    return "Choose a JPEG, PNG, WebP, or GIF image.";
  }
  if (file.size > MAX_INSPIRATION_IMAGE_BYTES) {
    return "Choose an image no larger than 12 MB.";
  }
  return null;
}

export default function BloomprintDashboard() {
  const [, setLocation] = useLocation();
  const {
    data: drafts,
    error: draftsError,
    isError: isDraftsError,
    isFetching: isFetchingDrafts,
    isLoading,
    refetch: refetchDrafts,
  } = useBloomprintDrafts();
  const createDraft = useCreateBloomprintDraft();
  const [isProfilesOpen, setIsProfilesOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasPermissionError = isPermissionError(draftsError);

  const { uploadFile, isUploading } = useUpload({
    getAuthToken: getClerkToken,
    onSuccess: (response) => {
      createDraft.mutate(
        { inspiration_image_path: response.objectPath },
        {
          onSuccess: (draft) => {
            setLocation(`/bloomprint/${draft.id}`);
          },
          onError: (error) => {
            setUploadError(
              `Draft creation failed: ${bloomprintErrorMessage(
                error,
                "The draft could not be created.",
              )} Please try again.`,
            );
          },
        }
      );
    },
    onError: (err) => {
      setUploadError(
        `Upload failed: ${bloomprintErrorMessage(
          err,
          "The inspiration image could not be uploaded.",
        )} Please try again.`,
      );
    }
  });
  const actionPending = isUploading || createDraft.isPending;

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset before starting the request so selecting the same file after a
    // failure still produces a change event.
    e.currentTarget.value = "";
    if (file) {
      setUploadError(null);
      const validationError = validateInspirationImage(file);
      if (validationError) {
        setUploadError(validationError);
        return;
      }
      uploadFile(file);
    }
  };

  const openImagePicker = () => {
    if (!actionPending) fileInputRef.current?.click();
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Sparkles className="w-7 h-7 text-primary" />
            Bloomprint
          </h1>
          <p className="text-muted-foreground mt-1">
            Turn inspiration photos into fully costed, generative products.
          </p>
        </div>
        {!hasPermissionError && (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setIsProfilesOpen(true)} disabled={actionPending}>
              <Settings2 className="w-4 h-4 mr-2" />
              Style Profiles
            </Button>
            <Button
              type="button"
              onClick={openImagePicker}
              disabled={actionPending}
              data-testid="button-new-bloomprint-draft"
            >
              {actionPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              {actionPending ? "Processing…" : "New Draft"}
            </Button>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        accept={INSPIRATION_IMAGE_ACCEPT}
        aria-label="Choose Bloomprint inspiration image"
        onChange={handleUpload}
        disabled={actionPending || hasPermissionError}
      />

      {uploadError && (
        <div
          className="flex items-start gap-2 p-4 bg-destructive/10 border border-destructive/20 text-destructive rounded-lg text-sm"
          role="alert"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {uploadError}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : isDraftsError ? (
        <div
          className="p-12 border border-destructive/20 bg-destructive/5 rounded-xl flex flex-col items-center justify-center text-center"
          role="alert"
        >
          <AlertCircle className="w-10 h-10 text-destructive mb-4" />
          <h2 className="text-lg font-semibold text-destructive">
            {hasPermissionError ? "Bloomprint access required" : "Couldn’t load Bloomprint drafts"}
          </h2>
          <p className="text-sm text-muted-foreground max-w-md mt-2">
            {hasPermissionError
              ? bloomprintErrorMessage(draftsError, "Ask a workspace owner to grant Manage products access.")
              : bloomprintErrorMessage(
                  draftsError,
                  "The draft list could not be loaded.",
                )}
          </p>
          {!hasPermissionError && (
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => void refetchDrafts()}
              disabled={isFetchingDrafts}
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isFetchingDrafts ? "animate-spin" : ""}`} />
              {isFetchingDrafts ? "Retrying…" : "Retry"}
            </Button>
          )}
        </div>
      ) : !drafts || drafts.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-16 border border-dashed border-border rounded-2xl bg-muted/20">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <ImageIcon className="w-8 h-8 text-primary" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No drafts yet</h2>
          <p className="text-muted-foreground text-center max-w-sm mb-6">
            Upload an inspiration photo to generate a new product draft complete with recipes and descriptions.
          </p>
          <Button
            type="button"
            size="lg"
            onClick={openImagePicker}
            disabled={actionPending}
            data-testid="button-upload-bloomprint-inspiration"
          >
            {actionPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {actionPending ? "Processing…" : "Upload Inspiration"}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {drafts.map(draft => (
            <Link key={draft.id} href={`/bloomprint/${draft.id}`}>
              <div className="group border border-border rounded-2xl overflow-hidden bg-card hover:border-primary/40 transition-all hover:shadow-md cursor-pointer flex flex-col h-full">
                <div className="aspect-[4/3] bg-muted relative overflow-hidden">
                  <img 
                    src={imageUrl(draft.generated_image_path || draft.inspiration_image_path) || ""} 
                    alt={draft.name || "Draft image"} 
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  <div className="absolute top-3 right-3">
                    <Badge variant="secondary" className="shadow-sm backdrop-blur-md bg-background/80">
                      {draft.status === "draft" ? "Draft" : draft.status === "rendered" ? "Rendered" : "Approved"}
                    </Badge>
                  </div>
                </div>
                <div className="p-5 flex-1 flex flex-col">
                  <h3 className="font-semibold text-lg line-clamp-1 mb-1">
                    {draft.name || "Untitled Draft"}
                  </h3>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-4 flex-1">
                    {draft.description || draft.analysis?.visual_summary || "No description generated yet."}
                  </p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(draft.created_at), "MMM d, yyyy")}
                    </span>
                    <span className="text-primary text-sm font-medium flex items-center group-hover:translate-x-1 transition-transform">
                      Review <ArrowRight className="w-4 h-4 ml-1" />
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      <StyleProfilesPanel open={isProfilesOpen} onOpenChange={setIsProfilesOpen} />
    </div>
  );
}
