import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Camera,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import {
  useSetFloristOrderPhoto,
  useRemoveFloristOrderPhoto,
  useVerifyFloristOrder,
  useUpdateOrderFloristPublication,
} from "@workspace/api-client-react";
import type {
  FloristOrderCard,
  FloristPublication,
  FloristVerificationState,
} from "@workspace/api-client-react";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const COMPRESS_MAX_DIMENSION = 1600;
const COMPRESS_TRIGGER_BYTES = 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PhotoSlot = "items" | "card" | "card_on_box";

/**
 * Downscale + re-encode oversized camera images to JPEG on the client so
 * mobile photos (often 5-12 MB HEIC/JPEG) upload quickly. Falls back to the
 * original file when decoding fails (server still validates type/size).
 */
export async function compressFloristEvidenceImage(
  file: File,
  slot: PhotoSlot,
): Promise<Blob> {
  // Card writing can occupy only a small part of the frame. Preserve the
  // accepted upload byte-for-byte; the server derives a separate enhanced
  // reading view without replacing this original evidence.
  if (slot === "card" && ALLOWED_TYPES.has(file.type)) {
    return file;
  }
  if (file.size <= COMPRESS_TRIGGER_BYTES && ALLOWED_TYPES.has(file.type)) {
    return file;
  }
  try {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode failed"));
        el.src = objectUrl;
      });
      const scale = Math.min(
        1,
        COMPRESS_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight),
      );
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.82),
      );
      return blob && blob.size > 0 ? blob : file;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return file;
  }
}

type UploadUrlResponse = {
  uploadURL: string;
  objectPath: string;
  requiredUploadHeaders?: Record<string, string>;
};

export function FloristPhotoVerification({
  fo,
  onChanged,
  onVerificationChanged,
  onOrderStatusUpdated,
}: {
  fo: FloristOrderCard;
  onChanged: () => void;
  onVerificationChanged?: (verification: FloristVerificationState) => void;
  onOrderStatusUpdated?: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [uploadingSlot, setUploadingSlot] = useState<PhotoSlot | null>(null);

  const setPhotoMut = useSetFloristOrderPhoto();
  const removePhotoMut = useRemoveFloristOrderPhoto();
  const verifyMut = useVerifyFloristOrder();

  const status = fo.verification_status ?? "none";
  const hasCardMessage = fo.has_card;
  const needsCardOnBox = !!fo.has_cake && fo.has_card;
  const missingPhotos = [
    !fo.photo_items_path ? t("floristOrders.photoItemsLabel") : null,
    hasCardMessage && !fo.photo_card_path
      ? t("floristOrders.photoCardLabel")
      : null,
    needsCardOnBox && !fo.photo_card_on_box_path
      ? t("floristOrders.photoCardOnBoxLabel")
      : null,
  ].filter((label): label is string => label !== null);
  const hasAllRequiredPhotos = missingPhotos.length === 0;
  const approved = status === "approved";
  const busy =
    uploadingSlot !== null ||
    setPhotoMut.isPending ||
    removePhotoMut.isPending ||
    verifyMut.isPending;

  async function uploadPhoto(slot: PhotoSlot, file: File) {
    if (!ALLOWED_TYPES.has(file.type) && !file.type.startsWith("image/")) {
      toast({ title: t("floristOrders.photoInvalidType"), variant: "destructive" });
      return;
    }
    setUploadingSlot(slot);
    try {
      const blob = await compressFloristEvidenceImage(file, slot);
      if (blob.size > MAX_UPLOAD_BYTES) {
        toast({ title: t("floristOrders.photoTooLarge"), variant: "destructive" });
        return;
      }
      const contentType = blob.type || "image/jpeg";
      if (!ALLOWED_TYPES.has(contentType)) {
        toast({ title: t("floristOrders.photoInvalidType"), variant: "destructive" });
        return;
      }
      const res = await apiFetch<UploadUrlResponse>("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `florist-${slot}.jpg`,
          size: blob.size,
          contentType,
        }),
      });
      const putRes = await fetch(res.uploadURL, {
        method: "PUT",
        body: blob,
        headers: {
          "Content-Type": contentType,
          ...(res.requiredUploadHeaders ?? {}),
        },
      });
      if (!putRes.ok) throw new Error("Upload failed");
      const data = await setPhotoMut.mutateAsync({
        id: fo.id,
        slot,
        data: { objectPath: res.objectPath },
      });
      onVerificationChanged?.(data.verification);
      onChanged();
    } catch (err) {
      toast({
        title: t("floristOrders.photoUploadFailed"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setUploadingSlot(null);
    }
  }

  function removePhoto(slot: PhotoSlot) {
    removePhotoMut.mutate(
      { id: fo.id, slot },
      {
        onSuccess: (data) => {
          onVerificationChanged?.(data.verification);
          onChanged();
        },
        onError: (e) =>
          toast({
            title: t("floristOrders.actionFailed"),
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          }),
      },
    );
  }

  function handleVerify() {
    verifyMut.mutate(
      { id: fo.id },
      {
        onSuccess: (data) => {
          if (data.order_status_updated) {
            onOrderStatusUpdated?.();
          }
          onChanged();
          if (data.verification?.verification_status === "approved") {
            toast({ title: t("floristOrders.verificationApprovedToast") });
          }
        },
        onError: (e) => {
          onChanged();
          toast({
            title: t("floristOrders.verifyFailedToast"),
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          });
        },
      },
    );
  }

  // Progress badge: one compact state summary for the card.
  let stateKey: string;
  if (approved) {
    stateKey = "readyToComplete";
  } else if (verifyMut.isPending || status === "verifying") {
    stateKey = "verifying";
  } else if (status === "rejected") {
    stateKey = "verificationFailed";
  } else {
    stateKey = "photosRequired";
  }

  return (
    <div
      className="rounded-lg border p-3 space-y-3"
      data-testid={`photo-verification-${fo.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-muted-foreground" />
          {t("floristOrders.photoStepTitle")}
        </p>
        <Badge
          variant="outline"
          className={
            stateKey === "readyToComplete"
              ? "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30"
              : stateKey === "verificationFailed"
                ? "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
          }
          data-testid={`photo-state-${fo.id}`}
        >
          {t(`floristOrders.photoState.${stateKey}`)}
        </Badge>
      </div>

      <div className={`grid gap-3 ${hasCardMessage ? "grid-cols-2" : "grid-cols-1"}`}>
        <PhotoSlotControl
          fo={fo}
          slot="items"
          label={t("floristOrders.photoItemsLabel")}
          path={fo.photo_items_path ?? null}
          uploading={uploadingSlot === "items"}
          disabled={busy}
          onFile={(file) => uploadPhoto("items", file)}
          onRemove={() => removePhoto("items")}
        />
        {hasCardMessage && (
          <div>
            <div className="mb-1.5 rounded-md border bg-muted/50 p-2 text-xs">
              <p className="font-medium text-muted-foreground mb-0.5">
                {t("floristOrders.expectedCardText")}
              </p>
              <p className="whitespace-pre-wrap break-words">{fo.card_message}</p>
            </div>
            <PhotoSlotControl
              fo={fo}
              slot="card"
              label={t("floristOrders.photoCardLabel")}
              path={fo.photo_card_path ?? null}
              uploading={uploadingSlot === "card"}
              disabled={busy}
              onFile={(file) => uploadPhoto("card", file)}
              onRemove={() => removePhoto("card")}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t("floristOrders.cardPhotoLegibleHint")}
            </p>
          </div>
        )}
      </div>
      {needsCardOnBox && (
        <PhotoSlotControl
          fo={fo}
          slot="card_on_box"
          label={t("floristOrders.photoCardOnBoxLabel")}
          path={fo.photo_card_on_box_path ?? null}
          uploading={uploadingSlot === "card_on_box"}
          disabled={busy}
          onFile={(file) => uploadPhoto("card_on_box", file)}
          onRemove={() => removePhoto("card_on_box")}
        />
      )}

      {status === "rejected" && (
        <div
          className="rounded-md border border-red-500/30 bg-red-500/10 p-2.5 text-sm space-y-1"
          data-testid={`verification-rejected-${fo.id}`}
        >
          <p className="font-medium flex items-center gap-1.5 text-red-700 dark:text-red-400">
            <TriangleAlert size={14} />
            {t("floristOrders.verificationFailedTitle")}
            {fo.verification_reason_code
              ? ` — ${t(`floristOrders.rejectionReason.${fo.verification_reason_code}`, {
                  defaultValue: fo.verification_reason_code,
                })}`
              : null}
          </p>
          {fo.verification_reason && (
            <p className="text-muted-foreground">{fo.verification_reason}</p>
          )}
          <p className="text-muted-foreground">{t("floristOrders.verificationRetryHint")}</p>
        </div>
      )}

      {approved && (
        <p
          className="text-sm text-green-700 dark:text-green-400 flex items-center gap-1.5"
          data-testid={`verification-approved-${fo.id}`}
        >
          <CheckCircle2 size={14} />
          {t("floristOrders.verificationApprovedToast")}
        </p>
      )}

      {!approved && (
        <div className="space-y-1.5">
          {!hasAllRequiredPhotos && (
            <p
              className="text-xs text-amber-700 dark:text-amber-400"
              data-testid={`missing-photos-${fo.id}`}
            >
              {t("floristOrders.missingPhotos", {
                photos: missingPhotos.join(", "),
              })}
            </p>
          )}
          <Button
            size="sm"
            className="gap-1.5 w-full"
            disabled={!hasAllRequiredPhotos || busy || status === "verifying"}
            onClick={handleVerify}
            data-testid={`button-verify-${fo.id}`}
          >
            {verifyMut.isPending || status === "verifying" ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t("floristOrders.verifying")}
              </>
            ) : (
              <>
                <ShieldCheck size={14} />
                {status === "rejected"
                  ? t("floristOrders.verifyRetry")
                  : t("floristOrders.verifyPhotos")}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function PhotoSlotControl({
  fo,
  slot,
  label,
  path,
  uploading,
  disabled,
  onFile,
  onRemove,
}: {
  fo: FloristOrderCard;
  slot: PhotoSlot;
  label: string;
  path: string | null;
  uploading: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);

  useEffect(() => {
    setPreviewFailed(false);
    setPreviewAttempt(0);
  }, [path]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file re-fires onChange.
    e.target.value = "";
    if (file) onFile(file);
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleChange}
        data-testid={`input-photo-camera-${slot}-${fo.id}`}
      />
      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleChange}
        data-testid={`input-photo-library-${slot}-${fo.id}`}
      />
      {path ? (
        <div className="space-y-1.5">
          {previewFailed ? (
            <div
              className="w-full aspect-square rounded-md bg-secondary flex flex-col items-center justify-center gap-2 p-3 text-center"
              data-testid={`photo-preview-failed-${slot}-${fo.id}`}
            >
              <TriangleAlert size={20} className="text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {t("floristOrders.photoPreviewUnavailable")}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setPreviewFailed(false);
                  setPreviewAttempt((attempt) => attempt + 1);
                }}
                data-testid={`button-retry-photo-preview-${slot}-${fo.id}`}
              >
                <RefreshCw size={13} />
                {t("floristOrders.retryPhotoPreview")}
              </Button>
            </div>
          ) : (
            <WorkspaceImage
              key={`${path}-${previewAttempt}`}
              src={imageUrl(path) ?? path}
              alt={label}
              className="w-full aspect-square rounded-md object-cover bg-secondary"
              onError={() => setPreviewFailed(true)}
              data-testid={`img-photo-${slot}-${fo.id}`}
            />
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-1 min-h-9"
              disabled={disabled}
              onClick={() => cameraInputRef.current?.click()}
              data-testid={`button-replace-photo-${slot}-${fo.id}`}
            >
              {uploading ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              {t("floristOrders.replacePhoto")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 min-h-9"
              disabled={disabled}
              onClick={() => libraryInputRef.current?.click()}
              aria-label={t("floristOrders.chooseFromLibrary")}
              data-testid={`button-replace-photo-library-${slot}-${fo.id}`}
            >
              <ImageIcon size={13} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 min-h-9"
              disabled={disabled}
              onClick={onRemove}
              aria-label={t("floristOrders.removePhoto")}
              data-testid={`button-remove-photo-${slot}-${fo.id}`}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 min-h-10 justify-start"
            disabled={disabled}
            onClick={() => cameraInputRef.current?.click()}
            data-testid={`button-take-photo-${slot}-${fo.id}`}
          >
            {uploading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Camera size={14} />
            )}
            {t("floristOrders.takePhoto")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 min-h-10 justify-start"
            disabled={disabled}
            onClick={() => libraryInputRef.current?.click()}
            data-testid={`button-choose-photo-${slot}-${fo.id}`}
          >
            <ImageIcon size={14} />
            {t("floristOrders.chooseFromLibrary")}
          </Button>
        </div>
      )}
    </div>
  );
}

type FloristPublicationAssignment = {
  photo_items_path?: string | null;
  photo_set_rev?: number;
  verification_status?: string;
  parent_order_status?: string;
  publication?: FloristPublication | null;
};

/**
 * Operations-only moderation control shared by the queue and Order Detail.
 * The API is the source of truth for revision and feed eligibility; this
 * component never constructs or exposes a public object URL.
 */
export function FloristPhotoPublicationControl({
  orderId,
  assignment,
}: {
  orderId: string;
  assignment: FloristPublicationAssignment;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const publicationMut = useUpdateOrderFloristPublication();
  const [savedPublication, setSavedPublication] = useState<FloristPublication | null>(null);
  const publication = savedPublication ?? assignment.publication;
  const sourcePublication = assignment.publication;
  const [checks, setChecks] = useState({
    faces: false,
    card: false,
    address: false,
    other: false,
  });

  useEffect(() => {
    setSavedPublication(null);
    setChecks({
      faces: sourcePublication?.privacy_faces_clear === true,
      card: sourcePublication?.privacy_card_message_clear === true,
      address: sourcePublication?.privacy_address_clear === true,
      other: sourcePublication?.privacy_other_personal_info_clear === true,
    });
  }, [
    assignment.photo_set_rev,
    sourcePublication?.photo_set_rev,
    sourcePublication?.privacy_faces_clear,
    sourcePublication?.privacy_card_message_clear,
    sourcePublication?.privacy_address_clear,
    sourcePublication?.privacy_other_personal_info_clear,
  ]);

  const hasPhoto = !!assignment.photo_items_path;
  const approved = assignment.verification_status === "approved";
  const completed =
    assignment.parent_order_status === "completed" ||
    // Older assignment responses did not include the parent status. In that
    // case the server still enforces the gate; keeping the control visible
    // lets the response explain why it is unavailable.
    assignment.parent_order_status === undefined;
  const currentRevision =
    !publication?.photo_set_rev ||
    assignment.photo_set_rev === undefined ||
    publication.photo_set_rev === assignment.photo_set_rev;
  const unavailableReason = !hasPhoto
    ? "missing_photo"
    : !approved
      ? "not_approved"
      : !completed
        ? "order_not_completed"
        : !currentRevision
          ? "stale_revision"
          : null;
  const enabled = publication?.enabled === true;
  const allChecksClear = Object.values(checks).every(Boolean);
  const canEnable = !unavailableReason && allChecksClear;
  const busy = publicationMut.isPending;

  const save = async () => {
    const nextEnabled = !enabled;
    if (nextEnabled && !canEnable) {
      toast({
        title: t("orders.realDeliveriesPrivacyRequired"),
        variant: "destructive",
      });
      return;
    }
    if (!assignment.photo_set_rev) return;
    try {
      const result = await publicationMut.mutateAsync({
        id: orderId,
        data: {
          enabled: nextEnabled,
          photo_set_rev: assignment.photo_set_rev,
          privacy_faces_clear: checks.faces,
          privacy_card_message_clear: checks.card,
          privacy_address_clear: checks.address,
          privacy_other_personal_info_clear: checks.other,
        },
      });
      setSavedPublication(result.publication);
      toast({
        title: nextEnabled
          ? t("orders.realDeliveriesFeaturedToast")
          : t("orders.realDeliveriesUnfeaturedToast"),
      });
    } catch (error) {
      toast({
        title: t("orders.realDeliveriesSaveFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  const reason =
    unavailableReason ??
    publication?.feed_eligibility.reasons.find(
      (value) => value === "insufficient_inventory" || value === "minimum_three_photos",
    );
  const reasonText =
    reason === "insufficient_inventory"
      ? t("orders.realDeliveriesInventoryWarning")
      : reason === "minimum_three_photos"
        ? t("orders.realDeliveriesMinimumPhotosWarning", {
            count: publication?.feed_eligibility.eligible_photo_count ?? 0,
          })
        : reason
          ? t(`orders.realDeliveriesUnavailable.${reason}`)
          : null;

  return (
    <section
      className="rounded-md border bg-muted/20 p-3 space-y-3"
      data-testid="real-deliveries-publication-control"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{t("orders.realDeliveriesFeatureTitle")}</p>
          <p className="text-xs text-muted-foreground">
            {enabled
              ? t("orders.realDeliveriesCurrentlyFeatured")
              : t("orders.realDeliveriesFeatureDescription")}
          </p>
        </div>
        <Badge variant={enabled ? "default" : "outline"}>
          {enabled
            ? t("orders.realDeliveriesPublicationEnabled")
            : t("orders.realDeliveriesPublicationDisabled")}
        </Badge>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        {(
          [
            ["faces", "orders.realDeliveriesPrivacy.faces"],
            ["card", "orders.realDeliveriesPrivacy.card"],
            ["address", "orders.realDeliveriesPrivacy.address"],
            ["other", "orders.realDeliveriesPrivacy.other"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-start gap-2">
            <Checkbox
              checked={checks[key]}
              disabled={busy || !!unavailableReason}
              onCheckedChange={(value) =>
                setChecks((previous) => ({ ...previous, [key]: value === true }))
              }
              data-testid={`checkbox-real-deliveries-${key}`}
            />
            <span>{t(label)}</span>
          </label>
        ))}
      </div>

      {reasonText && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>{reasonText}</span>
        </p>
      )}

      <Button
        type="button"
        size="sm"
        variant={enabled ? "outline" : "default"}
        disabled={busy || !!unavailableReason || (!enabled && !allChecksClear)}
        onClick={() => void save()}
        data-testid="button-feature-real-deliveries"
      >
        {busy && <Loader2 size={14} className="animate-spin" />}
        {enabled
          ? t("orders.realDeliveriesDisable")
          : t("orders.realDeliveriesFeatureButton")}
      </Button>
    </section>
  );
}
