"use client"

import { usePathname } from "next/navigation"

import { locales, type Locale } from "@/lib/i18n"

const labels: Record<Locale, string> = { es: "ES", en: "EN" }

// ES / EN switch. It sets the `locale` cookie and comes back to the page you
// were on, so nothing on screen changes shape except the language.
//
// Plain anchors on purpose, not <Link>: a client-side navigation renders the
// destination from the router cache, which was prefetched with the old
// cookie — so the page would keep the previous language until a hard refresh.
// A full document navigation is what guarantees the server sees the new
// cookie and renders the correct dictionary.
export function LocaleSwitcher({ current }: { current: Locale }) {
  const pathname = usePathname()

  return (
    <div
      className="flex items-center rounded-full border p-0.5"
      aria-label="Idioma / Language"
    >
      {locales.map((locale) => (
        <a
          key={locale}
          href={`/api/locale?l=${locale}&next=${encodeURIComponent(pathname)}`}
          hrefLang={locale}
          aria-current={locale === current ? "true" : undefined}
          className={
            "rounded-full px-2 py-1 text-xs font-medium transition-colors " +
            (locale === current
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {labels[locale]}
        </a>
      ))}
    </div>
  )
}
