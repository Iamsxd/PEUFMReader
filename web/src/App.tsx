import { useEffect, useState } from 'react'
import { APIError, api } from './api'
import { Library } from './components/Library'
import { Login } from './components/Login'
import { Reader } from './components/Reader'
import { clearOfflineUserData, loadOfflineIdentity, offlineBookContent, rememberOfflineIdentity, syncOfflineReading } from './offline'
import type { BookFile, ReadingMark, Session } from './types'
import { confirmLeaveDrafts } from './draftGuard'

interface OpenBookState {
  book: BookFile
  localContent?: ArrayBuffer
  mark?: ReadingMark
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [openBook, setOpenBook] = useState<OpenBookState | null>(null)
  const [offlineMode, setOfflineMode] = useState(false)

  useEffect(() => {
    let disposed = false
    const restoreSession = async () => {
      try {
        const next = await api.me()
        if (disposed) return
        rememberOfflineIdentity(next)
        setSession(next)
        setOfflineMode(false)
        void syncOfflineReading(next.user.id)
      } catch (reason) {
        if (disposed) return
        const cached = loadOfflineIdentity()
        if (reason instanceof APIError && reason.status === 0 && cached) {
          api.setSession(cached)
          setSession(cached)
          setOfflineMode(true)
          return
        }
        if (!(reason instanceof APIError && reason.status === 401)) console.error(reason)
        if (cached) void clearOfflineUserData(cached.user.id)
        setSession(null)
        setOfflineMode(false)
      }
    }
    void restoreSession()
    const handleOffline = () => setOfflineMode(true)
    const handleOnline = () => void restoreSession()
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      disposed = true
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  function authenticated(next: Session) {
    rememberOfflineIdentity(next)
    setSession(next)
    setOfflineMode(false)
    void syncOfflineReading(next.user.id)
  }

  async function open(book: BookFile, mark?: ReadingMark) {
    if (!confirmLeaveDrafts()) return
    const localContent = session ? await offlineBookContent(session.user.id, book.id).catch(() => undefined) : undefined
    setOpenBook({ book, localContent, mark })
  }

  function closeBook() {
    if (!confirmLeaveDrafts()) return
    setOpenBook(null)
  }

  async function logout() {
    if (!confirmLeaveDrafts()) return
    const userID = session?.user.id
    try {
      if (!offlineMode) await api.logout()
    } finally {
      if (userID) await clearOfflineUserData(userID)
      closeBook()
      api.setSession(null)
      setSession(null)
      setOfflineMode(false)
    }
  }

  if (session === undefined) return <main className="loading-page">正在连接书库…</main>
  if (!session) return <Login onLogin={authenticated} />
  if (openBook) return <Reader key={openBook.book.id} book={openBook.book} initialMark={openBook.mark} contentData={openBook.localContent} userID={session.user.id} offlineMode={offlineMode} onClose={closeBook} />
  return <Library session={session} offlineMode={offlineMode} onOpenBook={(book, mark) => void open(book, mark)} onLogout={() => void logout()} />
}
