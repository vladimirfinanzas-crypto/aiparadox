"use server"

import { auth } from "@clerk/nextjs/server"
import * as Sentry from "@sentry/nextjs"

import { pcAgentSetup } from "@/lib/pc"
import {
  getConnectUrl,
  listAccounts,
  zernioPlatforms,
  type ZernioPlatform,
} from "@/lib/zernio"

function appUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
}

// Reads the accounts connected to this person's Zernio profile. It is called on
// demand from the Integrations page (never during render), so a slow or
// unconfigured provider cannot block the page.
export async function fetchSocialAccounts() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  try {
    const accounts = await listAccounts(userId)
    Sentry.logger.info("Social accounts listed", {
      "user.id": userId,
      "social.account_count": accounts.length,
    })

    return {
      error: null,
      accounts: accounts.map((account) => ({
        id: account._id,
        platform: account.platform,
        username: account.username,
        active: account.isActive,
      })),
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zernio no respondió."
    Sentry.logger.warn("Social accounts failed", {
      "user.id": userId,
      error: message,
    })
    return { accounts: [], error: message }
  }
}

// The URL the person opens to authorize one network for their own profile. The
// agent cannot do this for them, and the key never reaches the browser.
export async function socialConnectUrl(platform: string) {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")
  if (!zernioPlatforms.includes(platform as ZernioPlatform)) {
    throw new Error("Unknown social platform")
  }

  try {
    const url = await getConnectUrl(
      userId,
      platform as ZernioPlatform,
      `${appUrl()}/integrations`
    )

    Sentry.logger.info("Social connect link created", {
      "user.id": userId,
      "social.platform": platform,
    })

    return { url, error: null }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zernio no respondió."
    return { url: null, error: message }
  }
}

// The token and command for the local PyAutoGUI module. It is the person's own
// credential, shown only to them, and it never appears in logs.
export async function pcAgentInstructions() {
  const { isAuthenticated, userId } = await auth()
  if (!isAuthenticated) throw new Error("Unauthorized")

  const setup = await pcAgentSetup(userId)
  return {
    token: setup.token,
    status: setup.status,
    command: setup.command.replace("<PC_AGENT_TOKEN>", setup.token).replace(
      "<APP_URL>",
      appUrl()
    ),
  }
}
