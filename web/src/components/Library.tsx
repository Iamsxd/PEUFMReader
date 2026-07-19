import { useCallback, useEffect, useState } from 'react'
import type { BookFile, CatalogQuery, Session } from '../types'
import { AdminPage } from './AdminPage'
import { CatalogPage } from './CatalogPage'
import { CategoriesPage } from './CategoriesPage'
import { HomePage } from './HomePage'

interface Props {
  session: Session
  onOpenBook: (book: BookFile) => void
  onLogout: () => void
}

type LibraryView = 'home' | 'books' | 'categories' | 'admin'

interface LibraryRoute {
  view: LibraryView
  params: URLSearchParams
  key: string
}

export function Library({ session, onOpenBook, onLogout }: Props) {
  const [route, setRoute] = useState(readRoute)
  const isAdmin = session.user.role === 'admin'

  useEffect(() => {
    const handleHashChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', handleHashChange)
    if (!window.location.hash) window.history.replaceState(null, '', '#/home')
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  const navigate = useCallback((view: LibraryView, query: CatalogQuery = {}) => {
    const path = view === 'books' ? 'books' : view
    const params = new URLSearchParams()
    if (view === 'books') {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== '') params.set(key, String(value))
      }
    }
    window.location.hash = `/${path}${params.size > 0 ? `?${params.toString()}` : ''}`
  }, [])

  const activeView = route.view === 'admin' && !isAdmin ? 'home' : route.view

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="app-brand" onClick={() => navigate('home')} aria-label="返回首页">
          <span>PR</span><strong>PEUFMReader</strong>
        </button>
        <nav className="app-navigation" aria-label="主导航">
          <button className={activeView === 'home' ? 'active' : ''} onClick={() => navigate('home')}>首页</button>
          <button className={activeView === 'books' ? 'active' : ''} onClick={() => navigate('books')}>全部书籍</button>
          <button className={activeView === 'categories' ? 'active' : ''} onClick={() => navigate('categories')}>分类</button>
          {isAdmin && <button className={activeView === 'admin' ? 'active' : ''} onClick={() => navigate('admin')}>管理后台</button>}
        </nav>
        <div className="account-menu">
          <span><strong>{session.user.username}</strong><small>{session.user.role === 'admin' ? '管理员' : '阅读者'}</small></span>
          <button className="quiet" onClick={onLogout}>退出</button>
        </div>
      </header>

      <div className="app-content">
        {activeView === 'home' && (
          <HomePage
            username={session.user.username}
            onOpenBook={onOpenBook}
            onBrowse={(query) => navigate('books', query)}
            onCategories={() => navigate('categories')}
          />
        )}
        {activeView === 'books' && (
          <CatalogPage
            key={route.key}
            initialQuery={catalogQueryFromParams(route.params)}
            isAdmin={isAdmin}
            onOpenBook={onOpenBook}
            onManageBook={(book) => {
              window.location.hash = `/admin?edition=${book.editionId}`
            }}
          />
        )}
        {activeView === 'categories' && <CategoriesPage onBrowse={(query) => navigate('books', query)} />}
        {activeView === 'admin' && isAdmin && <AdminPage initialEditionID={positiveInteger(route.params.get('edition'))} />}
      </div>
    </main>
  )
}

function readRoute(): LibraryRoute {
  const raw = window.location.hash.replace(/^#\/?/, '') || 'home'
  const [path, search = ''] = raw.split('?', 2)
  const view: LibraryView = path === 'books' || path === 'categories' || path === 'admin' ? path : 'home'
  return { view, params: new URLSearchParams(search), key: raw }
}

function catalogQueryFromParams(params: URLSearchParams): CatalogQuery {
  const format = params.get('format')
  const status = params.get('status')
  const sort = params.get('sort')
  return {
    q: params.get('q') ?? '',
    category: params.get('category') ?? '',
    format: format === 'pdf' || format === 'epub' ? format : '',
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
