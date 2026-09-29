import { useState, useCallback } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ZoomIn, ZoomOut, RotateCcw, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type OutputFormat = "jpeg" | "png" | "webp";

const MIME_TYPE: Record<OutputFormat, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const FILE_EXT: Record<OutputFormat, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

interface ImageCropDownloadModalProps {
  open: boolean;
  onClose: () => void;
  imageUrl: string;
  channelName: string;
  targetWidth: number;
  targetHeight: number;
  productName: string;
  outputFormat?: OutputFormat;
}

async function getCroppedBlob(
  imageSrc: string,
  croppedAreaPixels: Area,
  targetWidth: number,
  targetHeight: number,
  mimeType: string,
): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imageSrc;
  });

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get canvas context");

  ctx.drawImage(
    image,
    croppedAreaPixels.x,
    croppedAreaPixels.y,
    croppedAreaPixels.width,
    croppedAreaPixels.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas toBlob failed"));
    }, mimeType);
  });
}

export function ImageCropDownloadModal({
  open,
  onClose,
  imageUrl,
  channelName,
  targetWidth,
  targetHeight,
  productName,
  outputFormat = "jpeg",
}: ImageCropDownloadModalProps) {
  const { toast } = useToast();
  const aspect = targetWidth / targetHeight;
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [downloading, setDownloading] = useState(false);

  const onCropComplete = useCallback((_croppedArea: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const onMediaLoaded = useCallback(
    ({ naturalWidth, naturalHeight }: { naturalWidth: number; naturalHeight: number }) => {
      // In react-easy-crop, zoom=1 means the image *covers* the crop area.
      // To compute the zoom needed to *contain* (fully show) the image inside
      // the crop frame, we compare aspect ratios:
      //   - wider image than frame  → containZoom = targetAspect / imageAspect
      //   - taller image than frame → containZoom = imageAspect / targetAspect
      // This value is always ≤ 1 (< 1 when aspect ratios differ).
      // We intentionally do NOT clamp to 1; that would revert to cover behavior.
      const imageAspect = naturalWidth / naturalHeight;
      const targetAspect = targetWidth / targetHeight;
      const containZoom = imageAspect > targetAspect
        ? targetAspect / imageAspect
        : imageAspect / targetAspect;
      setMinZoom(containZoom);
      setZoom(containZoom);
    },
    [targetWidth, targetHeight],
  );

  function handleReset() {
    setCrop({ x: 0, y: 0 });
    setZoom(minZoom);
  }

  async function handleDownload() {
    if (!croppedAreaPixels) return;
    setDownloading(true);
    try {
      const mimeType = MIME_TYPE[outputFormat] ?? "image/jpeg";
      const ext = FILE_EXT[outputFormat] ?? "jpg";
      const blob = await getCroppedBlob(imageUrl, croppedAreaPixels, targetWidth, targetHeight, mimeType);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = productName.replace(/[^a-z0-9_\- ]/gi, "_").toLowerCase();
      const safeChannel = channelName.replace(/[^a-z0-9_\- ]/gi, "_").toLowerCase();
      a.download = `${safeName}_${safeChannel}_${targetWidth}x${targetHeight}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({
        title: "Download failed",
        description: "Could not export the cropped image. Please try again.",
        variant: "destructive",
      });
    } finally {
      setDownloading(false);
    }
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      handleReset();
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl p-0 gap-0 overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Crop for {channelName}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
            {targetWidth} × {targetHeight} px · {outputFormat.toUpperCase()} — drag and zoom to frame the image, then download.
          </DialogDescription>
        </div>

        {/* Crop area */}
        <div
          className="relative bg-muted"
          style={{ height: 360 }}
        >
          <Cropper
            image={imageUrl}
            crop={crop}
            zoom={zoom}
            minZoom={minZoom}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            onMediaLoaded={onMediaLoaded}
            showGrid={true}
            style={{
              containerStyle: { borderRadius: 0 },
              cropAreaStyle: {
                border: "2px solid hsl(var(--primary))",
                borderRadius: "4px",
              },
            }}
          />
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-border bg-background">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(minZoom, z - 0.1))}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <input
            type="range"
            min={minZoom}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 h-1.5 accent-primary cursor-pointer"
            aria-label="Zoom"
          />
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Reset crop"
            title="Reset"
          >
            <RotateCcw size={15} />
          </button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border bg-background">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={downloading}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={handleDownload}
            disabled={downloading || !croppedAreaPixels}
          >
            <Download size={13} />
            {downloading ? "Downloading…" : "Download"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
