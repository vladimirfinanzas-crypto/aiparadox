import { createPost, listAccounts, type ZernioPlatform } from "@/lib/zernio"

// The social block: publishes the text it is given to one or more connected
// accounts. Network names arrive as a comma-separated list because a node's
// fields are plain text — `twitter, linkedin` — and the account for each is
// picked from the person's own connected accounts rather than trusted from the
// canvas.
export async function publishSocial({
  userId,
  values,
}: {
  userId: string
  values: Record<string, string>
}) {
  const content = values.content?.trim()
  if (!content) throw new Error("The post needs content.")

  const wanted = [...new Set(
    (values.platforms ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  )]
  if (wanted.length === 0) {
    throw new Error('Name at least one network, e.g. "twitter, linkedin".')
  }

  const accounts = await listAccounts(userId)
  const preferred = values.accountId?.trim()

  const targets = wanted.map((platform) => {
    const match = preferred
      ? accounts.find(
          (account) => account._id === preferred && account.platform === platform
        )
      : accounts.find(
          (account) => account.platform === platform && account.isActive
        )

    if (!match) {
      throw new Error(
        `No connected ${platform} account. Open Agents, talk to the social agent and connect one first.`
      )
    }

    return { platform: platform as ZernioPlatform, accountId: match._id }
  })

  const timezone = values.timezone?.trim() || "UTC"
  const scheduledFor = values.scheduledFor?.trim()

  const post = await createPost(userId, {
    content,
    platforms: targets,
    ...(scheduledFor
      ? { scheduledFor, timezone }
      : // Neither set means a draft, so publish straight away unless the node
        // was told otherwise
        { publishNow: values.publishNow?.trim() !== "false" }),
  })

  return {
    postId: post._id,
    status: post.status,
    links: post.platforms
      .map((entry) => entry.platformPostUrl)
      .filter(Boolean)
      .join("\n"),
  }
}
