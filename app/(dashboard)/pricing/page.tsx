import { auth } from "@clerk/nextjs/server"

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { PAYWALL_ENABLED } from "@/lib/billing"

export default async function Page() {
  await auth.protect()

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 py-12">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p className="text-muted-foreground">
          {PAYWALL_ENABLED
            ? "Bots and their sandboxes are part of the paid plan."
            : "Billing is off in this test version — everything is unlocked."}
        </p>
      </div>
      {!PAYWALL_ENABLED && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Everything is included right now</EmptyTitle>
            <EmptyDescription>
              Plans and checkout come back when billing is enabled.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}
