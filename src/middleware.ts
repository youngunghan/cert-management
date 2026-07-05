import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// SECURITY: app-level CSRF defense.
// The mutating /api routes authenticate via the NextAuth cookie session only,
// which is exactly the model a cross-site request forgery can ride. None of the
// handlers verified Origin/Referer or a CSRF token, so we enforce same-origin
// here for every state-changing /api request.
//
// /api/auth/* is intentionally excluded: NextAuth ships its own CSRF token for
// its endpoints, and adding a second check here can break the sign-in flow.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function configuredOrigins(): string[] {
  return [process.env.BASE_URL, process.env.NEXTAUTH_URL]
    .filter((o): o is string => Boolean(o))
    .map((o) => o.replace(/\/$/, ""));
}

export function middleware(request: NextRequest) {
  if (!MUTATING_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  // NextAuth manages its own CSRF protection for these routes.
  if (request.nextUrl.pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");
  // Same-origin requests always send Origin for these methods. Allow the
  // request's own origin plus any explicitly configured (e.g. proxied) origins.
  const allowed = new Set([request.nextUrl.origin, ...configuredOrigins()]);

  if (!origin || !allowed.has(origin)) {
    return NextResponse.json(
      {
        result: false,
        error: {
          title: "Forbidden",
          message: "Invalid request origin (CSRF protection)",
        },
      },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
