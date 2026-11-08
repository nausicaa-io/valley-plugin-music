import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi, loadPackageWasm } from '@valley/plugin-testkit'
import type { PluginIndexEntry } from '@valley/plugin-sdk'
import { IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS, fileExtension } from '@valley/plugin-sdk/fileTypes'
import { installCreditsKernel, libraryCredits, normalizeArtistName, trackArtists, tracksForArtist, upsertArtists } from '../src/artists'
import { loadCreditsKernel, type CreditsKernel } from '../src/credits'
import { computeLibrarySync, mostListened, rawTitleFromFileName, resolveCoverPath, searchTracks, trackDetailsFromFileName } from '../src/data'
import { podcastShows } from '../src/podcasts'
import type { Artist, Track } from '../src/types'

let kernel: CreditsKernel

beforeAll(async () => {
  const module = await loadPackageWasm(process.cwd(), 'credits')
  kernel = await loadCreditsKernel(createMockValleyApi({ manifest: { id: 'music' }, wasm: { modules: [module] } }).api)
})

afterEach(() => installCreditsKernel(null))

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000 }
}

const SPACES = [' ', '  ', '\t', ' ', ' ', '　', '﻿', ' ', '\n', '\u0085', '᠎', '​']
const PIECES = [
  'Nova', 'nova', 'NOVA', 'Atlas Grey', 'Mira', 'Charli XCX', 'Maxwell', 'featured', 'X', 'x', 'feat.', 'FEAT', 'Ft.', 'ft', 'featuring', 'Featuring',
  'vs', 'VS.', 'vs.', ',', ';', '&', '×', 'feat.b', 'İstanbul', 'ΣΑΣ', 'ΌΣΟΣ', 'straße', 'STRASSE', 'ı', 'K', 'ǅ', 'Ǆemo', '😀', 'é', 'Ω',
  'Ⅻ', 'ﬃ', 'ŉ', '', '·', 'a.b', 'A$AP', 'AC/DC', 'Earth, Wind', 'Simon & Garfunkel'
]

function randomName(r: () => number): string {
  let out = ''
  const parts = 1 + Math.floor(r() * 6)
  for (let i = 0; i < parts; i++) {
    out += PIECES[Math.floor(r() * PIECES.length)]
    if (r() < 0.8) out += SPACES[Math.floor(r() * (r() < 0.7 ? 1 : SPACES.length))]
  }
  return r() < 0.2 ? `${SPACES[Math.floor(r() * SPACES.length)]}${out}` : out
}

function randomTracks(count: number, seed: number): Track[] {
  const r = rng(seed)
  return Array.from({ length: count }, (_, index) => ({
    id: `song_${index}`,
    title: `Song ${index}`,
    artist: randomName(r),
    file: `Music/${index}.mp3`,
    ...(r() < 0.15 ? { artists: Array.from({ length: Math.floor(r() * 4) }, () => randomName(r)) } : {}),
    ...(r() < 0.25 ? { details: { feat: randomName(r) } } : {})
  }))
}

const script = (tracks: Track[]) => {
  const names = tracks.map(trackArtists)
  return { names, keys: names.map((list) => list.map(normalizeArtistName)) }
}

const EDGE: Partial<Track>[] = [
  { artist: '' }, { artist: '   ' }, { artist: 'Nova' }, { artist: ' x b' }, { artist: 'a x , b' }, { artist: 'a feat.b' }, { artist: 'a feat. b' },
  { artist: 'a  FEATURING  b' }, { artist: 'a & b' }, { artist: 'a\u0085feat\u0085b' }, { artist: 'a ×b×c' }, { artist: 'Nova, nova, NOVA' },
  { artist: 'ΣΑΣ & ΌΣΟΣ feat. İstanbul' }, { artist: 'Charli XCX x Maxwell' }, { artist: 'a vs.  b vs c' }, { artist: 'feat. a' }, { artist: 'a feat.' },
  { artist: '😀 & 😀' }, { artist: 'x', artists: [] }, { artist: 'ignored', artists: [' Nova ', 'nova', '', 'Atlas & Grey'] },
  { artist: 'Nova', details: { feat: 'Mira ft. Atlas' } }, { artist: 'Nova', details: { feat: ' , ' } }, { artist: 'a , b' }, { artist: 'a﻿;b' }
]

describe('credits kernel parity with trackArtists', () => {
  it('matches the TypeScript split, trim, normalization and de-duplication on edge cases', () => {
    const tracks = EDGE.map((fields, index) => ({ id: `e${index}`, title: 't', file: 'f', artist: '', ...fields }) as Track)
    expect(kernel(tracks)).toEqual(script(tracks))
  })

  it.each([1, 2, 3, 4, 5])('matches on a randomized 2,000-track library (seed %i)', (seed) => {
    const tracks = randomTracks(2000, seed)
    expect(kernel(tracks)).toEqual(script(tracks))
  })

  it('answers an empty library', () => {
    expect(kernel([])).toEqual({ names: [], keys: [] })
  })

  it('hands back to TypeScript for input it cannot encode faithfully', () => {
    const base = { id: 'a', title: 't', file: 'f' }
    expect(kernel([{ ...base, artist: 'Nova\x01Mira' }])).toBeNull()
    expect(kernel([{ ...base, artist: 'Nova\x00' }])).toBeNull()
    expect(kernel([{ ...base, artist: 'x', artists: ['a\x02b'] }])).toBeNull()
    expect(kernel([{ ...base, artist: 'Nova\ud800' }])).toBeNull()
    expect(kernel([{ ...base, artist: 42 as unknown as string }])).toBeNull()
  })

  it('libraryCredits uses the installed kernel once per library array and falls back to TypeScript', () => {
    const tracks = randomTracks(300, 9)
    const spy = vi.fn(kernel)
    installCreditsKernel(spy)
    expect(libraryCredits(tracks)).toEqual(script(tracks))
    libraryCredits(tracks)
    expect(spy).toHaveBeenCalledTimes(1)
    const malformed = [{ id: 'm', title: 't', file: 'f', artist: 'a\x01b' }]
    expect(libraryCredits(malformed)).toEqual(script(malformed))
  })
})

// The implementations these paths replaced, frozen to prove the indexed versions return identical results.
const reference = {
  tracksForArtist(tracks: Track[], artist: Pick<Artist, 'name' | 'aliases'>): Track[] {
    const keys = new Set([artist.name, ...(artist.aliases ?? [])].map(normalizeArtistName).filter(Boolean))
    return tracks.filter((t) => trackArtists(t).some((n) => keys.has(normalizeArtistName(n))))
  },
  upsertArtists(registry: Artist[], tracks: Track[], makeId: () => string) {
    const covered = new Set<string>()
    for (const a of registry) for (const k of [a.name, ...(a.aliases ?? [])].map(normalizeArtistName).filter(Boolean)) covered.add(k)
    const added: Artist[] = []
    for (const track of tracks) for (const name of trackArtists(track)) {
      const key = normalizeArtistName(name)
      if (!key || covered.has(key)) continue
      covered.add(key)
      added.push({ id: makeId(), name: name.trim() })
    }
    return { next: added.length ? [...registry, ...added] : registry, added }
  },
  computeLibrarySync(tracks: Track[], folderFiles: string[], allEntries: readonly PluginIndexEntry[]) {
    const media = new Set<string>([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS])
    const base = (p: string) => p.split('/').pop() ?? p
    const known = new Set(tracks.map((t) => t.file)), present = new Set(folderFiles), realmPaths = new Set(allEntries.map(e => e.relPath))
    const toAdd = folderFiles.filter((f) => !known.has(f))
    const byBase = new Map<string, string[]>()
    for (const entry of allEntries) {
      if (!media.has(fileExtension(entry.relPath))) continue
      const key = base(entry.relPath).toLowerCase()
      byBase.set(key, [...(byBase.get(key) ?? []), entry.relPath])
    }
    const toHeal: { track: Track; newPath: string }[] = [], missing = new Set<string>(), claimed = new Set([...known, ...toAdd])
    for (const track of tracks) {
      if (present.has(track.file) || realmPaths.has(track.file)) continue
      const candidates = (byBase.get(base(track.file).toLowerCase()) ?? []).filter((p) => !claimed.has(p) || toAdd.includes(p))
      if (candidates.length === 1) {
        toHeal.push({ track, newPath: candidates[0] })
        claimed.add(candidates[0])
        const addIdx = toAdd.indexOf(candidates[0])
        if (addIdx !== -1) toAdd.splice(addIdx, 1)
      } else missing.add(track.id)
    }
    return { toAdd, toHeal, missing }
  },
  resolveCoverPath(entries: readonly PluginIndexEntry[], cover: string | undefined): string | null {
    if (!cover) return null
    const base = (p: string) => p.split('/').pop() ?? p
    const exact = entries.find((e) => e.relPath === cover)
    if (exact) return exact.relPath
    if (cover.includes('/')) return cover
    return entries.find((e) => base(e.relPath).toLowerCase() === base(cover).toLowerCase())?.relPath ?? null
  },
  showCover(folder: string, entries: readonly PluginIndexEntry[]): string | null {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    const images = entries.map(e => e.relPath)
      .filter(p => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/') && (IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(p)))
      .sort(collator.compare)
    return images.find(p => ['cover', 'folder', 'artwork', 'poster', 'show', 'podcast'].includes(rawTitleFromFileName(p).toLowerCase())) ?? images[0] ?? null
  }
}

const entry = (relPath: string) => ({ relPath }) as PluginIndexEntry

describe('indexed library paths match the implementations they replaced', () => {
  it('tracksForArtist and upsertArtists, with and without the kernel', () => {
    const tracks = randomTracks(1500, 21)
    const registry: Artist[] = [{ id: 'a1', name: 'Nova', aliases: ['NOVA ', 'Atlas Grey'] }, { id: 'a2', name: 'ΣΑΣ' }, { id: 'a3', name: 'x' }]
    for (const k of [null, kernel]) {
      installCreditsKernel(k)
      const copy = [...tracks]
      for (const artist of [...registry, { name: 'Mira', aliases: ['nova', 'mira'] }, { name: ' ' }]) expect(tracksForArtist(copy, artist)).toEqual(reference.tracksForArtist(copy, artist))
      let a = 0, b = 0
      expect(upsertArtists(registry, copy, () => `id${a++}`)).toEqual(reference.upsertArtists(registry, copy, () => `id${b++}`))
    }
  })

  it('computeLibrarySync on steady, moved, renamed, duplicated and ambiguous libraries', () => {
    const r = rng(5)
    const files = Array.from({ length: 400 }, (_, i) => `Music/${i % 7}/song ${i % 300}.${['mp3', 'MP4', 'flac', 'md'][i % 4]}`)
    const entries = [...files, 'Elsewhere/song 3.mp3', 'Elsewhere/song 3.MP3', 'Other/song 5.mp3', 'Notes/a.md'].map(entry)
    const folderFiles = files.filter(f => !f.endsWith('.md'))
    const base: Track[] = folderFiles.map((file, i) => ({ id: `t${i}`, title: 't', artist: '', file }))
    const cases: [Track[], string[]][] = [
      [base, folderFiles],
      [base.map((t, i) => (i % 9 === 0 ? { ...t, file: t.file.replace('Music/', 'Music/old/') } : t)), folderFiles],
      [base.map(t => ({ ...t, file: `Old/${t.file}` })), folderFiles],
      [base.map(t => ({ ...t, file: `Old/${t.file}` })), [...folderFiles, ...folderFiles.slice(0, 40)]],
      [[...base, { id: 'x1', title: 't', artist: '', file: 'Gone/song 3.mp3' }, { id: 'x2', title: 't', artist: '', file: 'Gone/song 5.mp3' }, { id: 'x3', title: 't', artist: '', file: 'Gone/never.mp3' }], folderFiles],
      [base.filter(() => r() < 0.5).map(t => (r() < 0.3 ? { ...t, file: `Old/${t.file}` } : t)), folderFiles.filter(() => r() < 0.9)]
    ]
    for (const [tracks, folder] of cases) expect(computeLibrarySync(tracks, folder, entries)).toEqual(reference.computeLibrarySync(tracks, folder, entries))
  })

  it('resolveCoverPath by exact path, explicit path and first basename match', () => {
    const entries = ['Covers/Sun.JPG', 'Art/sun.jpg', 'Art/moon.png', 'Notes/sun.jpg.md', 'trailing/', 'root.png'].map(entry)
    for (const cover of [undefined, '', 'Covers/Sun.JPG', 'sun.jpg', 'SUN.JPG', 'moon.png', 'Missing/moon.png', 'nothing.png', 'root.png', '']) {
      expect(resolveCoverPath(entries, cover)).toBe(reference.resolveCoverPath(entries, cover))
    }
  })

  it('podcastShows picks the same show covers', () => {
    const entries = [
      'Podcasts/alpha/cover.jpg', 'Podcasts/alpha/b.png', 'Podcasts/alpha/sub/cover.jpg', 'Podcasts/beta/z.webp', 'Podcasts/beta/Artwork.PNG',
      'Podcasts/gamma/notes.md', 'Podcasts/loose.jpg', 'Podcasts/alpha-extra/cover.jpg', 'Other/cover.jpg'
    ].map(entry)
    const episodes: Track[] = ['Podcasts/alpha/01 one.mp3', 'Podcasts/alpha/02 two.mp3', 'Podcasts/beta/b.mkv', 'Podcasts/gamma/g.mp4', 'Podcasts/root.mp3']
      .map((file, i) => ({ id: `e${i}`, title: trackDetailsFromFileName(file).title, artist: '', file }))
    const shows = podcastShows(episodes, 'Podcasts', entries)
    expect(shows.map(show => show.coverPath)).toEqual(shows.map(show => reference.showCover(show.id, entries)))
    expect(shows.find(show => show.id === 'Podcasts/alpha')?.coverPath).toBe('Podcasts/alpha/cover.jpg')
  })

  it('searchTracks matches the per-keystroke lowercase filters', () => {
    const tracks = randomTracks(800, 33).map((t, i) => ({ ...t, title: i % 3 ? `İ River ${i}` : `ΣΑΣ ${i}`, file: `Music/Ri/ver ${i}.MP3` }))
    for (const q of ['', 'river', 'i̇', 'σας', 'nova', 'feat', 'ver 1', 'mp3', 'zzz']) {
      expect(searchTracks(tracks, q, true)).toEqual(tracks.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || (t.file.split('/').pop() ?? '').toLowerCase().includes(q)))
      expect(searchTracks(tracks, q, false)).toEqual(tracks.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)))
    }
  })

  it('mostListened keeps the first entries of the stable full sort', () => {
    const r = rng(77)
    const tracks = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, title: ['Nova', 'nova', 'Árbol', 'arbol', `Song ${i % 40}`][i % 5], artist: '', file: `f${i}` }))
    const byId = new Map(tracks.map(t => [t.id, t]))
    const history = Array.from({ length: 2000 }, () => ({ songId: r() < 0.05 ? 'gone' : tracks[Math.floor(r() * r() * tracks.length)].id, playedAt: '' }))
    const full = (limit: number) => {
      const counts = new Map<string, number>()
      for (const h of history) counts.set(h.songId, (counts.get(h.songId) ?? 0) + 1)
      const ranked = [...counts].flatMap(([id, plays]) => (byId.has(id) ? [{ track: byId.get(id)!, plays }] : []))
      return ranked.sort((a, b) => b.plays - a.plays || a.track.title.localeCompare(b.track.title)).slice(0, limit)
    }
    for (const limit of [0, 1, 12, 50, 400]) expect(mostListened(history, byId, limit)).toEqual(full(limit))
  })
})
