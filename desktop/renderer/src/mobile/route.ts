import { useEffect, useState } from "react";

export type Tab = "chat" | "approvals" | "status" | "settings";

export type Route = { tab: Tab; params: URLSearchParams };

const TABS: ReadonlySet<Tab> = new Set<Tab>(["chat", "approvals", "status", "settings"]);

/** `#/approvals?id=rv-1` -> { tab: "approvals", params: id=rv-1 }. Unknown -> chat. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const name = path.replace(/^\//, "") as Tab;
  return { tab: TABS.has(name) ? name : "chat", params: new URLSearchParams(query) };
}

export function navigate(tab: Tab, params?: Record<string, string>) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : "";
  const next = `#/${tab}${query}`;
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
