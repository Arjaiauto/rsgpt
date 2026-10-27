import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SESSION_COOKIE, readSessionToken, type Session } from "./session";

/** The signed-in person, read from the session cookie on the server. proxy.ts already redirects
    visitors without a session; this check repeats it so pages never rely on proxy alone. */
export async function requireSession(): Promise<Session> {
  // The expiry check reads the clock, so this must run per request, never in a prerender.
  await connection();
  const session = readSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  return session;
}
