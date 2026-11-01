"use server";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOGIN_LIMIT, takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, cookieOptions, createSessionToken } from "@/lib/session";

export type LoginState = { error: string; field: "fname" | "pw" | ""; attempt: number };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

function passwordMatches(given: string, want: string): boolean {
  return timingSafeEqual(sha(given), sha(want));
}

/** First word only, letters and common name marks, at most 40 characters. */
function cleanFirstName(raw: string): string {
  const first = raw.normalize("NFC").trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\p{L}\p{M}'.-]/gu, "").slice(0, 40);
}

export async function login(prev: LoginState, form: FormData): Promise<LoginState> {
  const attempt = prev.attempt + 1;
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip") || "local";
  if (!(await takeTry(`login:${ip}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs))) {
    return { error: "Too many tries. Wait a few minutes and try again.", field: "pw", attempt };
  }

  const firstName = cleanFirstName(String(form.get("fname") ?? ""));
  if (!firstName) return { error: "Add your first name so we know who's asking.", field: "fname", attempt };
  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) return { error: "Login isn't set up yet: SITE_PASSWORD is empty on the server.", field: "pw", attempt };
  if (!passwordMatches(String(form.get("pw") ?? ""), sitePassword)) {
    return { error: "That password didn't work. Check it and try again.", field: "pw", attempt };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, createSessionToken(firstName), cookieOptions);
  if (!jar.get(VISITOR_COOKIE)) jar.set(VISITOR_COOKIE, randomUUID(), cookieOptions);
  redirect("/ask");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
