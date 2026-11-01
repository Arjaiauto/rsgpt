// Signed session cookie: base64url(JSON {n: first name, exp: unix seconds}) + "." + base64url(HMAC-SHA256).
// Used by proxy.ts and server code only; SESSION_SECRET never reaches the browser.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cp_session";
export const VISITOR_COOKIE = "visitor_id";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type Session = { firstName: string };

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is missing or shorter than 32 characters");
  return s;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** A one-way, keyed hash of an IP address (HMAC with SESSION_SECRET, cut to 22 characters), so rate limits can tell
    callers apart without a raw IP ever being written to the database. */
export const hashIp = (ip: string) => sign(`ip:${ip}`).slice(0, 22);

export function createSessionToken(firstName: string): string {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const payload = Buffer.from(JSON.stringify({ n: firstName, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { n, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof n !== "string" || !n || typeof exp !== "number" || exp < Date.now() / 1000) return null;
    return { firstName: n };
  } catch {
    return null;
  }
}

export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: COOKIE_MAX_AGE,
};
