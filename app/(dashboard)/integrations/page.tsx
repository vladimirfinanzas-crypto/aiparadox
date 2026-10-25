import { redirect } from "next/navigation"

// Integrations used to be a top-level section. The page now lives inside
// Settings; this route stays so old links and bookmarks keep working. It is a
// plain redirect, so it cannot loop: the target never points back here.
export default function IntegrationsPage() {
  redirect("/settings/integrations")
}
