import { apiFetch } from "@/lib/queryClient";

const SW_PATH = `${import.meta.env.BASE_URL}sw.js`;

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    output[i] = rawData.charCodeAt(i);
  }
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_PATH);
}

/** Returns the current push subscription, if any. */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Requests notification permission, subscribes the browser to Web Push using
 * the server's VAPID public key, and stores the subscription server-side.
 * Throws Error with a message key suffix on known failure modes.
 */
export async function enableWebPush(): Promise<void> {
  if (!isWebPushSupported()) throw new Error("unsupported");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission_denied");

  const { publicKey } = await apiFetch<{ publicKey: string }>("/api/web-push/public-key");
  const reg = await getRegistration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }
  const json = sub.toJSON();
  await apiFetch("/api/web-push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys }),
  });
}

/** Unsubscribes the browser and removes the subscription server-side. */
export async function disableWebPush(): Promise<void> {
  const sub = await getCurrentPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch {
    /* best-effort */
  }
  await apiFetch("/api/web-push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint }),
  });
}
