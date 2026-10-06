import { z } from "zod";

const ServerSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    /** TLS from the first byte (993/465). Default: true for 993/465. */
    secure: z.boolean().optional(),
    /** Defaults to the channel address. */
    user: z.string().optional(),
    password: z.string().optional(),
  })
  .strict();

export const EmailConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    /** The agent's own address: replies come from it. */
    address: z.string().min(3),
    /** Shared password for IMAP and SMTP when they use the same login. */
    password: z.string().optional(),
    imap: ServerSchema,
    smtp: ServerSchema,
    /**
     * Who may write to the agent: addresses, "@domain.com", or "*". Nobody is
     * allowed until this is set.
     */
    allowFrom: z.array(z.string()).optional(),
    /** Accept mail only when the receiving server verified the sender (DMARC or DKIM). Default: true. */
    requireAuthenticated: z.boolean().optional(),
    mailbox: z.string().optional(),
    /** Longest message body passed to the agent, in characters. Default: 20000. */
    maxBodyChars: z.number().int().positive().optional(),
    responsePrefix: z.string().optional(),
  })
  .strict();

export type EmailConfig = z.infer<typeof EmailConfigSchema>;

export type ResolvedServer = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

export type ResolvedEmail = {
  enabled: boolean;
  address: string;
  imap: ResolvedServer;
  smtp: ResolvedServer;
  allowFrom: string[];
  requireAuthenticated: boolean;
  mailbox: string;
  maxBodyChars: number;
  responsePrefix?: string;
};

function server(
  s: EmailConfig["imap"],
  fallback: { user: string; password?: string },
  defaults: { port: number; securePorts: number[] },
): ResolvedServer {
  const port = s.port ?? defaults.port;
  return {
    host: s.host,
    port,
    secure: s.secure ?? defaults.securePorts.includes(port),
    user: s.user ?? fallback.user,
    password: s.password ?? fallback.password ?? "",
  };
}

export function readEmailConfig(cfg: unknown): EmailConfig | null {
  const raw = (cfg as { channels?: { email?: unknown } } | undefined)?.channels?.email;
  const parsed = EmailConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function resolveEmailConfig(cfg: unknown): ResolvedEmail | null {
  const c = readEmailConfig(cfg);
  if (!c) return null;
  const fallback = { user: c.address, password: c.password };
  return {
    enabled: c.enabled !== false,
    address: c.address.trim().toLowerCase(),
    imap: server(c.imap, fallback, { port: 993, securePorts: [993] }),
    smtp: server(c.smtp, fallback, { port: 465, securePorts: [465] }),
    allowFrom: c.allowFrom ?? [],
    requireAuthenticated: c.requireAuthenticated !== false,
    mailbox: c.mailbox ?? "INBOX",
    maxBodyChars: c.maxBodyChars ?? 20_000,
    responsePrefix: c.responsePrefix,
  };
}

export function emailConfigured(e: ResolvedEmail | null): e is ResolvedEmail {
  return Boolean(e?.address && e.imap.host && e.imap.password && e.smtp.host && e.smtp.password);
}
