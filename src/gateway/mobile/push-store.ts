/**
 * PLAN-62: Web Push state. The VAPID key pair and one push subscription per
 * paired device, both under `<stateDir>/push/` with 0600 files.
 *
 * Standard Web Push needs no relay of ours: the gateway signs a VAPID JWT with
 * its own key and posts an RFC 8291 encrypted payload straight to the browser
 * vendor's push service (Apple, Google, Mozilla, Microsoft), which delivers it
 * to the installed app. The push service sees ciphertext and timing only.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";

export type PushCategories = {
  /** An action is waiting in the approvals queue. */
  approvals: boolean;
  /** The agent replied to something sent from this phone while the app was closed. */
  replies: boolean;
  /** Owner notices: failed scheduled jobs, stranded tasks and the like. */
  notices: boolean;
  /** Include a short preview of the text. Off: a generic line only. */
  previews: boolean;
};

export const DEFAULT_PUSH_CATEGORIES: PushCategories = {
  approvals: true,
  replies: true,
  notices: true,
  previews: false,
};

export type StoredPushSubscription = {
  id: string;
  deviceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  categories: PushCategories;
  lastSuccessAtMs?: number;
  failures?: number;
};

type PushStateFile = Record<string, StoredPushSubscription>;

export type VapidKeys = { publicKey: string; privateKey: string; createdAtMs: number };

const lock = createAsyncLock();

function pushDir(baseDir?: string): string {
  return path.join(baseDir ?? resolveStateDir(), "push");
}

async function chmodPrivate(file: string) {
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // best-effort (Windows)
  }
}

/** Load the gateway's VAPID keys, generating and storing them on first use. */
export async function loadOrCreateVapidKeys(params: {
  baseDir?: string;
  generate: () => { publicKey: string; privateKey: string };
}): Promise<VapidKeys> {
  return await lock(async () => {
    const file = path.join(pushDir(params.baseDir), "vapid.json");
    const existing = await readJsonFile<VapidKeys>(file);
    if (
      existing &&
      typeof existing.publicKey === "string" &&
      typeof existing.privateKey === "string" &&
      existing.publicKey &&
      existing.privateKey
    ) {
      return existing;
    }
    const generated = params.generate();
    const keys: VapidKeys = { ...generated, createdAtMs: Date.now() };
    await fs.mkdir(pushDir(params.baseDir), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(file, keys);
    await chmodPrivate(file);
    return keys;
  });
}

async function loadState(baseDir?: string): Promise<PushStateFile> {
  return (
    (await readJsonFile<PushStateFile>(path.join(pushDir(baseDir), "subscriptions.json"))) ?? {}
  );
}

async function saveState(state: PushStateFile, baseDir?: string) {
  await fs.mkdir(pushDir(baseDir), { recursive: true, mode: 0o700 });
  const file = path.join(pushDir(baseDir), "subscriptions.json");
  await writeJsonAtomic(file, state);
  await chmodPrivate(file);
}

/**
 * Push service hosts the gateway will POST to. A subscription endpoint comes
 * from the phone, so without this list a paired device could point the
 * gateway at any URL (an internal service, say). These are the services the
 * browsers that support Web Push actually use.
 */
export const DEFAULT_PUSH_ENDPOINT_HOSTS = [
  "push.apple.com",
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "notify.windows.com",
];

export function isAllowedPushEndpoint(
  endpoint: string,
  extraHosts: readonly string[] = [],
): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return false;
  }
  if (url.port && url.port !== "443") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return [...DEFAULT_PUSH_ENDPOINT_HOSTS, ...extraHosts].some((allowed) => {
    const a = allowed.trim().toLowerCase();
    return a.length > 0 && (host === a || host.endsWith(`.${a}`));
  });
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export type PushSubscriptionInput = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
};

export function validateSubscriptionInput(
  input: PushSubscriptionInput,
  extraHosts: readonly string[] = [],
):
  | { ok: true; endpoint: string; keys: { p256dh: string; auth: string } }
  | { ok: false; error: string } {
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint.trim() : "";
  const p256dh = typeof input?.keys?.p256dh === "string" ? input.keys.p256dh.trim() : "";
  const auth = typeof input?.keys?.auth === "string" ? input.keys.auth.trim() : "";
  if (!endpoint || endpoint.length > 2048) {
    return { ok: false, error: "subscription endpoint required" };
  }
  if (!isAllowedPushEndpoint(endpoint, extraHosts)) {
    return { ok: false, error: "push endpoint is not a known push service" };
  }
  if (!p256dh || !auth || !B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length > 200) {
    return { ok: false, error: "subscription keys invalid" };
  }
  return { ok: true, endpoint, keys: { p256dh, auth } };
}

/** Store (or replace) this device's subscription. One per device. */
export async function upsertPushSubscription(
  params: {
    deviceId: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
    categories?: Partial<PushCategories>;
  },
  baseDir?: string,
): Promise<StoredPushSubscription> {
  return await lock(async () => {
    const state = await loadState(baseDir);
    const previous = state[params.deviceId];
    const entry: StoredPushSubscription = {
      id: previous?.endpoint === params.endpoint ? previous.id : randomUUID(),
      deviceId: params.deviceId,
      endpoint: params.endpoint,
      keys: params.keys,
      createdAtMs: previous?.endpoint === params.endpoint ? previous.createdAtMs : Date.now(),
      categories: {
        ...DEFAULT_PUSH_CATEGORIES,
        ...previous?.categories,
        ...params.categories,
      },
    };
    state[params.deviceId] = entry;
    await saveState(state, baseDir);
    return entry;
  });
}

export async function updatePushCategories(
  deviceId: string,
  categories: Partial<PushCategories>,
  baseDir?: string,
): Promise<StoredPushSubscription | null> {
  return await lock(async () => {
    const state = await loadState(baseDir);
    const existing = state[deviceId];
    if (!existing) {
      return null;
    }
    const clean: Partial<PushCategories> = {};
    for (const key of Object.keys(DEFAULT_PUSH_CATEGORIES) as Array<keyof PushCategories>) {
      if (typeof categories[key] === "boolean") {
        clean[key] = categories[key];
      }
    }
    existing.categories = { ...existing.categories, ...clean };
    state[deviceId] = existing;
    await saveState(state, baseDir);
    return existing;
  });
}

/** Delete a device's subscription. Revoking or removing a device calls this. */
export async function removePushSubscription(deviceId: string, baseDir?: string): Promise<boolean> {
  return await lock(async () => {
    const state = await loadState(baseDir);
    if (!state[deviceId]) {
      return false;
    }
    delete state[deviceId];
    await saveState(state, baseDir);
    return true;
  });
}

export async function getPushSubscription(
  deviceId: string,
  baseDir?: string,
): Promise<StoredPushSubscription | null> {
  const state = await loadState(baseDir);
  return state[deviceId] ?? null;
}

export async function listPushSubscriptions(baseDir?: string): Promise<StoredPushSubscription[]> {
  return Object.values(await loadState(baseDir));
}

/** Record a delivery outcome. A gone endpoint (404/410) is dropped. */
export async function recordPushOutcome(
  deviceId: string,
  outcome: { ok: true } | { ok: false; gone: boolean },
  baseDir?: string,
): Promise<void> {
  await lock(async () => {
    const state = await loadState(baseDir);
    const existing = state[deviceId];
    if (!existing) {
      return;
    }
    if (outcome.ok) {
      existing.lastSuccessAtMs = Date.now();
      existing.failures = 0;
    } else if (outcome.gone) {
      delete state[deviceId];
    } else {
      existing.failures = (existing.failures ?? 0) + 1;
    }
    await saveState(state, baseDir);
  });
}
