import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { BookFile, CatalogQuery, Session } from '../types'
import { AdminPage } from './AdminPage'
import { BookDetailPage } from './BookDetailPage'
import { CatalogPage } from './CatalogPage'
import { CategoriesPage } from './CategoriesPage'
import { FavoritesPage } from './FavoritesPage'
import { HomePage } from './HomePage'
import { RecommendationsPage } from './RecommendationsPage'
import { ReadingStatisticsPage } from './ReadingStatisticsPage'
import { DeviceSyncPage } from './DeviceSyncPage'
import { OfflineBooksPage } from './OfflineBooksPage'
import { InstallAppPrompt } from './InstallAppPrompt'

interface Props {
  session: Session
  offlineMode: boolean
  onOpenBook: (book: BookFile) => void
  onLogout: () => void
}

type LibraryView = 'home' | 'books' | 'categories' | 'favorites' | 'recommendations' | 'statistics' | 'offline' | 'devices' | 'book' | 'admin'
type NavigationView = Exclude<LibraryView, 'book'>

interface LibraryRoute {
  view: LibraryView
  params: URLSearchParams
  key: string
  bookID?: number
}

export function Library({ session, offlineMode, onOpenBook, onLogout }: Props) {
  const [route, setRoute] = useState(readRoute)
  const [mobileHeaderHidden, setMobileHeaderHidden] = useState(false)
  const lastScrollYRef = useRef(0)
  const isAdmin = session.user.role === 'admin'

  useEffect(() => {
    const handleHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', handleHashChange)
    if (!window.location.hash) window.history.replaceState(null, '', '#/home')
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 720px), (hover: none) and (pointer: coarse)')
    const handleScroll = () => {
      const scrollY = Math.max(0, window.scrollY)
      const movement = scrollY - lastScrollYRef.current
      lastScrollYRef.current = scrollY
      if (!mobileQuery.matches || scrollY < 36) {
        setMobileHeaderHidden(false)
        return
      }
      if (document.querySelector('.app-header details[open]')) return
      if (movement > 12) setMobileHeaderHidden(true)
      else if (movement < -8) setMobileHeaderHidden(false)
    }
    const handleViewportChange = () => {
      lastScrollYRef.current = window.scrollY
      if (!mobileQuery.matches) setMobileHeaderHidden(false)
    }
    handleViewportChange()
    window.addEventListener('scroll', handleScroll, { passive: true })
    mobileQuery.addEventListener('change', handleViewportChange)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      mobileQuery.removeEventListener('change', handleViewportChange)
    }
  }, [])

  useEffect(() => {
    lastScrollYRef.current = window.scrollY
    setMobileHeaderHidden(false)
  }, [route.key])

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>('.app-header details[open]').forEach((menu) => {
        if (!menu.contains(event.target as Node)) menu.removeAttribute('open')
      })
    }
    document.addEventListener('pointerdown', closeMenus)
    return () => document.removeEventListener('pointerdown', closeMenus)
  }, [])

  const navigate = useCallback((view: NavigationView, query: CatalogQuery = {}) => {
    const path = view === 'books' ? 'books' : view
    const params = new URLSearchParams()
    if (view === 'books') {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value))
      }
    }
    window.location.hash = `/${path}${params.size > 0 ? `?${params.toString()}` : ''}`
  }, [])

  const viewBook = useCallback((book: BookFile) => {
    window.location.hash = `/book/${book.id}`
  }, [])

  const requestedView = route.view === 'admin' && !isAdmin ? 'home' : route.view
  const activeView = offlineMode ? 'offline' : requestedView
  const secondaryLabel = activeView === 'offline' ? '离线书籍' : activeView === 'devices' ? '设备同步' : activeView === 'admin' ? '管理后台' : '更多'
  const secondaryActive = activeView === 'offline' || activeView === 'devices' || activeView === 'admin'

  function navigateFromMenu(event: MouseEvent<HTMLButtonElement>, view: NavigationView) {
    event.currentTarget.closest('details')?.removeAttribute('open')
    navigate(view)
  }

  return (
    <main className="app-shell">
      <header className={`app-header${mobileHeaderHidden ? ' is-mobile-hidden' : ''}`} onFocusCapture={() => setMobileHeaderHidden(false)}>
        <button className="app-brand" onClick={() => navigate('home')} aria-label="返回首页">
          <span>PR</span><strong>PEUFMReader</strong>
        </button>
        <nav className="app-navigation" aria-label="主导航">
          <div className="app-navigation-primary">
            <button className={activeView === 'home' ? 'active' : ''} onClick={() => navigate('home')}>首页</button>
            <button className={activeView === 'recommendations' ? 'active' : ''} onClick={() => navigate('recommendations')}>推荐</button>
            <button className={activeView === 'favorites' ? 'active' : ''} onClick={() => navigate('favorites')}>收藏</button>
            <button className={activeView === 'books' ? 'active' : ''} onClick={() => navigate('books')}>全部书籍</button>
            <button className={activeView === 'categories' ? 'active' : ''} onClick={() => navigate('categories')}>分类</button>
            <button className={activeView === 'statistics' ? 'active' : ''} onClick={() => navigate('statistics')}>阅读统计</button>
            <details className={`navigation-menu${secondaryActive ? ' active' : ''}`}>
              <summary>{secondaryLabel}</summary>
              <div className="navigation-popover">
                <p>本机阅读</p>
                <button className={activeView === 'offline' ? 'active' : ''} onClick={(event) => navigateFromMenu(event, 'offline')}><span>离线书籍</span><small>保存在当前浏览器的设备副本</small></button>
                <p>阅读设备</p>
                <button className={activeView === 'devices' ? 'active' : ''} onClick={(event) => navigateFromMenu(event, 'devices')}><span>设备同步</span><small>OPDS、KOReader 与 Kobo</small></button>
                {isAdmin && <><hr /><p>系统</p><button className={activeView === 'admin' ? 'active' : ''} onClick={(event) => navigateFromMenu(event, 'admin')}><span>管理后台</span><small>书库、用户与系统维护</small></button></>}
              </div>
            </details>
          </div>
        </nav>
        <details className="account-menu">
          <summary aria-label="账号菜单"><span className="account-avatar">{session.user.username.slice(0, 1).toUpperCase()}</span><span className="account-summary"><strong>{session.user.username}</strong><small>{session.user.role === 'admin' ? '管理员' : '阅读者'}</small></span><span aria-hidden="true">⌄</span></summary>
          <div className="account-popover"><div><strong>{session.user.username}</strong><small>{session.user.role === 'admin' ? '管理员账号' : '阅读者账号'}</small></div><button className="quiet" onClick={onLogout}>退出登录</button></div>
        </details>
      </header>

      <InstallAppPrompt />

      <div className="app-content">
        {activeView === 'home' && (
          <HomePage
            username={session.user.username}
            onOpenBook={onOpenBook}
            onViewBook={viewBook}
            onBrowse={(query) => navigate('books', query)}
            onCategories={() => navigate('categories')}
            onFavorites={() => navigate('favorites')}
            onRecommendations={() => navigate('recommendations')}
          />
        )}
        {activeView === 'books' && (
          <CatalogPage
            key={route.key}
            initialQuery={catalogQueryFromParams(route.params)}
            isAdmin={isAdmin}
            onOpenBook={onOpenBook}
            onViewBook={viewBook}
            onManageBook={(book) => {
              window.location.hash = `/admin?edition=${book.editionId}`
            }}
          />
        )}
        {activeView === 'categories' && <CategoriesPage onBrowse={(query) => navigate('books', query)} />}
        {activeView === 'favorites' && <FavoritesPage onOpenBook={onOpenBook} onViewBook={viewBook} onBrowse={() => navigate('books')} />}
        {activeView === 'recommendations' && <RecommendationsPage onOpenBook={onOpenBook} onViewBook={viewBook} onBrowse={() => navigate('books')} />}
        {activeView === 'statistics' && <ReadingStatisticsPage onOpenBook={onOpenBook} onViewBook={viewBook} />}
        {activeView === 'offline' && <OfflineBooksPage userID={session.user.id} offlineMode={offlineMode} onOpenBook={onOpenBook} onBrowse={() => navigate('books')} />}
        {activeView === 'devices' && <DeviceSyncPage user={session.user} />}
        {activeView === 'book' && route.bookID && (
          <BookDetailPage
            key={route.bookID}
            bookID={route.bookID}
            userID={session.user.id}
            isAdmin={isAdmin}
            onBack={() => navigate('books')}
            onOpenBook={onOpenBook}
            onViewBook={viewBook}
            onManageBook={(book) => { window.location.hash = `/admin?edition=${book.editionId}` }}
            onBrowseCategory={(category) => navigate('books', { category, sort: 'title' })}
          />
        )}
        {activeView === 'admin' && isAdmin && <AdminPage initialEditionID={positiveInteger(route.params.get('edition'))} currentUserID={session.user.id} />}
      </div>
    </main>
  )
}

function readRoute(): LibraryRoute {
  const raw = window.location.hash.replace(/^#\/?/, '') || 'home'
  const [path, search = ''] = raw.split('?', 2)
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'book') {
    const bookID = positiveInteger(parts[1] ?? null)
    if (bookID) return { view: 'book', bookID, params: new URLSearchParams(search), key: raw }
  }
  const candidate = parts[0]
  const view: LibraryView = candidate === 'books' || candidate === 'categories' || candidate === 'favorites' || candidate === 'recommendations' || candidate === 'statistics' || candidate === 'offline' || candidate === 'devices' || candidate === 'admin' ? candidate : 'home'
  return { view, params: new URLSearchParams(search), key: raw }
}

function catalogQueryFromParams(params: URLSearchParams): CatalogQuery {
  const format = params.get('format')
  const status = params.get('status')
  const sort = params.get('sort')
  return {
    q: params.get('q') ?? '',
    category: params.get('category') ?? '',
    format: format === 'pdf' || format === 'epub' || format === 'mobi' || format === 'azw3' ? format : '',
    status: status === 'unread' || status === 'reading' || status === 'paused' || status === 'finished' || status === 'abandoned' ? status : '',
    sort: sort === 'relevance' || sort === 'title' || sort === 'newest' || sort === 'hot' ? sort : undefined,
    page: positiveInteger(params.get('page')),
  }
}

function positiveInteger(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
