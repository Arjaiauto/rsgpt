"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Tells the server which page (and which of a few filters) was opened, once per change of address. sendBeacon (or a
    keepalive fetch) is fire-and-forget, so it never delays navigation; the server decides what is kept
    (app/api/event/route.ts). Only mounted inside the logged-in app, so /login and logged-out pages send nothing. */
const KEYS = ["q", "topic", "guest", "len", "year", "lang", "sort", "start"];

export function PageViewBeacon() {
  const path = usePathname();
  const search = useSearchParams();
  const last = useRef("");

  useEffect(() => {
    const params: Record<string, string> = {};
    for (const k of KEYS) {
      const v = search.get(k);
      if (v) params[k] = v.slice(0, 120);
    }
    const body = JSON.stringify({ path, params });
    if (body === last.current) return;
    last.current = body;
    try {
      const sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/event", new Blob([body], { type: "application/json" }));
      if (!sent) void fetch("/api/event", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {});
    } catch {
      /* logging is never worth an error */
    }
  }, [path, search]);

  return null;
}
