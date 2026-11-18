/**
 * Runs `tick` at once and every `intervalMs` while shown: `doc` is visible and, when given, `element` is laid out on screen
 * (one IntersectionObserver). A player left mounted behind another sidebar tab or a collapsed sidebar ticks nothing (GODS G6).
 * Nothing stays armed while hidden; without IntersectionObserver only the document counts.
 */
export function visibleTimer(doc: Document, tick: () => void, intervalMs: number, element?: Element | null): () => void {
  const view = doc.defaultView ?? window
  let timer: number | undefined
  let onScreen = true
  const sync = (): void => {
    if (doc.hidden || !onScreen) { if (timer !== undefined) view.clearInterval(timer); timer = undefined }
    else if (timer === undefined) { tick(); timer = view.setInterval(tick, intervalMs) }
  }
  const Observer = (view as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
  const observer = element && Observer ? new Observer(entries => { const entry = entries[entries.length - 1]; if (entry) { onScreen = entry.isIntersecting; sync() } }) : undefined
  observer?.observe(element!)
  doc.addEventListener('visibilitychange', sync)
  sync()
  return () => { observer?.disconnect(); doc.removeEventListener('visibilitychange', sync); if (timer !== undefined) view.clearInterval(timer); timer = undefined }
}
