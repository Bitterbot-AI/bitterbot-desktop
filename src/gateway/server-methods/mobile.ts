/**
 * PLAN-62: phone pairing, per-device management and Web Push RPCs.
 *
 * Owner surfaces (operator.pairing or admin): mobile.pair.create,
 * device.remove, device.rename. A phone (operator.chat / operator.notifications,
 * see ../mobile/scopes.ts) manages only itself: mobile.self.*, mobile.presence
 * and push.*. Every self method resolves the device from the authenticated
 * connection, never from params, so a phone cannot touch another device.
 */

import { loadConfig } from "../../config/config.js";
import {
  getPairedDevice,
  removePairedDevice,
  renamePairedDevice,
  type PairedDevice,
} from "../../infra/device-pairing.js";
import { deviceIdOf, disconnectDevice } from "../mobile/live-clients.js";
import { createSetupCode, SETUP_CODE_TTL_MS } from "../mobile/pairing.js";
import { getActivePushDispatcher, loadVapidKeys, pushEnabled } from "../mobile/push-dispatcher.js";
import {
  DEFAULT_PUSH_CATEGORIES,
  getPushSubscription,
  removePushSubscription,
  updatePushCategories,
  upsertPushSubscription,
  validateSubscriptionInput,
  type PushCategories,
} from "../mobile/push-store.js";
import { buildMobilePairUrl, resolveMobileBaseUrls } from "../mobile/urls.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

function invalid(respond: RespondFn, message: string) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function readString(value: unknown, max = 256): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Device record without token secrets, for any client-facing response. */
export function publicDeviceView(device: PairedDevice) {
  const token = device.tokens?.operator;
  return {
    deviceId: device.deviceId,
    name: device.label || device.displayName || "Device",
    label: device.label,
    displayName: device.displayName,
    platform: device.platform,
    clientId: device.clientId,
    scopes: device.scopes ?? [],
    createdAtMs: device.createdAtMs,
    approvedAtMs: device.approvedAtMs,
    lastUsedAtMs: token?.lastUsedAtMs,
    revoked: Boolean(token?.revokedAtMs),
  };
}

function readCategories(raw: unknown): Partial<PushCategories> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Partial<PushCategories> = {};
  for (const key of Object.keys(DEFAULT_PUSH_CATEGORIES) as Array<keyof PushCategories>) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Remove a device everywhere: pairing record and tokens, push subscription,
 * reply-interest tracking, and every open socket. Revoking a phone never
 * touches the gateway token.
 */
export async function removeDeviceEverywhere(deviceId: string): Promise<PairedDevice | null> {
  const removed = await removePairedDevice(deviceId);
  await removePushSubscription(deviceId);
  getActivePushDispatcher()?.forgetDevice(deviceId);
  disconnectDevice(deviceId, "device removed");
  return removed;
}

export const mobileHandlers: GatewayRequestHandlers = {
  "mobile.pair.create": async ({ respond, client, context }) => {
    const cfg = loadConfig();
    if (cfg.gateway?.mobile?.enabled === false) {
      invalid(respond, "phone pairing is turned off (gateway.mobile.enabled=false)");
      return;
    }
    const created = createSetupCode({
      createdBy: client?.connect?.client?.displayName ?? client?.connect?.client?.id,
    });
    const bases = await resolveMobileBaseUrls(cfg);
    context.logGateway.info(`mobile setup code created setup=${created.setupId}`);
    respond(true, {
      code: created.code,
      setupId: created.setupId,
      expiresAtMs: created.expiresAtMs,
      ttlMs: SETUP_CODE_TTL_MS,
      urls: bases.map((base) => ({ ...base, pairUrl: buildMobilePairUrl(base.url, created.code) })),
    });
  },

  "device.remove": async ({ params, respond, context }) => {
    const deviceId = readString(params.deviceId, 128);
    if (!deviceId) {
      invalid(respond, "deviceId required");
      return;
    }
    const removed = await removeDeviceEverywhere(deviceId);
    if (!removed) {
      invalid(respond, "unknown deviceId");
      return;
    }
    context.logGateway.info(`device removed device=${deviceId}`);
    respond(true, { deviceId, removed: true });
  },

  "device.rename": async ({ params, respond }) => {
    const deviceId = readString(params.deviceId, 128);
    const name = readString(params.name, 64);
    if (!deviceId) {
      invalid(respond, "deviceId required");
      return;
    }
    const renamed = await renamePairedDevice(deviceId, name);
    if (!renamed) {
      invalid(respond, "unknown deviceId");
      return;
    }
    respond(true, publicDeviceView(renamed));
  },

  "mobile.self.get": async ({ respond, client }) => {
    const deviceId = deviceIdOf(client as never);
    if (!deviceId) {
      invalid(respond, "this connection has no paired device");
      return;
    }
    const device = await getPairedDevice(deviceId);
    if (!device) {
      invalid(respond, "device is not paired");
      return;
    }
    const sub = await getPushSubscription(deviceId);
    respond(true, {
      device: publicDeviceView(device),
      push: {
        subscribed: Boolean(sub),
        categories: sub?.categories ?? DEFAULT_PUSH_CATEGORIES,
      },
    });
  },

  "mobile.self.rename": async ({ params, respond, client }) => {
    const deviceId = deviceIdOf(client as never);
    if (!deviceId) {
      invalid(respond, "this connection has no paired device");
      return;
    }
    const renamed = await renamePairedDevice(deviceId, readString(params.name, 64));
    if (!renamed) {
      invalid(respond, "device is not paired");
      return;
    }
    respond(true, publicDeviceView(renamed));
  },

  "mobile.self.unpair": async ({ respond, client, context }) => {
    const deviceId = deviceIdOf(client as never);
    if (!deviceId) {
      invalid(respond, "this connection has no paired device");
      return;
    }
    // Answer first: removing the device closes this very socket.
    respond(true, { deviceId, removed: true });
    context.logGateway.info(`device unpaired itself device=${deviceId}`);
    setTimeout(() => {
      void removeDeviceEverywhere(deviceId);
    }, 50);
  },

  "mobile.presence": ({ params, respond, client }) => {
    if (client) {
      client.mobileVisible = params.visible === true;
    }
    respond(true, { ok: true });
  },

  "push.config": async ({ respond, client }) => {
    const cfg = loadConfig();
    const deviceId = deviceIdOf(client as never);
    const enabled = pushEnabled(cfg);
    const sub = deviceId ? await getPushSubscription(deviceId) : null;
    respond(true, {
      enabled,
      publicKey: enabled ? (await loadVapidKeys()).publicKey : null,
      subscribed: Boolean(sub),
      categories: sub?.categories ?? DEFAULT_PUSH_CATEGORIES,
    });
  },

  "push.subscribe": async ({ params, respond, client }) => {
    const cfg = loadConfig();
    if (!pushEnabled(cfg)) {
      invalid(respond, "push notifications are turned off on this gateway");
      return;
    }
    const deviceId = deviceIdOf(client as never);
    if (!deviceId || !(await getPairedDevice(deviceId))) {
      invalid(respond, "only a paired device can subscribe");
      return;
    }
    const checked = validateSubscriptionInput(
      (params.subscription ?? {}) as never,
      cfg.gateway?.mobile?.push?.allowedEndpointHosts ?? [],
    );
    if (!checked.ok) {
      invalid(respond, checked.error);
      return;
    }
    const stored = await upsertPushSubscription({
      deviceId,
      endpoint: checked.endpoint,
      keys: checked.keys,
      categories: readCategories(params.categories),
    });
    respond(true, { subscribed: true, categories: stored.categories });
  },

  "push.unsubscribe": async ({ respond, client }) => {
    const deviceId = deviceIdOf(client as never);
    if (!deviceId) {
      invalid(respond, "this connection has no paired device");
      return;
    }
    await removePushSubscription(deviceId);
    respond(true, { subscribed: false });
  },

  "push.settings": async ({ params, respond, client }) => {
    const deviceId = deviceIdOf(client as never);
    if (!deviceId) {
      invalid(respond, "this connection has no paired device");
      return;
    }
    const updated = await updatePushCategories(deviceId, readCategories(params.categories));
    if (!updated) {
      invalid(respond, "notifications are not turned on for this device");
      return;
    }
    respond(true, { subscribed: true, categories: updated.categories });
  },

  "push.test": async ({ respond, client }) => {
    const deviceId = deviceIdOf(client as never);
    const sub = deviceId ? await getPushSubscription(deviceId) : null;
    const dispatcher = getActivePushDispatcher();
    if (!sub || !dispatcher) {
      invalid(respond, "notifications are not turned on for this device");
      return;
    }
    const sent = await dispatcher.sendTest(sub);
    if (!sent) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "the push service did not accept the test"),
      );
      return;
    }
    respond(true, { sent: true });
  },
};
