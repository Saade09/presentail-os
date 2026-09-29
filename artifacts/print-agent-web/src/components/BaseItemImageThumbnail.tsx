interface BaseItemImageThumbnailProps {
  imageUrl: string | null;
  name: string;
  size?: 6 | 7 | 8 | 10 | 12;
}

const SIZE_CLASSES: Record<number, string> = {
  6: "w-6 h-6",
  7: "w-7 h-7",
  8: "w-8 h-8",
  10: "w-10 h-10",
  12: "w-12 h-12",
};

const FONT_CLASSES: Record<number, string> = {
  6: "text-xs",
  7: "text-xs",
  8: "text-xs",
  10: "text-sm",
  12: "text-sm",
};

export function BaseItemImageThumbnail({ imageUrl, name, size = 10 }: BaseItemImageThumbnailProps) {
  const dimensionClass = SIZE_CLASSES[size] ?? SIZE_CLASSES[10];
  const fontClass = FONT_CLASSES[size] ?? FONT_CLASSES[10];
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <div
      className={`${dimensionClass} rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0`}
    >
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        <span className={`${fontClass} font-semibold text-muted-foreground select-none`}>{initial}</span>
      )}
    </div>
  );
}
