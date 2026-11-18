import { createIndexObserver, type PluginIndexSnapshot } from '@valley/plugin-sdk'
import { libraryRoots } from './data'

type IndexObserver = ReturnType<typeof createIndexObserver>
type IndexApi = Parameters<typeof createIndexObserver>[0]

export type FolderIndex = {
  getSnapshot(): PluginIndexSnapshot
  subscribe(listener: () => void): () => void
  setFolders(folders: readonly string[]): void
  dispose(): Promise<void>
}

const EMPTY: PluginIndexSnapshot = Object.freeze({ status: 'ready', version: null, entries: Object.freeze([]) })

/** The realm index limited to the library's own folders (Music and Podcasts), published as one snapshot. */
export function createFolderIndex(api: IndexApi, folders: readonly string[] = []): FolderIndex {
  let observed: { observer: IndexObserver; off: () => void }[] = []
  let roots: string | null = null
  let parts: readonly PluginIndexSnapshot[] = []
  let snapshot = EMPTY
  let disposed = false
  const retired: Promise<void>[] = []
  const listeners = new Set<() => void>()

  const compose = (): boolean => {
    const next = observed.map(({ observer }) => observer.getSnapshot())
    if (next.length === parts.length && next.every((part, index) => part === parts[index])) return false
    parts = next
    const failed = next.find(part => part.status === 'error')
    if (!next.length) snapshot = EMPTY
    else snapshot = {
      status: failed ? 'error' : next.some(part => part.status === 'loading') ? 'loading' : 'ready',
      version: next.length === 1 ? next[0].version : null,
      entries: next.length === 1 ? next[0].entries : next.flatMap(part => part.entries),
      ...(failed?.error ? { error: failed.error } : {})
    }
    return true
  }
  const notify = (): void => { if (!disposed && compose()) listeners.forEach(listener => listener()) }
  const release = (): void => {
    for (const { observer, off } of observed.splice(0)) { off(); retired.push(observer.dispose().catch(() => {})) }
  }

  const index: FolderIndex = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setFolders(next) {
      const key = libraryRoots(next).join('\n')
      if (disposed || key === roots) return
      roots = key
      release()
      observed = libraryRoots(next).map(pathPrefix => {
        const observer = createIndexObserver(api, { pathPrefix, fields: [] })
        return { observer, off: observer.subscribe(notify) }
      })
      notify()
    },
    async dispose() {
      disposed = true
      listeners.clear()
      release()
      await Promise.all(retired)
    }
  }
  index.setFolders(folders)
  return index
}
