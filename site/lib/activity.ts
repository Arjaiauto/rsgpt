import "server-only";
import { after } from "next/server";
import { db } from "@/lib/db";
import type { DeviceType } from "@/lib/device";

/** Who did what, saved in public.visitors and public.events (pipeline/sql/visitors_events.sql). Logging never blocks or
    breaks a request: each write is one database call that runs after the response has been sent (Next's after()), has a
    short timeout, and swallows every error. The first failure is written to the server log, later ones are not. */

const TIMEOUT_MS = 3000;
let warned = false;

type Reply = PromiseLike<{ error: { message: string } | null }>;

function background(write: (signal: AbortSignal) => Reply): void {
  const run = async () => {
    try {
      const { error } = await write(AbortSignal.timeout(TIMEOUT_MS));
      if (error) throw new Error(error.message);
    } catch (e) {
      if (warned) return;
      warned = true;
      console.error("activity logging failed (shown once):", e instanceof Error ? e.message : "unknown");
    }
  };
  try {
    after(run);
  } catch {
    void run(); // outside a request (a script): just start it
  }
}

/** A successful login: creates or updates the visitor and writes the 'login' event. */
export function recordLogin(firstName: string, device: DeviceType, deviceId: string | null): void {
  background((signal) => db().rpc("record_login", { p_name: firstName, p_device_type: device, p_device_id: deviceId }).abortSignal(signal));
}

export type EventType = "page_view" | "find_line";

/** One action by a signed-in person. `detail` is small JSON (the database refuses more than 1,000 characters). */
export function logEvent(firstName: string, deviceId: string | null, type: EventType, detail: Record<string, string>): void {
  background((signal) => db().rpc("log_event", { p_name: firstName, p_device_id: deviceId, p_type: type, p_detail: detail }).abortSignal(signal));
}
