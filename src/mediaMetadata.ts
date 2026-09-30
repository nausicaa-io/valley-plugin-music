import type { ValleyPluginApi } from '@valley/plugin-sdk'

export class MetadataCancelled extends Error {
  constructor() { super('Music metadata owner changed.') }
}

interface Metadata {
  title: string | null
  artist: string | null
  album: string | null
  coverUrl: string | null
}

interface Entry {
  file: string
  generation: number
  promise: Promise<Metadata>
  resolve: (value: Metadata) => void
  reject: (reason: unknown) => void
  value?: Metadata
  bytes: number
  required: boolean
}

export const METADATA_LIMITS = { active: 4, queued: 64, retained: 96, bytes: 24 * 1024 * 1024, coverBytes: 4 * 1024 * 1024 } as const

export class MediaMetadata {
  private entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private listeners = new Map<string, Set<() => void>>()
  private priorityFiles = new Map<string, number>()
  private waiting = new Set<string>()
  private active = 0
  private pumping = false
  private retainedBytes = 0
  private revision = 0
  private disposed = false

  constructor(private api: ValleyPluginApi) {}

  generation(): number { return this.revision }

  assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.revision) throw new MetadataCancelled()
  }

  private remove(entry: Entry): void {
    if (this.entries.get(entry.file) === entry) this.entries.delete(entry.file)
    if (entry.value?.coverUrl) URL.revokeObjectURL(entry.value.coverUrl)
    entry.value = undefined
    this.retainedBytes -= entry.bytes
    entry.bytes = 0
  }

  private room(bytes: number): boolean {
    const retained = (): number => [...this.entries.values()].filter((entry) => entry.value).length
    for (const entry of this.entries.values()) {
      if (retained() < METADATA_LIMITS.retained && this.retainedBytes + bytes <= METADATA_LIMITS.bytes) break
      if (entry.value && !this.listeners.has(entry.file)) this.remove(entry)
    }
    return retained() < METADATA_LIMITS.retained && this.retainedBytes + bytes <= METADATA_LIMITS.bytes
  }

  read(file: string, priority = false): Promise<Metadata> {
    return this.request(file, priority, true)
  }

  private request(file: string, priority: boolean, required: boolean): Promise<Metadata> {
    if (this.disposed) return Promise.reject(new MetadataCancelled())
    const existing = this.entries.get(file)
    if (existing) {
      this.waiting.delete(file)
      existing.required ||= required
      const position = priority ? this.queue.indexOf(existing) : -1
      if (position > 0) { this.queue.splice(position, 1); this.queue.unshift(existing) }
      this.entries.delete(file)
      this.entries.set(file, existing)
      return existing.promise
    }
    if (this.queue.length >= METADATA_LIMITS.queued - (priority ? 0 : 1)) return Promise.reject(new Error('Music metadata queue is full.'))
    this.waiting.delete(file)
    let resolve!: Entry['resolve']
    let reject!: Entry['reject']
    const promise = new Promise<Metadata>((accept, fail) => { resolve = accept; reject = fail })
    const entry: Entry = { file, generation: this.revision, promise, resolve, reject, bytes: 0, required }
    this.entries.set(file, entry)
    if (priority) this.queue.unshift(entry)
    else this.queue.push(entry)
    this.pump()
    return promise
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.disposed && this.active < METADATA_LIMITS.active) {
        if (!this.queue.length) this.admitWaiting()
        const entry = this.queue.shift()
        if (!entry) break
        this.active++
        void this.load(entry).finally(() => { this.active--; this.pump() })
      }
      this.admitWaiting()
    } finally { this.pumping = false }
  }

  private demand(file: string, priority: boolean): void {
    if (this.disposed || !this.listeners.has(file)) return
    if (!this.entries.has(file) && this.queue.length >= METADATA_LIMITS.queued - (priority ? 0 : 1)) {
      this.waiting.add(file)
      return
    }
    void this.request(file, priority, false).catch(() => {})
  }

  private admitWaiting(): void {
    if (this.disposed) return
    const files = [...this.waiting].sort((left, right) => Number(this.priorityFiles.has(right)) - Number(this.priorityFiles.has(left)))
    for (const file of files) this.demand(file, this.priorityFiles.has(file))
  }

  private notify(file: string, generation: number): void {
    for (const listener of [...this.listeners.get(file) ?? []]) {
      if (this.disposed || generation !== this.revision) return
      if (!this.listeners.get(file)?.has(listener)) continue
      try { listener() } catch (error) { console.error('[music] cover subscriber failed', error) }
    }
  }

  private async load(entry: Entry): Promise<void> {
    try {
      this.assertCurrent(entry.generation)
      const result = await this.api.drivers.media.readMetadata(entry.file)
      this.assertCurrent(entry.generation)
      if (!result.ok) throw new Error(result.error || 'Music metadata is unavailable.')
      const metadata = result.data
      const value: Metadata = { title: metadata?.title ?? null, artist: metadata?.artist ?? null, album: metadata?.album ?? null, coverUrl: null }
      const textBytes = 2 * ((value.title?.length ?? 0) + (value.artist?.length ?? 0) + (value.album?.length ?? 0))
      const cover = metadata?.cover
      const coverBytes = cover && cover.data.byteLength <= METADATA_LIMITS.coverBytes ? cover.data.byteLength : 0
      const retain = this.room(textBytes)
      if (retain && coverBytes && this.room(textBytes + coverBytes)) {
        const bytes = new Uint8Array(cover!.data.byteLength)
        bytes.set(cover!.data)
        value.coverUrl = URL.createObjectURL(new Blob([bytes], { type: cover!.mime }))
      }
      this.assertCurrent(entry.generation)
      if (retain) {
        entry.bytes = textBytes + (value.coverUrl ? coverBytes : 0)
        this.retainedBytes += entry.bytes
        entry.value = value
      } else this.entries.delete(entry.file)
      entry.resolve(value)
      this.notify(entry.file, entry.generation)
    } catch (error) {
      this.remove(entry)
      entry.reject(error)
    }
  }

  cover(file: string): string | null {
    return this.entries.get(file)?.value?.coverUrl ?? null
  }

  acquire(file: string, listener: () => void, priority = false): () => void {
    if (this.disposed) return () => {}
    let listeners = this.listeners.get(file)
    if (!listeners) {
      if (this.listeners.size >= METADATA_LIMITS.retained - (priority ? 0 : 1)) return () => {}
      listeners = new Set()
      this.listeners.set(file, listeners)
    }
    const subscription = (): void => listener()
    listeners.add(subscription)
    if (priority) this.priorityFiles.set(file, (this.priorityFiles.get(file) ?? 0) + 1)
    this.demand(file, priority)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (priority) {
        const count = (this.priorityFiles.get(file) ?? 1) - 1
        if (count) this.priorityFiles.set(file, count)
        else this.priorityFiles.delete(file)
      }
      listeners.delete(subscription)
      if (!listeners.size) {
        this.listeners.delete(file)
        this.waiting.delete(file)
        const entry = this.entries.get(file)
        const position = entry && !entry.required ? this.queue.indexOf(entry) : -1
        if (entry && position >= 0) {
          this.queue.splice(position, 1)
          this.remove(entry)
          entry.reject(new MetadataCancelled())
          this.pump()
        }
      }
    }
  }

  retain(files: ReadonlySet<string>): void {
    for (const entry of this.entries.values()) {
      if (entry.value && !files.has(entry.file) && !this.listeners.has(entry.file)) this.remove(entry)
    }
  }

  invalidate(): void {
    if (this.disposed) return
    this.revision++
    for (const entry of this.queue) entry.reject(new MetadataCancelled())
    this.queue = []
    this.waiting.clear()
    for (const entry of this.entries.values()) this.remove(entry)
    const generation = this.revision
    for (const file of [...this.listeners.keys()]) {
      this.notify(file, generation)
      if (this.disposed || generation !== this.revision) break
      this.demand(file, this.priorityFiles.has(file))
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.revision++
    for (const entry of this.queue) entry.reject(new MetadataCancelled())
    this.queue = []
    this.waiting.clear()
    this.listeners.clear()
    this.priorityFiles.clear()
    for (const entry of this.entries.values()) this.remove(entry)
  }
}
