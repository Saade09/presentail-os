import PhoneInput from "react-phone-number-input";
import type { FlagProps } from "react-phone-number-input";
import flags from "react-phone-number-input/flags";
import "react-phone-number-input/style.css";
import "./PhoneInputField.css";
import { cn } from "@/lib/utils";

/**
 * Flag renderer that satisfies `react-phone-number-input`'s `flagComponent`
 * API. Renders the flag SVG bundled by `react-phone-number-input/flags`
 * (sourced from `country-flag-icons`), which Vite tree-shakes and bundles
 * directly — no runtime path resolution via BASE_URL, so it works regardless
 * of deployment path. Falls back to the 2-letter ISO code label only when a
 * flag genuinely cannot be resolved, so a broken-image icon never appears.
 *
 * EmbeddedFlagProps only accepts `title` — no className or style — so the SVG
 * is styled via the `.phone-flag-wrapper svg` descendant selector in
 * PhoneInputField.css. The wrapper span fills the library's
 * `.PhoneInputCountryIcon` container (default 1.5em × 1em) via flex-stretch,
 * and overflow:hidden + border-radius clip the flag neatly.
 */
function PhoneFlagComponent({ country, countryName }: FlagProps) {
  const code = (country ?? "").toUpperCase();
  const FlagSvg = country ? flags[country] : undefined;

  if (!FlagSvg) {
    return (
      <span
        aria-label={countryName}
        className="phone-flag-wrapper inline-flex items-center justify-center bg-muted text-[8px] font-semibold leading-none text-muted-foreground"
      >
        {code}
      </span>
    );
  }

  return (
    <span className="phone-flag-wrapper">
      <FlagSvg title={countryName ?? country} />
    </span>
  );
}

/**
 * Thin wrapper around `<PhoneInput>` that pre-wires the local flag renderer,
 * the shared CSS, and a consistent input-container className. Forwards all
 * other props so call sites only need to drop in this component.
 */
export function PhoneInputField({
  className,
  ...props
}: React.ComponentProps<typeof PhoneInput>) {
  return (
    <PhoneInput
      {...props}
      flagComponent={PhoneFlagComponent}
      className={cn(
        "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
        className,
      )}
    />
  );
}
