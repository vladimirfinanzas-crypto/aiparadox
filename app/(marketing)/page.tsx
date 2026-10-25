import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@clerk/nextjs/server"

import { ArrowRight, Bot, Check, MessageSquare, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import { GlowCard } from "@/components/ui/spotlight-card"
import { MotionTilt } from "@/components/motion-tilt"
import { HeroCta } from "@/components/hero-cta"
import { ParadoxLogo } from "@/components/paradox-logo"
import { LandingHyperspeedBackground } from "@/components/landing-hyperspeed-background"
import { Reveal } from "@/components/landing-reveal"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getDict } from "@/lib/i18n.server"

const sectionIcons = [MessageSquare, Bot, Workflow] as const

// Per-card glow windows: together the three cards sweep the Hyperspeed
// spectrum - pink/magenta tail to violet middle to azure/blue head.
const sectionGlows = [
  { base: 300, spread: 60 },
  { base: 255, spread: 60 },
  { base: 207, spread: 60 },
] as const

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ landing?: string }>
}) {
  const { t } = await getDict()
  const { userId } = await auth()
  const { landing } = await searchParams

  // The product's front door is Godfather, so a signed-in visit to the root goes
  // straight to it instead of showing the pitch again. `?landing=1` — what the
  // logo inside the dashboard links to — is the explicit request to see the
  // public page, and it never touches the session.
  if (userId && !landing) redirect("/chats")

  const entryHref = userId ? "/chats" : "/sign-in"
  // With a session, the calls to action say where they go instead of inviting
  // somebody who already signed up to «start» again.
  const ctaOverride = userId ? t.nav.backToApp : null

  // SEO: structured data for rich results (product + FAQ).
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: t.brand,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description:
          "Un chat con agentes de IA para navegador, PC y redes sociales que ejecutan el trabajo por ti.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@type": "FAQPage",
        mainEntity: t.faq.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: { "@type": "Answer", text: item.a },
        })),
      },
    ],
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-transparent">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Cinematic Hyperspeed highway behind the whole page (one fixed instance). */}
      <LandingHyperspeedBackground />

      {userId && (
        <div className="relative z-20 flex justify-center px-4 pt-4">
          <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shadow-lg shadow-black/20 backdrop-blur-md sm:mr-48">
            <span>{t.nav.signedIn}</span>
            <Link
              href="/chats"
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {t.nav.backToApp}
            </Link>
          </div>
        </div>
      )}

      {/* Hero section */}
      <section className="relative flex min-h-[85svh] w-full items-center overflow-hidden bg-transparent py-12 sm:py-24">
        <div className="relative z-10 w-full max-w-2xl rounded-r-2xl bg-background/30 px-4 py-8 backdrop-blur-sm sm:px-6 lg:px-12 lg:py-12">
          <ParadoxLogo
            text={t.brand}
            fillClassName="bg-sky-300"
            className="mb-5 text-6xl font-bold tracking-tight sm:text-7xl"
          />

          <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-5xl">
            <span className="bg-gradient-to-r from-violet-400 via-sky-400 to-cyan-300 bg-clip-text text-transparent">
              {t.hero.highlight}
            </span>
          </h1>

          <div className="flex flex-col gap-2 sm:flex-row">
            <HeroCta
              href={entryHref}
              className="pointer-events-auto rounded-full border border-primary/40 bg-primary/90 px-6 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary"
            >
              {ctaOverride ?? t.hero.ctaPrimary}
              <ArrowRight data-icon="inline-end" aria-hidden />
            </HeroCta>
            <Button
              variant="outline"
              size="lg"
              render={<Link href="#how" />}
              className="pointer-events-auto border-border/70 bg-card/60 backdrop-blur-md"
            >
              {t.hero.ctaSecondary}
            </Button>
          </div>
        </div>
      </section>

      {/* Page content layered above */}
      <div className="relative z-10 w-full bg-transparent px-4 sm:px-6">
        {/* ----------------------------------------------------------- Trust */}
        <section
          aria-label={t.trust.eyebrow}
          className="mx-auto w-full max-w-6xl bg-transparent py-12"
        >
          <div className="rounded-2xl border border-border/40 bg-card/50 px-6 py-8 backdrop-blur-xl">
            <p className="text-center text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t.trust.eyebrow}
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-6 lg:grid-cols-4">
              {t.trust.stats.map((stat) => (
                <div key={stat.label} className="text-center">
                  <dd className="text-3xl font-bold sm:text-4xl">
                    {stat.value}
                  </dd>
                  <dt className="mt-1 text-xs text-muted-foreground sm:text-sm">
                    {stat.label}
                  </dt>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ------------------------------------------------------------ Pain */}
        <section className="mx-auto w-full max-w-6xl bg-transparent py-16">
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold tracking-widest text-red-400/80 uppercase">
              {t.pain.eyebrow}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              {t.pain.title}
            </h2>
            <p className="mt-4 text-muted-foreground">{t.pain.description}</p>
          </Reveal>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {t.pain.items.map((item, i) => (
              <Reveal key={item.title} delay={i * 0.1}>
                <GlowCard glowColor="red" customSize className="h-full w-full">
                  <div className="flex h-full flex-col justify-center px-6 py-8 text-center">
                    <h3 className="font-semibold">{item.title}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </GlowCard>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------- Sections */}
        <section
          id="chat"
          className="mx-auto w-full max-w-6xl scroll-mt-24 bg-transparent px-4 py-16 sm:px-6"
        >
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">
              {t.solutions.eyebrow}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              {t.solutions.title}
            </h2>
            <p className="mt-4 text-muted-foreground">{t.solutions.sub}</p>
          </Reveal>
          <div className="mt-10 grid gap-6 bg-transparent md:grid-cols-3">
            {t.sections.map((section, index) => {
              const Icon = sectionIcons[index]
              return (
                <div
                  key={section.name}
                  id={section.name.toLowerCase()}
                  className="h-full scroll-mt-24 bg-transparent"
                >
                  <GlowCard
                    glowHue={sectionGlows[index]}
                    customSize
                    className="h-full w-full bg-transparent [--card-spacing:0px]"
                  >
                    <CardHeader>
                      <span className="mb-3 grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <CardTitle className="text-xl">
                        {section.title}
                      </CardTitle>
                      <CardDescription className="text-sm leading-relaxed">
                        {section.description}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2 text-sm text-muted-foreground">
                        {section.points.map((point) => (
                          <li key={point} className="flex gap-2">
                            <Check
                              className="mt-0.5 size-4 shrink-0 text-primary"
                              aria-hidden
                            />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </GlowCard>
                </div>
              )
            })}
          </div>
        </section>

        {/* ---------------------------------------------------- Capabilities */}
        <section className="mx-auto w-full max-w-6xl bg-transparent px-4 py-16 sm:px-6">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-balance">
              {t.capabilities.title}
            </h2>
            <p className="mt-4 text-muted-foreground">{t.capabilities.sub}</p>
          </Reveal>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {t.capabilities.items.map((item, i) => (
              <Reveal key={item.title} delay={i * 0.1}>
                <div className="h-full rounded-2xl border border-border/40 bg-card/50 p-6 backdrop-blur-xl">
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* -------------------------------------------------------------- How */}
        <section
          id="how"
          className="mx-auto w-full max-w-6xl scroll-mt-24 bg-transparent px-4 py-16 sm:px-6"
        >
          <Reveal className="mx-auto max-w-2xl text-center">
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">
              {t.how.eyebrow}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight">
              {t.how.title}
            </h2>
            <p className="mt-4 text-muted-foreground">{t.how.sub}</p>
          </Reveal>
          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {t.how.steps.map((step, index) => (
              <Reveal key={step.title} delay={index * 0.1}>
                <li className="h-full rounded-xl border border-border/40 bg-card/50 p-5 backdrop-blur-xl">
                  <span className="inline-grid size-7 place-items-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {index + 1}
                  </span>
                  <p className="mt-3 font-medium">{step.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {step.description}
                  </p>
                </li>
              </Reveal>
            ))}
          </ol>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section className="mx-auto w-full max-w-3xl bg-transparent px-4 py-16 sm:px-6">
          <Reveal className="text-center">
            <p className="text-xs font-semibold tracking-widest text-primary uppercase">
              {t.faq.eyebrow}
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              {t.faq.title}
            </h2>
          </Reveal>
          <Reveal delay={0.1} className="mt-10">
            <div className="rounded-2xl border border-border/40 bg-card/50 px-5 py-2 backdrop-blur-xl">
              <Accordion>
                {t.faq.items.map((item, i) => (
                  <AccordionItem key={item.q} value={`faq-${i}`}>
                    <AccordionTrigger className="py-4 text-sm hover:no-underline sm:text-base">
                      {item.q}
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      {item.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </Reveal>
        </section>

        {/* --------------------------------------------------------------- CTA */}
        <section className="mx-auto w-full max-w-6xl bg-transparent px-4 pb-12 sm:px-6">
          <div className="rounded-2xl border border-primary/20 bg-primary/10 px-6 py-14 text-center">
            <h2 className="text-3xl font-semibold tracking-tight">
              {t.cta.title}
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
              {t.cta.description}
            </p>
            <Button
              size="lg"
              variant="secondary"
              className="mt-7"
              render={<Link href={entryHref} />}
            >
              {ctaOverride ?? t.cta.button}
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Button>
            <p className="mt-4 text-xs text-muted-foreground">{t.cta.micro}</p>
          </div>
        </section>

        {/* --------------------------------------------------------- Final CTA */}
        <section className="mx-auto w-full max-w-3xl bg-transparent px-4 pb-24 text-center sm:px-6">
          <Reveal>
            <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              {t.finalCta.title}
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              {t.finalCta.description}
            </p>
            <div className="mt-8 flex justify-center">
              <HeroCta
                href={entryHref}
                className="rounded-full px-8 py-4 text-base"
              >
                {ctaOverride ?? t.finalCta.button}
              </HeroCta>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              {t.finalCta.micro}
            </p>
          </Reveal>
        </section>
      </div>
    </div>
  )
}