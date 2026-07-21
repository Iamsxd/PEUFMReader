import { type FormEvent, useEffect, useState } from 'react'
import { APIError, api } from '../api'
import type { DeviceToken, User } from '../types'
import { formatRelativeTime } from '../utils'

export function DeviceSyncPage({ user }: { user: User }) {
  const [tokens, setTokens] = useState<DeviceToken[]>([])
  const [name, setName] = useState('我的阅读器')
  const [expiresDays, setExpiresDays] = useState(365)
  const [newToken, setNewToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const origin = window.location.origin

  async function refresh() {
    try {
      setTokens(await api.listDeviceTokens())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '设备令牌加载失败。')
    }
  }

  useEffect(() => { void refresh() }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const created = await api.createDeviceToken(name, expiresDays)
      setNewToken(created.token ?? '')
      setTokens((items) => [{ ...created, token: undefined }, ...items])
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '设备令牌创建失败。')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(token: DeviceToken) {
    if (!window.confirm(`撤销“${token.name}”的访问权限？`)) return
    try {
      await api.revokeDeviceToken(token.id)
      setTokens((items) => items.filter((item) => item.id !== token.id))
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '令牌撤销失败。')
    }
  }

  return (
    <div className="device-sync-page">
      <section className="page-heading"><div><p className="eyebrow">外部阅读设备</p><h1>OPDS 与进度同步</h1><p className="muted">为 KOReader、Kobo 适配器或其他 OPDS 客户端创建独立令牌，不要使用网页登录密码。</p></div></section>
      {error && <div className="notice error" role="alert">{error}</div>}
      {newToken && <section className="device-token-reveal"><strong>请立即保存令牌，此后不会再次显示</strong><code>{newToken}</code><button className="secondary" onClick={() => void navigator.clipboard.writeText(newToken)}>复制令牌</button></section>}

      <section className="integration-panel device-endpoint-panel">
        <div className="section-title"><div><p className="eyebrow">连接参数</p><h2>阅读器地址</h2></div></div>
        <dl>
          <div><dt>OPDS 1.2</dt><dd><code>{origin}/opds/v1.2/catalog</code></dd></div>
          <div><dt>KOReader 同步服务器</dt><dd><code>{origin}/api/koreader</code></dd></div>
          <div><dt>Kobo 状态桥接</dt><dd><code>{origin}/api/kobo/v1/library/&#123;书籍ID&#125;/state</code></dd></div>
          <div><dt>用户名</dt><dd><code>{user.username}</code></dd></div>
          <div><dt>密码 / API Key</dt><dd>使用下方生成的设备令牌</dd></div>
        </dl>
        <p className="muted">KOReader 文档键使用 <code>peufm:书籍ID</code>、书籍 SHA-256 或原文件名时会自动关联 Web 阅读进度；其他文档键会先作为独立进度保存。</p>
      </section>

      <section className="integration-panel device-token-panel">
        <div className="section-title"><div><p className="eyebrow">访问令牌</p><h2>{tokens.length} 台设备可访问</h2></div></div>
        <form onSubmit={create}>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="设备名称" />
          <label>有效天数<input type="number" min="0" max="3650" value={expiresDays} onChange={(event) => setExpiresDays(Number(event.target.value))} /><small>0 表示不过期</small></label>
          <button className="primary" disabled={busy}>{busy ? '生成中…' : '生成令牌'}</button>
        </form>
        <div className="device-token-list">
          {tokens.map((token) => <div key={token.id}><span><strong>{token.name}</strong><small>创建于 {formatRelativeTime(token.createdAt)} · {token.lastUsedAt ? `最近使用 ${formatRelativeTime(token.lastUsedAt)}` : '尚未使用'} · {token.expiresAt ? `${formatRelativeTime(token.expiresAt)}过期` : '不过期'}</small></span><button className="quiet danger-text" onClick={() => void revoke(token)}>撤销</button></div>)}
          {tokens.length === 0 && <p className="muted">还没有设备令牌。</p>}
        </div>
      </section>
    </div>
  )
}
