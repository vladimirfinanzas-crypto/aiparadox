// Settings reads the account, the devices and the activity from different
// sources, so the section paints immediately with a shape close to the final
// one instead of blank space. It sits under the shared header and tabs, which
// the layout already rendered.
export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
      <span className="sr-only">Cargando Settings…</span>

      <div className="h-28 animate-pulse rounded-2xl border border-border/40 bg-card/40" />

      <div className="grid gap-5 md:grid-cols-2">
        <div className="h-44 animate-pulse rounded-2xl border border-border/40 bg-card/40" />
        <div className="h-44 animate-pulse rounded-2xl border border-border/40 bg-card/40" />
      </div>

      <div className="h-64 animate-pulse rounded-2xl border border-border/40 bg-card/40" />
    </div>
  )
}
