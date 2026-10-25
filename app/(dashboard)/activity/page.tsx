import { redirect } from "next/navigation"

// Activity moved into Settings. The old URL is kept as a redirect so links in
// notifications, docs and bookmarks still land on the same history.
export default function ActivityPage() {
  redirect("/settings/activity")
}
