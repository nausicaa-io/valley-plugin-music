import { React } from './runtime'
import type { FC, ReactNode } from 'react'
import { uiText } from './localization'
import { Home, Search, X } from './icons'
import { isNewTabClick, onMiddleClick } from './pageNavigator'

/**
 * The page's single header row: host back/forward and a Home button on the left,
 * the current page's icon and title in the centre, and a search button beside
 * the host menu. Search spans the row in place of the title and folds back once it is empty and
 * loses focus, so browsing never pays for a second toolbar row.
 */
export const PageHeader: FC<{
  title: string
  icon: ReactNode
  homeLabel: string
  onHome: (event: React.MouseEvent) => void
  query: string
  onQuery: (value: string) => void
  placeholder: string
}> = ({ title, icon, homeLabel, onHome, query, onQuery, placeholder }) => {
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const searching = open || query.length > 0

  React.useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  React.useEffect(() => {
    const doc = inputRef.current?.ownerDocument ?? document
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOpen(true)
        inputRef.current?.focus()
      }
    }
    doc.addEventListener('keydown', onKey)
    return () => doc.removeEventListener('keydown', onKey)
  }, [])

  const close = (): void => {
    onQuery('')
    setOpen(false)
  }

  return (
    <nav className={`music-breadcrumbs${searching ? ' searching' : ''}`} aria-label={uiText('music.header.location')}>
      <button className="music-header-btn music-header-home" title={homeLabel} aria-label={homeLabel} onClick={(e) => { if (!isNewTabClick(e)) setOpen(false); onHome(e) }} onAuxClick={onMiddleClick(onHome)}>
        <Home />
      </button>
      {searching ? (
        <div className="music-header-search search-field">
          <Search className="search-field-icon" />
          <input
            ref={inputRef}
            className="search-field-input"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(e) => onQuery(e.target.value)}
            onBlur={() => { if (!query) setOpen(false) }}
            onKeyDown={(e) => { if (e.key === 'Escape') close() }}
          />
          <button className="search-field-action" aria-label={uiText('auto.67300d0fed7c')} title={uiText('auto.67300d0fed7c')} onMouseDown={(e) => e.preventDefault()} onClick={close}>
            <X />
          </button>
        </div>
      ) : (
        <div className="music-page-title" title={title}>
          <span className="music-page-title-icon" aria-hidden>{icon}</span>
          <span className="music-page-title-text">{title}</span>
        </div>
      )}
      {!searching && (
        <button className="music-header-btn" title={placeholder} aria-label={placeholder} onClick={() => setOpen(true)}>
          <Search />
        </button>
      )}
    </nav>
  )
}
