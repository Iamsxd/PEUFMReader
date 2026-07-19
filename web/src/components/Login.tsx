import { type FormEvent, useState } from 'react'
import { APIError, api } from '../api'
import type { Session } from '../types'

interface Props {
  onLogin: (session: Session) => void
}

export function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      onLogin(await api.login(username, password))
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '登录失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">私有书库 · NAS</p>
        <h1>PEUFMReader</h1>
        <p className="muted">登录后继续你的阅读。</p>
        <form onSubmit={submit}>
          <label>
            用户名
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label>
            密码
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary" type="submit" disabled={submitting}>{submitting ? '正在登录…' : '登录'}</button>
        </form>
      </section>
    </main>
  )
}
