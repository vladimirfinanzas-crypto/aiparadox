// Zernio: one REST API for publishing to 16 social networks.
// Docs: https://docs.zernio.com  ·  Base URL: https://zernio.com/api/v1
//
// Multi-tenant on purpose. The product holds one platform key
// (`ZERNIO_API_KEY`) and gives every person their own Zernio *profile*, so the
// accounts they connect are scoped to them and webhooks can be routed back by
// profile. The profile id lives in `integrations.zernioProfileId`.
//
// Only endpoints documented in the Zernio quickstart are used: creating a
// profile, getting a connect URL, listing accounts, creating a post and
// reading a post back. Anything else waits for its own docs page rather than
// being guessed at.

import { db } from "@/db"
import { integrations } from "@/db/schema"

const BASE = "https://zernio.com/api/v1"

// The 16 platforms Zernio accepts, by their API value
export const zernioPlatforms = [
  "twitter",
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "pinterest",
  "reddit",
  "bluesky",
  "threads",
  "googlebusiness",
  "telegram",
  "snapchat",
  "whatsapp",
  "discord",
  "slack",
] as const

export type ZernioPlatform = (typeof zernioPlatforms)[number]

export type ZernioAccount = {
  _id: string
  platform: string
  username: string
  isActive: boolean
}

export type ZernioPost = {
  _id: string
  status: "draft" | "scheduled" | "publishing" | "published" | "failed" | "partial"
  scheduledFor?: string
  platforms: { platform: string; status?: string; platformPostUrl?: string }[]
}

async function call<T>(
  path: string,
  init: RequestInit & { retries?: number } = {}
): Promise<T> {
  const key = process.env.ZERNIO_API_KEY
  if (!key) {
    throw new Error(
      "ZERNIO_API_KEY is not set, so social accounts can't be reached."
    )
  }

  const { retries = 1, ...rest } = init
  const response = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...rest.headers,
    },
    // Zernio is rate limited; a short retry keeps one burst from failing a turn
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    if (response.status === 429 && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      return call(path, { ...init, retries: retries - 1 })
    }
    throw new Error(
      `Zernio ${response.status} on ${path}${body ? `: ${body.slice(0, 300)}` : ""}`
    )
  }

  return (await response.json()) as T
}

// This person's Zernio profile, created the first time they publish. Every
// account they connect afterwards belongs to it, never to another person's.
export async function getOrCreateProfile(userId: string): Promise<string> {
  const existing = await db.query.integrations.findFirst({
    where: (table, { eq }) => eq(table.userId, userId),
  })
  if (existing?.zernioProfileId) return existing.zernioProfileId

  const created = await call<{ profile: { _id: string } }>("/profiles", {
    method: "POST",
    body: JSON.stringify({ name: `paradox-${userId}` }),
  })

  await db
    .insert(integrations)
    .values({ userId, zernioProfileId: created.profile._id })
    .onConflictDoUpdate({
      target: integrations.userId,
      set: { zernioProfileId: created.profile._id },
    })

  return created.profile._id
}

// The URL the person opens to authorize one network for their profile
export async function getConnectUrl(
  userId: string,
  platform: ZernioPlatform,
  redirectUrl?: string
): Promise<string> {
  const profileId = await getOrCreateProfile(userId)
  const query = new URLSearchParams({ profileId })
  if (redirectUrl) query.set("redirect_url", redirectUrl)

  const data = await call<{ authUrl: string }>(
    `/connect/${platform}?${query.toString()}`
  )
  return data.authUrl
}

// The accounts already connected to this person's profile, by network
export async function listAccounts(userId: string): Promise<ZernioAccount[]> {
  const profileId = await getOrCreateProfile(userId)
  const data = await call<{ accounts: ZernioAccount[] }>(
    `/accounts?profileId=${encodeURIComponent(profileId)}`
  )
  return data.accounts
}

export type CreatePostInput = {
  content: string
  // Published at this moment when true, saved as a draft when neither this nor
  // `scheduledFor` is set
  publishNow?: boolean
  scheduledFor?: string
  // IANA timezone the `scheduledFor` value is read in
  timezone?: string
  platforms: { platform: ZernioPlatform; accountId: string }[]
}

export async function createPost(
  userId: string,
  input: CreatePostInput
): Promise<ZernioPost> {
  await getOrCreateProfile(userId)

  const data = await call<{ post: ZernioPost }>("/posts", {
    method: "POST",
    body: JSON.stringify(input),
    // The request id makes a retry return the original post instead of
    // publishing twice — Zernio rejects identical content within 24h with a 409
    headers: { "x-request-id": crypto.randomUUID() },
  })

  return data.post
}

export async function getPost(postId: string): Promise<ZernioPost> {
  const data = await call<{ post: ZernioPost }>(
    `/posts/${encodeURIComponent(postId)}`
  )
  return data.post
}
