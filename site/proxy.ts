import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, readSessionToken } from "@/lib/session";

const PUBLIC_PATHS = new Set(["/", "/login"]);

export function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  if (readSessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // Everything except Next's static files, robots.txt, the icon and any file with an extension in public/.
  matcher: ["/((?!_next/static|_next/image|robots\\.txt|icon\\.svg|.*\\.[a-zA-Z0-9]+$).*)"],
};
