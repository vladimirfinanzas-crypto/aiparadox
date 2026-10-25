import { cookies } from "next/headers"

import {
  defaultLocale,
  dictionaries,
  isLocale,
  type Dictionary,
  type Locale,
} from "@/lib/i18n"

// The locale from the cookie set by /api/locale, defaulting to Spanish. Split
// from lib/i18n.ts because `cookies` is server-only and client components
// (locale switcher, dialogs) import the dictionaries from that module.
export async function getLocale(): Promise<Locale> {
  const store = await cookies()
  const raw = store.get("locale")?.value
  return isLocale(raw) ? raw : defaultLocale
}

export async function getDict(): Promise<{ locale: Locale; t: Dictionary }> {
  const locale = await getLocale()
  return { locale, t: dictionaries[locale] }
}
