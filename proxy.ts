import { clerkMiddleware } from "@clerk/nextjs/server"

// Every request on this matcher passes through Clerk. The middleware itself
// protects nothing (no route rules): it attaches the session to the request, and
// the layouts, server actions and route handlers decide what they accept.
//
// Three groups are deliberately OUTSIDE it, and each for its own reason:
//
//   /api/health   a liveness probe. It must answer even when Clerk is
//                 unreachable or its keys are missing — otherwise a monitoring
//                 outage looks like a dead server.
//   /api/desktop, /api/pc/jobs
//                 the Desktop Agent's own channel. The agent is a local process
//                 with no cookies: it proves itself with single-use pairing codes
//                 and a device token (lib/desktop-devices.ts), so it never calls
//                 `auth()` and must keep working while the web session provider
//                 is down.
//   /api/locale   a language cookie plus a redirect. It reads no session at all.
//
// Everything that does read a session (/api/live, /api/ai/health,
// /api/replays/[sessionId], every page and server action) stays on the matcher.
export default clerkMiddleware()

export const config = {
  matcher: [
    "/((?!_next|monitoring|api/health|api/desktop|api/pc/jobs|api/locale|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)((?!/(?:health|desktop|pc/jobs|locale)).*)",
  ],
}
