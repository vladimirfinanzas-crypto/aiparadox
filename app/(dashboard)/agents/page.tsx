import { redirect } from "next/navigation"

// Agents are no longer a section of the product: Godfather delegates to its
// internal workers on its own. The catalogue and its rows are untouched — only
// the route moved, so old links land in the conversation instead of a 404.
export default function AgentsPage() {
  redirect("/chats")
}
