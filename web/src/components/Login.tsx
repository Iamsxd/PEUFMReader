import { type FormEvent, useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { AuthProviders, Session } from '../types'

interface Props {
  onLogin: (session: Session) => void
}

export function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [providers, setProviders] = useState<AuthProviders>({ oidc: false, ldap: false })

  useEffect(() => {
    void api.authProviders().then(setProviders).catch(() => undefined)
  }, [])

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
        {providers.oidc && (
          <><div className="login-divider"><span>或</span></div><a className="oidc-login-button" href="/api/v1/auth/oidc/start">使用统一身份认证登录</a></>
        )}
        {providers.ldap && <p className="login-provider-hint">LDAP 账号可直接使用上面的用户名和密码登录。</p>}
      </section>
    </main>
  )
}
