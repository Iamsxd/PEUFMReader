import { useEffect, useState } from 'react'
import { APIError, api } from './api'
import { Library } from './components/Library'
import { Login } from './components/Login'
import { Reader } from './components/Reader'
import type { BookFile, Session } from './types'

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [openBook, setOpenBook] = useState<BookFile | null>(null)

  useEffect(() => {
    void api.me().then(setSession).catch((reason) => {
      if (!(reason instanceof APIError && reason.status === 401)) console.error(reason)
      setSession(null)
    })
  }, [])

  async function logout() {
    try {
      await api.logout()
    } finally {
      setOpenBook(null)
      setSession(null)
    }
  }

  if (session === undefined) return <main className="loading-page">正在连接书库…</main>
  if (!session) return <Login onLogin={setSession} />
  if (openBook) return <Reader book={openBook} onClose={() => setOpenBook(null)} />
  return <Library session={session} onOpenBook={setOpenBook} onLogout={() => void logout()} />
}
