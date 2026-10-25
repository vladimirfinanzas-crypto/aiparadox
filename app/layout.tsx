import { ClerkProvider } from "@clerk/nextjs"
import { shadcn } from "@clerk/ui/themes"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { getLocale } from "@/lib/i18n.server"
import { cn } from "@/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// Mobile browsers need an explicit viewport: no user-scale clamping (a11y),
// safe-area insets for notches/home bars, and a theme-color so the UA chrome
// matches the app surface in both schemes.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f7" },
    { media: "(prefers-color-scheme: dark)", color: "#08080a" },
  ],
} satisfies import("next").Viewport

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // The document language follows the person's chosen locale
  const locale = await getLocale()

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable
      )}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function() {
  try {
    var theme = localStorage.getItem('theme') || 'dark';
    if (theme === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(theme);
    document.documentElement.style.colorScheme = theme;
  } catch(e) {}
})()`
          }} />
      </head>
      <body>
        <ClerkProvider appearance={{ theme: shadcn }}>
          <ThemeProvider>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster />
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  )
}
