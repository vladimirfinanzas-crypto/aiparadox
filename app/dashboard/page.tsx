import { redirect } from "next/navigation"

// `/dashboard` was never a page of its own: the dashboard lives under the
// authenticated layout. Keep the URL working instead of showing a 404.
export default function DashboardPage() {
  redirect("/chats")
}
