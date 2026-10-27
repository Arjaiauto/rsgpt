"use client";

import { useSyncExternalStore } from "react";
import { toastControls, toastStore } from "@/lib/toast";
import { IconCheck } from "./Icons";

export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get, toastStore.server);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.leaving ? " out" : ""}`}
          onMouseEnter={() => toastControls.pause(t.id)}
          onMouseLeave={() => toastControls.resume(t.id)}
        >
          <IconCheck className="ok" />
          <span>{t.message}</span>
          {t.undo && <button type="button" onClick={() => toastControls.undo(t.id)}>Undo</button>}
        </div>
      ))}
    </div>
  );
}
