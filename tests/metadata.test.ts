import { describe, it, expect } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import { initLocalization, musicCount, uiText } from '../src/localization'
import { generatedCatalogs } from '../src/generatedCatalogs'
import { musicFacts } from '../src/metadata'
import type { MusicSnapshot } from '../src/store'

function snapshot(overrides: Partial<MusicSnapshot> = {}): MusicSnapshot {
  return {
    musicPath: 'Lifestyle/music',
    tracks: [],
    artists: [],
    playlists: [],
    missing: new Set<string>(),
    ...overrides
  } as unknown as MusicSnapshot
}

function value(facts: ReturnType<typeof musicFacts>, id: string): string | undefined {
  return facts.find((fact) => fact.id === id)?.value
}

describe('musicFacts', () => {
  it('reports the folder it scanned', () => {
    expect(value(musicFacts(snapshot()), 'music.library')).toBe('Lifestyle/music')
  })

  it('counts what the library holds', () => {
    const facts = musicFacts(
      snapshot({
        tracks: [{}, {}, {}] as MusicSnapshot['tracks'],
        artists: [{}] as MusicSnapshot['artists'],
        playlists: [{}, {}] as MusicSnapshot['playlists']
      })
    )
    expect(value(facts, 'music.contents')).toBe('3 songs · 1 artist · 2 playlists')
  })

  it('mentions missing files only when there are some', () => {
    expect(value(musicFacts(snapshot()), 'music.missing')).toBeUndefined()
    expect(value(musicFacts(snapshot({ missing: new Set(['a', 'b']) })), 'music.missing')).toBe('2')
  })

  it('lists the media extensions it treats as songs', () => {
    const formats = value(musicFacts(snapshot()), 'music.formats') ?? ''
    expect(formats).toContain('.mp3')
    expect(formats).toContain('.mp4')
  })

  it('gives every fact a stable namespaced id and an English fallback', () => {
    const facts = musicFacts(snapshot({ missing: new Set(['a']) }))
    for (const fact of facts) {
      expect(fact.id.startsWith('music.')).toBe(true)
      expect(fact.label).not.toBe('')
      expect(fact.labelKey).not.toBe('')
    }
    expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length)
  })
})

describe('Music localization', () => {
  it('uses plugin translations first and preserves English interpolation fallbacks', () => {
    const { api } = createMockValleyApi({ manifest: { id: 'music' } })
    api.ui.t = (key) => key === 'auto.131260cbfbb0' ? '音乐' : key
    initLocalization(api)

    expect(uiText('auto.131260cbfbb0')).toBe('音乐')
    expect(uiText('auto.1705de749234')).toBe(' media  found in this folder.')
    expect(uiText('music.missing')).toBe('music.missing')
  })

  it('localizes visible counts while leaving stored music values unchanged', () => {
    const { api } = createMockValleyApi({ manifest: { id: 'music' } })
    api.ui.t = (key, params) => {
      const template = (generatedCatalogs['zh-CN'] as Record<string, string>)[key] ?? key
      return template.replace(/\{\{([^}]+)\}\}/g, (_match, name) => String(params?.[name] ?? ''))
    }
    initLocalization(api)

    expect(musicCount(14, 'song')).toBe('14 首歌')
    expect(value(musicFacts(snapshot({
      tracks: [{}, {}, {}] as MusicSnapshot['tracks'],
      artists: [{}] as MusicSnapshot['artists'],
      playlists: [{}, {}] as MusicSnapshot['playlists']
    })), 'music.contents')).toBe('3 首歌 · 1 位艺术家 · 2 个播放列表')
    expect(snapshot().musicPath).toBe('Lifestyle/music')
  })
})
