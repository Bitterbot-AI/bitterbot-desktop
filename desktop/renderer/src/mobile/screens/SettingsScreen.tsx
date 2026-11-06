import { Bell, Check, Laptop, Loader2, Moon, Smartphone, Sun, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { readPersisted, type ThemePref } from "../persist";
import {
  describePushSupport,
  disablePush,
  enablePush,
  pushSupport,
  updatePushCategories,
} from "../push";
import { useMobile, type PushCategories } from "../store";
import { setThemePref } from "../theme";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{label}</p>
        {hint ? <p className="text-xs leading-snug text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="m-fade-in">
      <h3 className="m-section-label mb-2 px-1">{title}</h3>
      <div className="m-card divide-y divide-[var(--m-hairline)] overflow-hidden">{children}</div>
    </section>
  );
}

const CATEGORY_ROWS: Array<{ key: keyof PushCategories; label: string; hint: string }> = [
  { key: "approvals", label: "Approvals", hint: "When the agent is waiting for your OK" },
  { key: "replies", label: "Replies", hint: "When a reply lands while the app is closed" },
  { key: "notices", label: "Notices", hint: "Failed scheduled jobs and other owner notices" },
  {
    key: "previews",
    label: "Show previews",
    hint: "Off: notifications say only that something happened",
  },
];

export function SettingsScreen() {
  const self = useMobile((s) => s.self);
  const push = useMobile((s) => s.push);
  const rename = useMobile((s) => s.rename);
  const unpair = useMobile((s) => s.unpair);
  const request = useMobile((s) => s.request);
  const conn = useMobile((s) => s.conn);
  const [name, setName] = useState(self?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(readPersisted().theme ?? "system");
  const support = pushSupport();

  useEffect(() => {
    if (self?.name) setName(self.name);
  }, [self?.name]);

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === self?.name) return;
    setSaving(true);
    try {
      await rename(trimmed);
      toast.success("Name saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename");
    } finally {
      setSaving(false);
    }
  };

  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    try {
      if (on) {
        await enablePush(push.categories);
        toast.success("Notifications are on");
      } else {
        await disablePush();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setPushBusy(false);
    }
  };

  const toggleCategory = async (key: keyof PushCategories, value: boolean) => {
    try {
      await updatePushCategories({ [key]: value });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const sendTest = async () => {
    try {
      await request("push.test", {});
      toast.success("Test sent. It may take a few seconds.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseTheme = (pref: ThemePref) => {
    setTheme(pref);
    setThemePref(pref);
  };

  return (
    <div className="mobile-main">
      <div className="flex flex-col gap-6 px-[var(--m-gutter)] py-5">
        <Group title="This phone">
          <div className="px-4 py-3">
            <label htmlFor="device-name" className="text-xs text-muted-foreground">
              Name on your computer
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <input
                id="device-name"
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void saveName()}
                className="m-input min-h-11 flex-1 rounded-xl border border-[var(--m-hairline)] bg-[var(--m-surface-strong)] px-3 text-foreground focus:border-primary/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={saving || !name.trim() || name.trim() === self?.name || conn !== "online"}
                aria-label="Save name"
                className="m-press m-touch flex items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-30"
              >
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
              </button>
            </div>
            {self?.createdAtMs ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Paired {new Date(self.createdAtMs).toLocaleDateString()} · can chat, answer
                approvals and get notifications. It cannot change settings or pair other devices.
              </p>
            ) : null}
          </div>
        </Group>

        <Group title="Notifications">
          <Row
            label="Notifications"
            hint={
              support.ok
                ? "Delivered straight from your gateway"
                : describePushSupport(support.reason)
            }
          >
            {pushBusy ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                checked={push.subscribed}
                disabled={!support.ok || conn !== "online"}
                onCheckedChange={(v) => void togglePush(v)}
                aria-label="Notifications"
                className="h-7 w-12 [&>span]:size-6 [&>span[data-state=checked]]:translate-x-5"
              />
            )}
          </Row>
          {push.subscribed &&
            CATEGORY_ROWS.map((row) => (
              <Row key={row.key} label={row.label} hint={row.hint}>
                <Switch
                  checked={push.categories[row.key]}
                  onCheckedChange={(v) => void toggleCategory(row.key, v)}
                  aria-label={row.label}
                  className="h-7 w-12 [&>span]:size-6 [&>span[data-state=checked]]:translate-x-5"
                />
              </Row>
            ))}
          {push.subscribed && (
            <button
              type="button"
              onClick={() => void sendTest()}
              className="m-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-base font-medium text-primary"
            >
              <Bell className="size-4" />
              Send a test notification
            </button>
          )}
        </Group>

        <Group title="Appearance">
          <div className="grid grid-cols-3 gap-2 p-2">
            {(
              [
                { id: "system", label: "System", icon: Laptop },
                { id: "dark", label: "Dark", icon: Moon },
                { id: "light", label: "Light", icon: Sun },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => chooseTheme(opt.id)}
                aria-pressed={theme === opt.id}
                className={cn(
                  "m-press flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl text-xs font-medium",
                  theme === opt.id ? "bg-primary/15 text-primary" : "text-muted-foreground",
                )}
              >
                <opt.icon className="size-5" />
                {opt.label}
              </button>
            ))}
          </div>
        </Group>

        <Group title="Pairing">
          {confirmUnpair ? (
            <div className="p-4">
              <p className="text-sm leading-relaxed">
                Unpair this phone? Its key and token are deleted and it stops getting notifications.
                You can pair it again from your computer.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmUnpair(false)}
                  className="m-press m-touch rounded-xl bg-[var(--m-surface-strong)] text-sm font-semibold"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => void unpair()}
                  className="m-press m-touch rounded-xl bg-danger text-sm font-semibold text-danger-foreground"
                >
                  Unpair
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmUnpair(true)}
              className="m-press flex min-h-12 w-full items-center gap-3 px-4 text-left text-base font-medium text-danger"
            >
              <Unlink className="size-4" />
              Unpair this phone
            </button>
          )}
        </Group>

        <p className="flex items-center justify-center gap-1.5 pb-2 text-center text-2xs text-muted-foreground">
          <Smartphone className="size-3" />
          Bitterbot {import.meta.env.VITE_APP_VERSION ?? ""} ·{" "}
          {self?.deviceId.slice(0, 12) ?? "this phone"}
        </p>
      </div>
    </div>
  );
}
