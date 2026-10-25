import { auth } from "@clerk/nextjs/server"
import { SettingsIcon } from "lucide-react"
import type { Metadata } from "next"

import { SettingsTabs } from "@/components/settings/settings-tabs"

export const metadata: Metadata = { title: "Settings · Paradox" }

// Every Settings view shares this header and these tabs, so moving between
// General, Integrations, Activity and Desktop Agent never looks like leaving the
// section. The pages below it load their own data; this layout protects the
// whole subtree once.
export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await auth.protect()

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="size-5 text-primary" aria-hidden />
          Settings
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Tu cuenta, tus integraciones, la actividad de tus agentes y el agente
          de escritorio. Todo lo que afecta a cómo trabaja Paradox contigo.
        </p>
        <SettingsTabs />
      </header>

      <div className="min-w-0">{children}</div>
    </div>
  )
}
