import { NextResponse, type NextRequest } from "next/server";
import { currentGuestSlug } from "@/lib/guest-slug";
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

export function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  if (readSessionToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    const clean = cleanGuestUrl(request);
    return clean ? NextResponse.redirect(clean, 308) : NextResponse.next();
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except Next's static files, robots.txt, the icon and any file with an extension in public/.
  matcher: ["/((?!_next/static|_next/image|robots\\.txt|icon\\.svg|.*\\.[a-zA-Z0-9]+$).*)"],
};
