import fs from 'node:fs'
import path from 'node:path'

export async function verify(context) {
  const { evaluate, waitFor, wait, readDatasetRows, readJson, vault, scratch } = context
  const scratchRoot = fs.realpathSync(scratch)
  const lexicalRelative = path.relative(path.resolve(scratch), path.resolve(vault))
  if (!lexicalRelative || lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) throw new Error('The vault must be inside the disposable scratch directory')
  const sentinel = JSON.parse(fs.readFileSync(path.join(scratchRoot, '.valley-test-run.json'), 'utf8'))
  const vaultRoot = fs.realpathSync(vault)
  const relative = path.relative(scratchRoot, vaultRoot)
  if (sentinel.version !== 1 || !/^[a-z0-9][a-z0-9-]*$/.test(sentinel.kind ?? '') || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('This workflow requires a disposable vault inside a sentinel-protected scratch run')
  }
  const liveVault = await evaluate(`(async () => (await window.valley.getVault())?.path ?? null)()`, true)
  if (typeof liveVault !== 'string' || (path.resolve(liveVault) !== path.resolve(vault) && path.resolve(liveVault) !== vaultRoot)) throw new Error('This workflow refuses to drive a different live vault')
  const musicSettingsFile = path.join(vault, '.valley', 'plugins', 'data', 'music', 'config.json')
  try {
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('.settings-nav-item-label > span:not(.settings-nav-issues)')]
        .some((label) => label.textContent?.trim() === 'Music')`),
      'Music Settings navigation'
    )
  } catch (error) {
    const diagnostics = await evaluate(`({
      nav: [...document.querySelectorAll('.settings-nav-item')].map((item) => item.textContent?.trim()),
      errors: window.__valleyGoldenErrors,
      body: document.body?.textContent?.slice(0, 500)
    })`)
    throw new Error(`${error.message}; diagnostics: ${JSON.stringify(diagnostics)}`)
  }
  const clickedMusic = await evaluate(`(() => {
    const label = [...document.querySelectorAll('.settings-nav-item-label > span:not(.settings-nav-issues)')]
      .find((item) => item.textContent?.trim() === 'Music')
    const button = label?.closest('.settings-nav-item')
    button?.click()
    return !!button
  })()`)
  if (!clickedMusic) throw new Error('Music Settings page was not listed')
  await waitFor(
    () => evaluate(`!!document.querySelector('.music-settings input[aria-label="Music folder"]')`),
    'Music Settings view'
  )

  const settingsBeforeFocus = fs.existsSync(musicSettingsFile)
    ? fs.readFileSync(musicSettingsFile, 'utf8')
    : null
  await evaluate(`(() => {
    const input = document.querySelector('.music-settings input[aria-label="Music folder"]')
    input?.focus()
    input?.blur()
  })()`)
  await wait(250)
  const settingsAfterFocus = fs.existsSync(musicSettingsFile)
    ? fs.readFileSync(musicSettingsFile, 'utf8')
    : null
  if (settingsAfterFocus !== settingsBeforeFocus) {
    throw new Error('focusing the prefilled Music folder wrote plugin settings')
  }

  const editedMusicPath = await evaluate(`(() => {
    const input = document.querySelector('.music-settings input[aria-label="Music folder"]')
    if (!(input instanceof HTMLInputElement)) return null
    input.focus()
    input.select()
    document.execCommand('insertText', false, 'Media')
    return input.value
  })()`)
  if (editedMusicPath !== 'Media') throw new Error('Music folder input did not accept an explicit edit')
  await waitFor(
    () => evaluate(`(() => {
      const input = document.querySelector('.music-settings input[aria-label="Music folder"]')
      return input instanceof HTMLInputElement && input.value === 'Media' && input.getAttribute('aria-invalid') !== 'true'
    })()`),
    'valid Music folder edit'
  )
  await evaluate(`(() => {
    const input = document.querySelector('.music-settings input[aria-label="Music folder"]')
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await waitFor(
    async () => fs.existsSync(musicSettingsFile) && readJson(musicSettingsFile).musicPath === 'Media',
    'Music folder persistence'
  )
  const songs = await waitFor(
    async () => {
      const rows = await readDatasetRows(evaluate, 'music.tracks')
      return rows.some((row) => row.file === 'Media/tiny.wav') ? rows : null
    },
    'Music WAV scan'
  )
  if (!songs.some((row) => row.file === 'Media/tiny.wav')) throw new Error('valid WAV was not indexed')

  await evaluate(`document.querySelector('.settings-page-info-trigger')?.click()`)
  await waitFor(
    () => evaluate(`!!document.querySelector('.settings-page-info-card')`),
    'Music page information popover'
  )
  const musicInfo = await evaluate(`document.querySelector('.settings-page-info-card')?.textContent ?? ''`)
  if (!musicInfo.includes('Music library and player') || !musicInfo.includes('data/music/config.json')) {
    throw new Error(`Music page information is incomplete: ${musicInfo}`)
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await waitFor(
    () => evaluate(`!document.querySelector('.settings-page-info-card') && document.activeElement === document.querySelector('.settings-page-info-trigger')`),
    'page information focus return'
  )

  await evaluate(`document.querySelector('.modal-close')?.click()`)
  await waitFor(() => evaluate(`!document.querySelector('.settings-layout')`), 'Settings close')

}
