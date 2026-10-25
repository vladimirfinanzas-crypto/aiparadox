"use client"

import { useCallback } from "react"
import { useAuth } from "@clerk/nextjs"
import { useRouter } from "next/navigation"

import { PAYWALL_ENABLED } from "@/lib/billing"

// The feature slug of the paid plan in Clerk Billing. Kept here so every gate in
// the block-programming section reads from one place.
const PAID_FEATURE = "bots"

// Where the pricing table lives inside the dashboard layout.
const BILLING_PATH = "/pricing"

export type PaidPlan = {
  // Whether Clerk has hydrated the session — `isPro` is not meaningful until
  // this is true, so components should treat `false` as "still loading".
  isLoaded: boolean
  // True when the signed-in person is on the paid plan.
  isPro: boolean
  // Send the person to the pricing page to subscribe or upgrade.
  goToUpgrade: () => void
}

// Tells a component whether the person is on the paid plan, and hands back a
// callback that routes them to pricing. Use to gate pro-only UI — such as the
// Agent node — behind an upgrade prompt instead of a broken control.
export function usePaidPlan(): PaidPlan {
  const { has, isLoaded } = useAuth()
  const router = useRouter()

  const goToUpgrade = useCallback(() => {
    router.push(BILLING_PATH)
  }, [router])

  // Test version: the paywall is off entirely, so everything reads as Pro.
  if (PAYWALL_ENABLED === false) return { isLoaded, isPro: true, goToUpgrade }

  // `has` is undefined until the session loads; optional-chain and default to
  // false so callers never treat "unknown" as "subscribed".
  const isPro = has?.({ feature: PAID_FEATURE }) ?? false

  return { isLoaded, isPro, goToUpgrade }
}

// Alias kept for the ported components that still ask the old question.
export const useProPlan = usePaidPlan
