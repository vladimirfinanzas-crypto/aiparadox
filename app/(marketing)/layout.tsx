import { auth } from "@clerk/nextjs/server"
import type { Metadata } from "next"
import Link from "next/link"

import { LocaleSwitcher } from "@/components/locale-switcher"
import { ParadoxLogo } from "@/components/paradox-logo"
import { Button } from "@/components/ui/button"
import { getDict } from "@/lib/i18n.server"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://paradox.app"

export const metadata: Metadata = {
  title: {
    default: "Paradox — Agentes de IA que hacen el trabajo",
    template: "%s | Paradox",
  },
  description:
    "Un chat que delega a agentes de navegador, PC y redes sociales. Crea tu primer agente en menos de un minuto. Sin tarjeta.",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "es_ES",
    alternateLocale: ["en_US"],
    url: "/",
    siteName: "Paradox",
    title: "Paradox — Agentes de IA que hacen el trabajo",
    description:
      "Un chat que delega a agentes de navegador, PC y redes sociales. Crea tu primer agente en menos de un minuto.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Paradox — Agentes de IA que hacen el trabajo",
    description:
      "Un chat que delega a agentes de navegador, PC y redes sociales.",
  },
  robots: { index: true, follow: true },
}

// The public face of the product: header and footer around the landing page.
// Nothing here is protected — the dashboard guards itself.
export default async function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { locale, t } = await getDict()

  // The landing page is public for everybody, including people who already have
  // a session: the button says where it will take them instead of asking them to
  // sign up again. Nothing here signs anybody out.
  const { userId } = await auth()

  return (
    <div className="flex min-h-svh flex-col bg-transparent text-foreground">
      {/* Floating controls — the sticky top panel was removed: only the
          language switcher (es/en) and "Open app" remain, floating over
          the page from the top-right corner. */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-2 py-1.5 shadow-lg shadow-black/20 backdrop-blur-md">
        <LocaleSwitcher current={locale} />
        <Button render={<Link href="/chats" />}>
          {userId ? t.nav.backToApp : t.nav.openApp}
        </Button>
      </div>

      <main className="flex-1 bg-transparent">{children}</main>

      <footer className="border-t border-border/40 bg-background/85 backdrop-blur-md">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6">
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-semibold">
              <ParadoxLogo
                text={t.brand}
                fillClassName="bg-sky-300"
                className="text-2xl font-bold"
              />
            </div>
            <p className="max-w-xs text-sm text-muted-foreground">
              {t.footer.tagline}
            </p>
          </div>

          <nav aria-label={t.footer.product} className="text-sm">
            <p className="mb-3 font-medium">{t.footer.product}</p>
            <ul className="space-y-2 text-muted-foreground">
              <li>
                <Link href="#chat" className="hover:text-foreground">
                  {t.sections[0].name}
                </Link>
              </li>
              <li>
                <Link href="#agents" className="hover:text-foreground">
                  {t.sections[1].name}
                </Link>
              </li>
              <li>
                <Link href="#workflows" className="hover:text-foreground">
                  {t.sections[2].name}
                </Link>
              </li>
              <li>
                <Link href="/pricing" className="hover:text-foreground">
                  {t.nav.pricing}
                </Link>
              </li>
            </ul>
          </nav>

          <nav aria-label={t.footer.company} className="text-sm">
            <p className="mb-3 font-medium">{t.footer.company}</p>
            <ul className="space-y-2 text-muted-foreground">
              <li>
                <Link href="/sign-up" className="hover:text-foreground">
                  {t.nav.signUp}
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-foreground">
                  {t.footer.terms}
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="hover:text-foreground">
                  {t.footer.privacy}
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-border/40 py-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} {t.brand}. {t.footer.rights}
        </div>
      </footer>
    </div>
  )
}
