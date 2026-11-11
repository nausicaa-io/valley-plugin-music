import { describe, it, expect } from 'vitest'
import { isUiVisual } from '@valley/plugin-sdk'
import { tabVisual } from '../src/icons'

describe('Music tab visual', () => {
  it('supplies its own headphones and podcast icons with the playing state', () => {
    const music = tabVisual('music', true), podcast = tabVisual('podcast', false)
    for (const visual of [music, podcast]) expect(isUiVisual(visual)).toBe(true)
    expect(music).toMatchObject({ kind: 'icon', playing: true })
    expect(podcast).toMatchObject({ kind: 'icon', playing: false })
    expect(music.src).not.toBe(podcast.src)
    expect(decodeURIComponent(music.src!.slice('data:image/svg+xml,'.length))).toContain('a9 9 0 0 1 18 0')
    expect(decodeURIComponent(podcast.src!.slice('data:image/svg+xml,'.length))).toContain('<circle cx="12" cy="11" r="1"/>')
    expect(tabVisual('music', false)).not.toHaveProperty('name')
  })
})
