import { act, cleanup, render, screen } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import MUSIC_PLUGIN_CONFIG from '../config.json'
import { register } from '../src/index'

afterEach(() => { cleanup() })

const unavailable = () => new Error('Plugin backend is unavailable')

describe('Music views while the backend is unavailable', () => {
  it.each([
    ['rejects its calls', false],
    ['refuses calls and events synchronously', true]
  ])('renders every view with a playback notice when the backend %s', async (_name, synchronous) => {
    const mock = createMockValleyApi({ manifest: { id: 'music', indexState: MUSIC_PLUGIN_CONFIG.indexState as 'scoped', datasets: MUSIC_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] }, settings: { musicPath: 'Music' } })
    mock.api.backend.call = vi.fn(synchronous ? () => { throw unavailable() } : async () => { throw unavailable() }) as typeof mock.api.backend.call
    if (synchronous) mock.api.backend.on = vi.fn(() => { throw unavailable() }) as typeof mock.api.backend.on
    const off = register(mock.api)
    const views = (mock.api.registerView as unknown as { mock: { calls: [string, React.ComponentType<Record<string, unknown>>][] } }).mock.calls
    expect(views.map(([id]) => id)).toEqual(['music.panel', 'music.player', 'music.page', 'music.settings', 'music.nowPlaying'])
    for (const [, View] of views) {
      await act(async () => { render(React.createElement(View, { navigation: { setController: vi.fn() } })) })
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(screen.getAllByText('Music playback is unavailable: Plugin backend is unavailable').length).toBeGreaterThan(0)
    await off()
  })
})
