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
  const [device, setDevice] = useState<'opds' | 'koreader' | 'kobo'>('opds')
  const [notice, setNotice] = useState('')
  const origin = window.location.origin

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(`已复制${label}。`)
    } catch {
      setNotice('浏览器无法访问剪贴板，请手动选择并复制。')
    }
  }

  async function refresh() {
    try {
      setTokens(await api.listDeviceTokens())
    } catch (reason) {
      setError(reason instanceof APIError ? reason.message : '设备令牌加载失败。')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

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
      <section className="page-heading">
        <div>
          <p className="eyebrow">外部阅读设备</p>
          <h1>OPDS 与进度同步</h1>
          <p className="muted">为 KOReader、Kobo 适配器或其他 OPDS 客户端创建独立令牌，不要使用网页登录密码。</p>
        </div>
      </section>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      <section className="device-onboarding">
        <div className="device-choice" role="group" aria-label="设备接入方式">
          {(
            [
              ['opds', 'OPDS 客户端'],
              ['koreader', 'KOReader'],
              ['kobo', 'Kobo 适配器'],
            ] as const
          ).map(([value, label]) => (
            <button
              className={device === value ? 'secondary active' : 'secondary'}
              key={value}
              aria-pressed={device === value}
              onClick={() => setDevice(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <ol className="device-steps">
          <li>
            <span>01</span>
            <div>
              <h2>先创建专属令牌</h2>
              <p>在下方填写设备名称并生成令牌。每台设备使用不同令牌，丢失设备时可以单独撤销。</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <h2>
                {device === 'opds' ? '添加 OPDS 目录' : device === 'koreader' ? '配置进度同步服务' : '配置自建适配器'}
              </h2>
              <p>
                {device === 'opds'
                  ? '在支持 OPDS 的阅读应用中添加目录地址，用户名填当前账号，密码填设备令牌。OPDS 用于浏览和下载，不会自动同步阅读进度。'
                  : device === 'koreader'
                    ? '在 KOReader 的进度同步插件中填写自定义服务器、用户名和设备令牌。文档键需要匹配书籍 ID、SHA-256 或原文件名，才能关联 Web 进度。'
                    : '当前只提供状态读写接口，需要自建插件或脚本传入书籍 ID。不能直接替换 Kobo 官方商店，也不会自动推送书籍。'}
              </p>
              <div className="device-copy-endpoint">
                <code>
                  {origin}
                  {device === 'opds'
                    ? '/opds/v1.2/catalog'
                    : device === 'koreader'
                      ? '/api/koreader'
                      : '/api/kobo/v1/library/{书籍ID}/state'}
                </code>
                <button
                  className="quiet"
                  onClick={() =>
                    void copy(
                      `${origin}${device === 'opds' ? '/opds/v1.2/catalog' : device === 'koreader' ? '/api/koreader' : '/api/kobo/v1/library/{书籍ID}/state'}`,
                      '连接地址',
                    )
                  }
                >
                  复制地址
                </button>
              </div>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h2>确认网络与连接</h2>
              <p>
                设备必须能够访问此服务器。远程连接请使用 HTTPS 或受信任的私有网络；令牌相当于设备密码，不要分享给他人。
              </p>
            </div>
          </li>
        </ol>
      </section>
      {newToken && (
        <section className="device-token-reveal">
          <strong>请立即保存令牌，此后不会再次显示</strong>
          <code>{newToken}</code>
          <button className="secondary" onClick={() => void copy(newToken, '令牌')}>
            复制令牌
          </button>
        </section>
      )}

      <section className="integration-panel device-endpoint-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">连接参数</p>
            <h2>阅读器地址</h2>
          </div>
        </div>
        <dl>
          <div>
            <dt>OPDS 1.2</dt>
            <dd>
              <code>{origin}/opds/v1.2/catalog</code>
            </dd>
          </div>
          <div>
            <dt>KOReader 同步服务器</dt>
            <dd>
              <code>{origin}/api/koreader</code>
            </dd>
          </div>
          <div>
            <dt>Kobo 状态桥接</dt>
            <dd>
              <code>{origin}/api/kobo/v1/library/&#123;书籍ID&#125;/state</code>
            </dd>
          </div>
          <div>
            <dt>用户名</dt>
            <dd>
              <code>{user.username}</code>
            </dd>
          </div>
          <div>
            <dt>密码 / API Key</dt>
            <dd>使用下方生成的设备令牌</dd>
          </div>
        </dl>
        <p className="muted">
          KOReader 文档键使用 <code>peufm:书籍ID</code>、书籍 SHA-256 或原文件名时会自动关联 Web
          阅读进度；其他文档键会先作为独立进度保存。
        </p>
      </section>

      <section className="integration-panel device-token-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">访问令牌</p>
            <h2>{tokens.length} 台设备可访问</h2>
          </div>
        </div>
        <form onSubmit={create}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            placeholder="设备名称"
          />
          <label>
            有效天数
            <input
              type="number"
              min="0"
              max="3650"
              value={expiresDays}
              onChange={(event) => setExpiresDays(Number(event.target.value))}
            />
            <small>0 表示不过期</small>
          </label>
          <button className="primary" disabled={busy}>
            {busy ? '生成中…' : '生成令牌'}
          </button>
        </form>
        <div className="device-token-list">
          {tokens.map((token) => (
            <div key={token.id}>
              <span>
                <strong>{token.name}</strong>
                <small>
                  创建于 {formatRelativeTime(token.createdAt)} ·{' '}
                  {token.lastUsedAt ? `最近使用 ${formatRelativeTime(token.lastUsedAt)}` : '尚未使用'} ·{' '}
                  {token.expiresAt ? `${formatRelativeTime(token.expiresAt)}过期` : '不过期'}
                </small>
              </span>
              <button className="quiet danger-text" onClick={() => void revoke(token)}>
                撤销
              </button>
            </div>
          ))}
          {tokens.length === 0 && <p className="muted">还没有设备令牌。</p>}
        </div>
      </section>
    </div>
  )
}
