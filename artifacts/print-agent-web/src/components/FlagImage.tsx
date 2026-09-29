import { useState } from "react";
import { cn } from "@/lib/utils";
import { findCountryByCode, findCountryByName, getDefaultFlagUrl } from "@/lib/countries";

type Props = {
  /** Either a country name (e.g. "Lebanon") or ISO alpha-2 code (e.g. "lb"). */
  country: string;
  /** Override the resolved URL (e.g. per-workspace `flag_image_url` from the API). */
  url?: string | null;
  className?: string;
  size?: number;
};

/**
 * Renders a country flag thumbnail. Falls back to a neutral placeholder when
 * the country is unknown or the override URL fails to load.
 */
export function FlagImage({ country, url, className, size = 16 }: Props) {
  const [failed, setFailed] = useState(false);
  const entry =
    findCountryByName(country) ?? findCountryByCode(country) ?? null;
  const resolved = url ?? (entry ? getDefaultFlagUrl(entry.code) : null);
  const alt = entry?.name ?? country;
  const codeLabel = (entry?.code ?? country).slice(0, 2).toUpperCase();

  if (!resolved || failed) {
    return (
      <span
        aria-label={alt}
        className={cn(
          "inline-flex items-center justify-center rounded-sm bg-muted font-semibold leading-none text-muted-foreground",
          className,
        )}
        style={{ width: size * (4 / 3), height: size, fontSize: size * 0.5 }}
      >
        {codeLabel}
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt}
      width={size * (4 / 3)}
      height={size}
      loading="lazy"
      className={cn("inline-block rounded-sm object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
