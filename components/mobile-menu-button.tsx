"use client"

// The marketing header is a Server Component (it awaits the dictionary from
// cookies), so the interactive hamburger lives here as a Client Component —
// event handlers cannot be serialized across the Server/Client boundary.
export function MobileMenuButton() {
  return (
    <button
      className="md:hidden flex items-center gap-2 rounded-sm p-2 hover:bg-primary hover:text-primary-foreground"
      onClick={() => {
        window.location.hash = "#chat"
      }}
      aria-label="Menu"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="size-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
      <span className="sr-only">Menu</span>
    </button>
  )
}
