import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { generatedCatalogs } from './generatedCatalogs'

function english(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  const fallback = (generatedCatalogs.en as Record<string, string>)[key] ?? key
  return fallback.replace(/\{\{([^}]+)\}\}/g, (_match: string, name: string) => String(params?.[name] ?? ''))
}

let translate: ValleyPluginApi['ui']['t'] = english

export function initLocalization(api: ValleyPluginApi): void {
  translate = (key, params) => {
    const value = api.ui.t(key, params)
    return value === key ? english(key, params) : value
  }
  api.ui.registerCatalogs(generatedCatalogs)
}

export function uiText(key: string, params?: Parameters<ValleyPluginApi['ui']['t']>[1]): string {
  return translate(key, params)
}

export type MusicCountUnit = 'song' | 'artist' | 'playlist' | 'play'

/** Localized presentation only; counts and stored music records remain unchanged. */
export function musicCount(count: number, unit: MusicCountUnit): string {
  return uiText(`music.count.${unit}.${count === 1 ? 'one' : 'other'}`, { count })
}
