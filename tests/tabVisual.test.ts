import { describe, it, expect } from 'vitest'
import { isUiVisual } from '@valley/plugin-sdk'
import { tabVisual } from '../src/icons'

describe('Music tab visual', () => {
  it('supplies its own note and podcast icons with the playing state', () => {
    const music = tabVisual('music', true), podcast = tabVisual('podcast', false)
    for (const visual of [music, podcast]) expect(isUiVisual(visual)).toBe(true)
    expect(music).toMatchObject({ kind: 'icon', playing: true })
    expect(podcast).toMatchObject({ kind: 'icon', playing: false })
    expect(music.src).not.toBe(podcast.src)
    const svg = (visual: { src?: string }) => decodeURIComponent(visual.src!.slice('data:image/svg+xml,'.length))
    // Playing: the left note with the beam first, the right note fifth (half a beat later in the host's staggered motion).
    expect(svg(music).match(/<(path|g)\b/g)).toEqual(['<path', '<g', '<g', '<g', '<path'])
    expect(svg(tabVisual('music', false))).toMatch(/^<svg [^>]*viewBox="0 0 512 512" fill="currentColor"><path d="M406\.3 48\.2c-4\.7[^"]*z"\/><\/svg>$/)
    expect(decodeURIComponent(podcast.src!.slice('data:image/svg+xml,'.length))).toContain('<circle cx="12" cy="11" r="1"/>')
    expect(tabVisual('music', false)).not.toHaveProperty('name')
  })
})
