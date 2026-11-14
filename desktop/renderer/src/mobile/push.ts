/**
 * The phone app's service worker and Web Push subscription (PLAN-62).
 *
 * Browsers only give service workers and push to secure contexts (HTTPS, or
 * localhost), and iOS only to an app added to the Home Screen (iOS 16.4+).
 * Everything here degrades to "not available" with a reason the Settings
 * screen can show.
 */

import { base64UrlToBytes } from "../lib/device-identity";
import { useMobile, type PushCategories } from "./store";

export type PushSupport =
  | { ok: true }
  | { ok: false; reason: "insecure" | "ios-not-installed" | "unsupported" | "denied" };

export function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function pushSupport(): PushSupport {
  if (typeof isSecureContext !== "undefined" && !isSecureContext) {
    return { ok: false, reason: "insecure" };
  }
  if (isIos() && !isStandalone()) {
    return { ok: false, reason: "ios-not-installed" };
  }
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return { ok: false, reason: "unsupported" };
  }
  if (Notification.permission === "denied") {
    return { ok: false, reason: "denied" };
  }
  return { ok: true };
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register the service worker (offline shell + push). Safe to call repeatedly. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (
    !("serviceWorker" in navigator) ||
    (typeof isSecureContext !== "undefined" && !isSecureContext)
  ) {
    registration = Promise.resolve(null);
    return registration;
  }
  registration = navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .catch((err: unknown) => {
      console.warn("[mobile] service worker registration failed", err);
      return null;
    });
  // A tap on a notification posts the deep link to an open window.
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === "navigate" && typeof data.url === "string" && data.url.startsWith("#/")) {
      window.location.hash = data.url.slice(1);
    }
  });
  return registration;
}

/** Ask for permission (needs a tap), subscribe, and register with the gateway. */
export async function enablePush(categories: PushCategories): Promise<void> {
  const support = pushSupport();
  if (!support.ok) {
    throw new Error(describePushSupport(support.reason));
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notifications were not allowed. You can allow them in the phone's settings.");
  }
  const reg = await registerServiceWorker();
  if (!reg) {
    throw new Error("The app could not start its background worker.");
  }
  const store = useMobile.getState();
  const config = await store.request<{ enabled: boolean; publicKey: string | null }>("push.config");
  if (!config.enabled || !config.publicKey) {
    throw new Error("Notifications are turned off on the gateway.");
  }
  const key = base64UrlToBytes(config.publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another gateway key cannot be reused.
  if (sub) {
    const existingKey = sub.options.applicationServerKey;
    const same =
      existingKey &&
      new Uint8Array(existingKey).length === key.length &&
      new Uint8Array(existingKey).every((b, i) => b === key[i]);
    if (!same) {
      await sub.unsubscribe();
      sub = null;
    }
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key as BufferSource,
  });
  const json = sub.toJSON();
  const res = await store.request<{ subscribed: boolean; categories: PushCategories }>(
    "push.subscribe",
    { subscription: { endpoint: json.endpoint, keys: json.keys }, categories },
  );
  useMobile.setState({ push: { subscribed: res.subscribed, categories: res.categories } });
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await registerServiceWorker();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } finally {
    await useMobile.getState().request("push.unsubscribe", {});
    useMobile.setState((s) => ({ push: { ...s.push, subscribed: false } }));
  }
}

export async function updatePushCategories(categories: Partial<PushCategories>): Promise<void> {
  const res = await useMobile
    .getState()
    .request<{ categories: PushCategories }>("push.settings", { categories });
  useMobile.setState((s) => ({ push: { ...s.push, categories: res.categories } }));
}

export function describePushSupport(reason: Exclude<PushSupport, { ok: true }>["reason"]): string {
  switch (reason) {
    case "insecure":
      return "Notifications need a secure (HTTPS) address, such as Tailscale Serve. Chat works without it.";
    case "ios-not-installed":
      return "On iPhone, notifications need the Home Screen app.";
    case "denied":
      return "Notifications are blocked for this site. Allow them in the phone's settings.";
    default:
      return "This browser does not support web notifications.";
  }
}
