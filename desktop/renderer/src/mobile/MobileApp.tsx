import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { ConnectionBanner, Header, TabBar } from "./components/Chrome";
import { SessionSheet } from "./components/Sheets";
import { takePairCodeFromLocation } from "./pairing-client";
import { registerServiceWorker } from "./push";
import { useRoute } from "./route";
import { ApprovalsScreen } from "./screens/ApprovalsScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { InstallFirstScreen, PairScreen, WelcomeScreen } from "./screens/Onboarding";
import { SettingsScreen } from "./screens/SettingsScreen";
import { StatusScreen } from "./screens/StatusScreen";
import { nudgeReconnect, useMobile } from "./store";
import { resolveDark, watchSystemTheme } from "./theme";

/**
 * The Bitterbot phone app (PLAN-62): a PWA served by the gateway at /m/,
 * built from the same renderer as the Control UI so it shares the design
 * tokens, the gateway client and the device identity, and so a future native
 * shell (Capacitor) can wrap it unchanged.
 */
export function MobileApp() {
  const phase = useMobile((s) => s.phase);
  const route = useRoute();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [dark, setDark] = useState(() => resolveDark());
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const code = takePairCodeFromLocation();
    void registerServiceWorker();
    if (code) {
      useMobile.getState().receivePairCode(code);
    } else {
      void useMobile.getState().boot();
    }
    // A pairing link opened while the app is already running (iOS reuses the window).
    const onHash = () => {
      const next = takePairCodeFromLocation();
      if (next) useMobile.getState().receivePairCode(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const stop = watchSystemTheme();
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      stop();
      observer.disconnect();
    };
  }, []);

  // Foreground/background: tell the gateway (push stays quiet while visible)
  // and reconnect at once on return instead of waiting out the backoff.
  useEffect(() => {
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      if (visible) {
        nudgeReconnect();
        const state = useMobile.getState();
        if (state.conn === "online") {
          void state.loadApprovals();
          void state.loadHistory();
        }
      }
      useMobile.getState().setVisible(visible);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    window.addEventListener("online", nudgeReconnect);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      window.removeEventListener("online", nudgeReconnect);
    };
  }, []);

  // Keyboard open on iOS: the visual viewport shrinks; drop the bottom inset.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const open = window.innerHeight - vv.height > 120;
      document.body.classList.toggle("keyboard-open", open);
      setKeyboardOpen(open);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // Deep link to a conversation (from a notification).
  useEffect(() => {
    const session = route.params.get("session");
    if (route.tab === "chat" && session && phase === "ready") {
      useMobile.getState().setSession(session);
    }
  }, [route, phase]);

  const toaster = (
    <Toaster
      theme={dark ? "dark" : "light"}
      position="top-center"
      offset="calc(env(safe-area-inset-top, 0px) + 0.75rem)"
      toastOptions={{ className: "mobile-app" }}
    />
  );

  if (phase === "boot") {
    return <div className="mobile-shell mobile-ground" />;
  }
  if (phase === "welcome") {
    return (
      <>
        <WelcomeScreen />
        {toaster}
      </>
    );
  }
  if (phase === "install") {
    return (
      <>
        <InstallFirstScreen />
        {toaster}
      </>
    );
  }
  if (phase === "pairing") {
    return (
      <>
        <PairScreen />
        {toaster}
      </>
    );
  }

  return (
    <div className="mobile-shell mobile-ground">
      <Header tab={route.tab} onOpenSessions={() => setSessionsOpen(true)} />
      <ConnectionBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        {route.tab === "chat" && <ChatScreen />}
        {route.tab === "approvals" && <ApprovalsScreen focusId={route.params.get("id")} />}
        {route.tab === "status" && <StatusScreen />}
        {route.tab === "settings" && <SettingsScreen />}
      </main>
      {/* One-handed typing: the keyboard replaces the tab bar while it is up. */}
      {keyboardOpen ? null : <TabBar tab={route.tab} />}
      <SessionSheet
        open={sessionsOpen}
        onOpenChange={(open) => {
          setSessionsOpen(open);
          if (open) void useMobile.getState().loadSessions();
        }}
      />
      {toaster}
    </div>
  );
}
