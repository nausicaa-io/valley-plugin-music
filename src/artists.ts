import type { CreditsKernel, LibraryCredits } from './credits'
import type { Artist, Track } from './types'

/**
 * Pure artist helpers. Artist identity is a song's artist **name**: the `artist`
 * string is auto-split into individual names, and the artist datasets are
 * upserted from those names so links/commands can resolve a name → a stable
 * entity id (carrying image/bio/aliases). Membership stays derived — the song
 * string is the source of truth, never a denormalized id list on the track.
 */

// Split on hard separators (comma/semicolon/&/×) with optional surrounding
// space, or on collab words (feat./ft./featuring/vs./x) that must be flanked by
// whitespace — so "Maxwell", "featured", "Charli XCX" stay intact.
const ARTIST_SPLIT_RE = /\s*[,;&×]\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?|x)\s+/i

/** Trim + collapse internal whitespace + lowercase — the artist match key. */
export function normalizeArtistName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function sameArtist(left: Artist | null, right: Artist | null): boolean {
  const stable = (artist: Artist | null) => artist && { id: artist.id, name: artist.name, image: artist.image ?? null, bio: artist.bio ?? null, aliases: [...(artist.aliases ?? [])].sort() }
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

export function patchArtistMetadata(artist: Artist, values: { name?: string; image?: string | null; bio?: string | null }): Artist {
  const next = { ...artist }
  if (values.name !== undefined) {
    const name = values.name.trim()
    if (!name) throw new Error('Artist name cannot be empty')
    if (normalizeArtistName(artist.name) !== normalizeArtistName(name) && !(artist.aliases ?? []).some(alias => normalizeArtistName(alias) === normalizeArtistName(artist.name))) next.aliases = [...(artist.aliases ?? []), artist.name]
    next.name = name
  }
  if (values.image !== undefined) { if (values.image) next.image = values.image; else delete next.image }
  if (values.bio !== undefined) { if (values.bio?.trim()) next.bio = values.bio.trim(); else delete next.bio }
  return next
}

export function mergeArtistMetadata(source: Artist, target: Artist): Artist {
  const aliases = [...(target.aliases ?? [])]
  for (const name of [source.name, ...(source.aliases ?? [])]) {
    const norm = normalizeArtistName(name)
    if (norm && norm !== normalizeArtistName(target.name) && !aliases.some(alias => normalizeArtistName(alias) === norm)) aliases.push(name)
  }
  return { ...target, aliases, ...(!target.bio && source.bio ? { bio: source.bio } : {}), ...(!target.image && source.image ? { image: source.image } : {}) }
}

/** De-duplicate names case-insensitively, preserving first-seen casing/order. */
function dedupeNames(names: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const key = normalizeArtistName(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * The individual artist names for a track: an explicit `artists[]` wins, else the
 * `artist` string is split on common delimiters. Trimmed, de-duplicated, ordered.
 */
export function trackArtists(track: Pick<Track, 'artist' | 'artists' | 'details'>): string[] {
  const featured = (track.details?.feat ?? '').split(ARTIST_SPLIT_RE)
  if (track.artists && track.artists.length) return dedupeNames([...track.artists, ...featured])
  const raw = (track.artist ?? '').trim()
  return dedupeNames([...raw.split(ARTIST_SPLIT_RE), ...featured])
}

export function trackCredits(track: Pick<Track, 'artist' | 'artists' | 'title' | 'details'>): { artists: string[]; feat: string[] } {
  const parts = track.artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)
  const titleFeature = track.title.match(/\b(?:feat\.?|ft\.?|featuring)\s+([^\])]+)/i)?.[1] ?? ''
  const feat = dedupeNames([...parts.slice(1), titleFeature, track.details?.feat ?? ''].flatMap((part) => part.split(ARTIST_SPLIT_RE)))
  const featured = new Set(feat.map(normalizeArtistName))
  const artists = trackArtists({ artist: parts[0], artists: track.artists }).filter((name) => !featured.has(normalizeArtistName(name)))
  return { artists, feat }
}

/** The set of normalized names an artist answers to (its name + aliases). */
function artistKeys(artist: Pick<Artist, 'name' | 'aliases'>): Set<string> {
  const keys = new Set<string>()
  const add = (n: string): void => {
    const k = normalizeArtistName(n)
    if (k) keys.add(k)
  }
  add(artist.name)
  for (const alias of artist.aliases ?? []) add(alias)
  return keys
}

/** Find an artist by id, then by normalized name, then by alias. */
export function resolveArtist(registry: Artist[], nameOrId: string): Artist | null {
  const key = nameOrId.trim()
  if (!key) return null
  const byId = registry.find((a) => a.id === key)
  if (byId) return byId
  const norm = normalizeArtistName(key)
  return registry.find((a) => artistKeys(a).has(norm)) ?? null
}

type CachedCredits = LibraryCredits & { byKey?: Map<string, number[]> }
const creditsCache = new WeakMap<readonly Track[], CachedCredits>()
let creditsKernel: CreditsKernel | null = null

/** Routes `libraryCredits` through the WebAssembly kernel; null restores the TypeScript path. */
export function installCreditsKernel(kernel: CreditsKernel | null): void {
  creditsKernel = kernel
}

function scriptCredits(tracks: readonly Track[]): LibraryCredits {
  const names = tracks.map(trackArtists)
  return { names, keys: names.map((list) => list.map(normalizeArtistName)) }
}

/**
 * Every track's `trackArtists` names and their normalized keys, computed once per
 * library array (the store replaces its arrays, never mutates them).
 */
export function libraryCredits(tracks: readonly Track[]): LibraryCredits {
  let credits = creditsCache.get(tracks)
  if (!credits) {
    let computed: LibraryCredits | null = null
    try {
      computed = creditsKernel?.(tracks) ?? null
    } catch (error) {
      creditsKernel = null
      console.warn('Music credits kernel failed; using TypeScript', error)
    }
    credits = computed ?? scriptCredits(tracks)
    creditsCache.set(tracks, credits)
  }
  return credits
}

function tracksByKey(tracks: readonly Track[]): Map<string, number[]> {
  const credits: CachedCredits = libraryCredits(tracks)
  if (!credits.byKey) {
    const byKey = new Map<string, number[]>()
    credits.keys.forEach((keys, index) => {
      for (const key of keys) {
        const list = byKey.get(key)
        if (list) list.push(index)
        else byKey.set(key, [index])
      }
    })
    credits.byKey = byKey
  }
  return credits.byKey
}

/** Songs that credit an artist (by its name or any alias), in library order. */
export function tracksForArtist(tracks: Track[], artist: Pick<Artist, 'name' | 'aliases'>): Track[] {
  const byKey = tracksByKey(tracks)
  const keys = [...artistKeys(artist)]
  if (keys.length === 1) return (byKey.get(keys[0]) ?? []).map((index) => tracks[index])
  const indexes = new Set(keys.flatMap((key) => byKey.get(key) ?? []))
  return [...indexes].sort((a, b) => a - b).map((index) => tracks[index])
}

/** Stable-but-unique id for a newly registered artist. */
export function newArtistId(): string {
  return `artist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Ensure the registry has an entity for every unique artist name across the
 * library, leaving existing entities (and their image/bio/aliases) untouched.
 * Pure: returns the next registry and just the newly-created entities to persist.
 * `makeId` is injectable for deterministic tests.
 */
export function upsertArtists(
  registry: Artist[],
  tracks: Track[],
  makeId: () => string = newArtistId
): { next: Artist[]; added: Artist[] } {
  const covered = new Set<string>()
  for (const a of registry) for (const k of artistKeys(a)) covered.add(k)

  const added: Artist[] = []
  const credits = libraryCredits(tracks)
  for (let index = 0; index < tracks.length; index++) {
    const keys = credits.keys[index]
    for (const [position, name] of credits.names[index].entries()) {
      const key = keys[position]
      if (!key || covered.has(key)) continue
      covered.add(key)
      added.push({ id: makeId(), name: name.trim() })
    }
  }
  return { next: added.length ? [...registry, ...added] : registry, added }
}
