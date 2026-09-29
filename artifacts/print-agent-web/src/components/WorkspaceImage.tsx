import { useEffect, useState, useRef, type ImgHTMLAttributes } from "react";
import { apiFetch } from "@/lib/queryClient";

type Props = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
};

const MAX_RETRIES = 1;

/**
 * A drop-in replacement for <img> that automatically recovers from expired
 * ws_img cookie tokens.
 *
 * When the image fails to load, it probes the URL with a HEAD request to check
 * whether the failure is a 401 (expired token). If so, it calls
 * POST /api/workspace/image-token to obtain a fresh cookie, then retries the
 * image load once via a cache-busting query parameter.
 *
 * Non-401 errors and subsequent failures after the one allowed retry are
 * forwarded to the caller's onError handler unchanged.
 */
export function WorkspaceImage({ src, onError, ...props }: Props) {
  const [cacheBust, setCacheBust] = useState<string | null>(null);
  const retries = useRef(0);

  useEffect(() => {
    retries.current = 0;
    setCacheBust(null);
  }, [src]);

  const resolvedSrc =
    cacheBust !== null
      ? `${src}${src.includes("?") ? "&" : "?"}_t=${cacheBust}`
      : src;

  async function handleError(
    e: React.SyntheticEvent<HTMLImageElement, Event>,
  ) {
    if (retries.current >= MAX_RETRIES) {
      onError?.(e);
      return;
    }

    try {
      const res = await fetch(src, {
        credentials: "include",
        method: "HEAD",
      });

      if (res.status === 401) {
        retries.current += 1;
        try {
          await apiFetch("/api/workspace/image-token", { method: "POST" });
        } catch {
          // Proceed to retry even if the token refresh call itself failed;
          // the cookie may have been set before the error or a partial
          // success may still allow the image to load.
        }
        setCacheBust(String(Date.now()));
        return;
      }
    } catch {
      // Network error probing the URL — fall through to the caller's handler.
    }

    onError?.(e);
  }

  return <img {...props} src={resolvedSrc} onError={handleError} />;
}
