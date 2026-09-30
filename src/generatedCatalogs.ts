import type { BundledPluginTranslationCatalogs } from '@valley/plugin-sdk'
import en from '../locales/en.json'
import de from '../locales/de.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import zhCN from '../locales/zh-CN.json'

export const generatedCatalogs = { en, de, es, fr, 'zh-CN': zhCN } satisfies BundledPluginTranslationCatalogs
