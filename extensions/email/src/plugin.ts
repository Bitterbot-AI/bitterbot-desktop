/**
 * Email as a chat channel (PLAN-53 F4): the agent reads its own mailbox over
 * IMAP and replies over SMTP, on the same thread. Works with any provider that
 * offers IMAP and SMTP with an app password (Gmail, Fastmail, iCloud, Proton
 * Bridge, a company server), with no cloud console or tunnel to set up.
 */

import type { BitterbotConfig, ReplyPayload } from "bitterbot/plugin-sdk";
import { buildChannelConfigSchema, createReplyPrefixOptions } from "bitterbot/plugin-sdk";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.plugin.js";
import {
  emailConfigured,
  EmailConfigSchema,
  type ResolvedEmail,
  resolveEmailConfig,
} from "./config.js";
import { normalizeAddress, replyHeaders, replySubject } from "./mail-logic.js";
import { type Dispatch, lastThreadBySender, runEmailMonitor } from "./monitor.js";
import { getEmailRuntime } from "./runtime.js";
import { createSender, openMailbox } from "./transport.js";

const ACCOUNT_ID = "default";

type EmailAccount = ResolvedEmail | null;

function dispatchToAgent(cfg: BitterbotConfig, accountId: string): Dispatch {
  return async ({ mail, body, reply }) => {
    const core = getEmailRuntime();
    const from = normalizeAddress(mail.from);
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "email",
      accountId,
      peer: { kind: "direct", id: from },
    });
    const text = mail.subject ? `Subject: ${mail.subject}\n\n${body}` : body;
    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: core.channel.reply.formatAgentEnvelope({
        channel: "Email",
        from: mail.fromName ? `${mail.fromName} <${from}>` : from,
        timestamp: mail.date?.getTime(),
        envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
        body: text,
      }),
      BodyForAgent: text,
      RawBody: body,
      CommandBody: body,
      From: `email:${from}`,
      To: `email:${from}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct",
      ConversationLabel: from,
      SenderName: mail.fromName ?? from,
      SenderId: from,
      Provider: "email",
      Surface: "email",
      MessageSid: mail.messageId ?? String(mail.uid),
      OriginatingChannel: "email",
      OriginatingTo: `email:${from}`,
    });
    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: () => {},
    });
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "email",
      accountId,
    });
    // One email per reply, not one per streamed block.
    const parts: string[] = [];
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...prefixOptions,
        deliver: async (payload: ReplyPayload) => {
          if (payload.text) parts.push(payload.text);
        },
      },
      replyOptions: { onModelSelected },
    });
    await reply(parts.join("\n\n"));
  };
}

export const emailPlugin: ChannelPlugin<EmailAccount> = {
  id: "email",
  meta: {
    id: "email",
    label: "Email",
    selectionLabel: "Email (IMAP + SMTP)",
    docsPath: "/channels/email",
    blurb: "Write to your agent by email; it replies on the same thread.",
    aliases: ["mail", "imap"],
  },
  capabilities: { chatTypes: ["direct"] },
  configSchema: buildChannelConfigSchema(EmailConfigSchema),
  config: {
    listAccountIds: (cfg) => (resolveEmailConfig(cfg) ? [ACCOUNT_ID] : []),
    resolveAccount: (cfg) => resolveEmailConfig(cfg),
    defaultAccountId: () => ACCOUNT_ID,
    isEnabled: (account) => account?.enabled !== false,
    isConfigured: (account) => emailConfigured(account),
    unconfiguredReason: () =>
      "set channels.email.address, imap, smtp and a password (an app password for Gmail or iCloud)",
    describeAccount: (account) => ({
      accountId: ACCOUNT_ID,
      enabled: account?.enabled !== false,
      configured: emailConfigured(account),
    }),
    resolveAllowFrom: ({ cfg }) => resolveEmailConfig(cfg)?.allowFrom,
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 100_000,
    resolveTarget: ({ to }) => {
      const addr = normalizeAddress((to ?? "").replace(/^email:/i, ""));
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)
        ? { ok: true, to: addr }
        : {
            ok: false,
            error: new Error("Email needs a recipient address, e.g. email:you@example.com"),
          };
    },
    sendText: async ({ cfg, to, text }) => {
      const e = resolveEmailConfig(cfg);
      if (!emailConfigured(e)) {
        throw new Error("Email is not configured (channels.email).");
      }
      const addr = normalizeAddress(to.replace(/^email:/i, ""));
      const thread = lastThreadBySender.get(addr);
      const sender = await createSender(e);
      const sent = await sender.send({
        to: addr,
        subject: thread ? replySubject(thread.subject) : "A message from your agent",
        text,
        ...(thread ? replyHeaders(thread) : {}),
      });
      return { channel: "email", messageId: sent.messageId ?? "" };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const e = ctx.account;
      if (!emailConfigured(e)) {
        ctx.log?.warn?.("email: not configured; not starting");
        return;
      }
      if (e.allowFrom.length === 0) {
        ctx.log?.warn?.(
          "email: channels.email.allowFrom is empty, so no one can write to the agent yet",
        );
      }
      ctx.setStatus({
        accountId: ctx.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      await runEmailMonitor(e, ctx.abortSignal, {
        openMailbox,
        createSender,
        dispatch: dispatchToAgent(ctx.cfg, ctx.accountId),
        log: {
          info: (m) => ctx.log?.info?.(m),
          warn: (m) => ctx.log?.warn?.(m),
        },
      });
      ctx.setStatus({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};
