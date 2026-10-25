import { NextResponse } from "next/server"

import { defaultLocale, isLocale } from "@/lib/i18n"

// Stores the person's language and sends them back. Only same-site paths are
// accepted as the return target, so this cannot be used as an open redirect.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const requested = url.searchParams.get("l")
  const next = url.searchParams.get("next") ?? "/"
  const locale = isLocale(requested) ? requested : defaultLocale

  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/"
  const response = NextResponse.redirect(new URL(target, url.origin))

  response.cookies.set("locale", locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  })

  return response
}
