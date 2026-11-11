import { React } from './runtime'
import type { FC } from 'react'
import { uiText } from './localization'
import { Home, Search, X } from './icons'

export interface PageCrumb {
  label: string
  title: string
  onClick: () => void
}

/**
 * The page's single header row: host back/forward and a Home button on the left,
 * the centered breadcrumb (its leading `/` is Home too) and a search button beside
 * the host menu. Search spans the row in place of the breadcrumb and folds back once it is empty and
 * loses focus, so browsing never pays for a second toolbar row.
 */
export const PageHeader: FC<{
  crumbs: PageCrumb[]
  homeLabel: string
  onHome: () => void
  query: string
  onQuery: (value: string) => void
  placeholder: string
  onContextMenu?: (event: React.MouseEvent) => void
}> = ({ crumbs, homeLabel, onHome, query, onQuery, placeholder, onContextMenu }) => {
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
    <nav className={`music-breadcrumbs${searching ? ' searching' : ''}`} aria-label={uiText('music.header.location')} onContextMenu={searching ? undefined : onContextMenu}>
      <button className="music-header-btn music-header-home" title={homeLabel} aria-label={homeLabel} onClick={() => { setOpen(false); onHome() }}>
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
        <div className="music-breadcrumb-items">
          <button className="music-breadcrumb-home" title={homeLabel} aria-label={homeLabel} onClick={onHome}>/</button>
          {crumbs.map((crumb, index) => <React.Fragment key={`${index}:${crumb.title}`}>
            {index > 0 && <span className="music-breadcrumb-separator" aria-hidden="true">/</span>}
            <button className={index === crumbs.length - 1 ? undefined : 'music-breadcrumb-parent'} title={crumb.title} aria-current={index === crumbs.length - 1 ? 'page' : undefined} onClick={crumb.onClick}>{crumb.label}</button>
          </React.Fragment>)}
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
