import { NextResponse, type NextRequest } from "next/server";
import { currentGuestSlug } from "@/lib/guest-slug";
import { guestExists } from "@/lib/guest-exists";
import { SESSION_COOKIE, readSessionToken } from "@/lib/session";

const PUBLIC_PATHS = new Set(["/", "/login"]);

/** Old guest URLs used the raw guest_key ("/guests/khan-sir--"); the page is at the clean slug ("/guests/khan-sir"),
    or at the guest it was merged into by a correction. */
function cleanGuestUrl(request: NextRequest): URL | null {
  const m = /^\/guests\/([^/]+)$/.exec(request.nextUrl.pathname);
  if (!m) return null;
  let raw: string;
  try { raw = decodeURIComponent(m[1]); } catch { return null; }
  const slug = currentGuestSlug(raw);
  if (!slug || slug === raw) return null;
  const url = request.nextUrl.clone();
  url.pathname = `/guests/${slug}`;
  return url;
}

export async function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  if (readSessionToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    const clean = cleanGuestUrl(request);
    if (clean) return NextResponse.redirect(clean, 308);
    // An unknown guest address gets the 404 page with a real 404 status (the guest page streams, so it can't set it).
    const m = /^\/guests\/([^/]+)$/.exec(request.nextUrl.pathname);
    if (m && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(m[1]) && !(await guestExists(m[1]))) return NextResponse.rewrite(new URL("/not-found-guest", request.url));
    return NextResponse.next();
  }
  // An API call without a session is answered as an API: 401 JSON, not a redirect to the login page.
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except Next's static files, robots.txt, the icon and any file with an extension in public/.
  matcher: ["/((?!_next/static|_next/image|robots\\.txt|icon\\.svg|.*\\.[a-zA-Z0-9]+$).*)"],
};
