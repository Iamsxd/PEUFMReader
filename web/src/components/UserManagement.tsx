import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { ManagedUser, Role, UserAccessInfo, UserSessionInfo } from '../types'
import { formatDuration, formatRelativeTime } from '../utils'
import { LibraryPermissionManager } from './LibraryPermissionManager'

interface Props {
  currentUserID: number
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export function UserManagement({ currentUserID, onError, onNotice }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<Role>('reader')

  async function refreshUsers() {
    try {
      setUsers(await api.listUsers())
    } catch (reason) {
      onError(userErrorMessage(reason, '无法加载用户列表。'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refreshUsers() }, [])

  const summary = useMemo(() => ({
    active: users.filter((user) => !user.disabledAt).length,
    admins: users.filter((user) => user.role === 'admin' && !user.disabledAt).length,
    disabled: users.filter((user) => user.disabledAt).length,
    sessions: users.reduce((total, user) => total + user.activeSessionCount, 0),
  }), [users])

  async function createUser(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    onError('')
    try {
      await api.createUser(newUsername, newPassword, newRole)
      setNewUsername('')
      setNewPassword('')
      setNewRole('reader')
      onNotice(`账号“${newUsername.trim()}”已创建。`)
      await refreshUsers()
    } catch (reason) {
      onError(userErrorMessage(reason, '用户创建失败。'))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="user-management-panel">
      <div className="section-title">
        <div><p className="eyebrow">用户管理</p><h2>{users.length} 个账号</h2><p className="muted">管理角色、登录权限、密码和设备会话；阅读记录仅在永久删除账号时清除。</p></div>
      </div>

      <div className="user-summary-grid" aria-label="用户统计">
        <div><strong>{summary.active}</strong><span>可登录账号</span></div>
        <div><strong>{summary.admins}</strong><span>有效管理员</span></div>
        <div><strong>{summary.sessions}</strong><span>在线会话</span></div>
        <div className={summary.disabled ? 'has-issue' : ''}><strong>{summary.disabled}</strong><span>已禁用</span></div>
      </div>

      <form className="user-create-form" onSubmit={createUser}>
        <label><span>用户名</span><input aria-label="新用户名" autoComplete="off" maxLength={64} placeholder="字母、数字、中文、.-_" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} required /></label>
        <label><span>初始密码</span><input aria-label="新用户密码" autoComplete="new-password" type="password" placeholder="至少 12 位" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
        <label><span>角色</span><select aria-label="新用户角色" value={newRole} onChange={(event) => setNewRole(event.target.value as Role)}><option value="reader">阅读者</option><option value="admin">管理员</option></select></label>
        <button className="primary" type="submit" disabled={creating}>{creating ? '创建中…' : '添加账号'}</button>
      </form>

      <div className="user-management-list">
        {loading && <div className="job-empty">正在加载用户…</div>}
        {!loading && users.length === 0 && <div className="job-empty">暂无用户</div>}
        {users.map((user) => (
          <UserManagementRow
            key={user.id}
            user={user}
            currentUserID={currentUserID}
            onChanged={refreshUsers}
            onDeleted={(userID) => setUsers((current) => current.filter((item) => item.id !== userID))}
            onError={onError}
            onNotice={onNotice}
          />
        ))}
      </div>
      <LibraryPermissionManager users={users} onError={onError} onNotice={onNotice} />
    </section>
  )
}

function UserManagementRow({ user, currentUserID, onChanged, onDeleted, onError, onNotice }: {
  user: ManagedUser
  currentUserID: number
  onChanged: () => Promise<void>
  onDeleted: (userID: number) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [username, setUsername] = useState(user.username)
  const [role, setRole] = useState<Role>(user.role)
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [access, setAccess] = useState<UserAccessInfo | null>(null)
  const [loadingAccess, setLoadingAccess] = useState(false)
  const isCurrent = user.id === currentUserID
  const disabled = Boolean(user.disabledAt)
  const profileChanged = username.trim().toLowerCase() !== user.username || role !== user.role

  useEffect(() => {
    setUsername(user.username)
    setRole(user.role)
  }, [user.username, user.role])

  async function loadAccess() {
    setLoadingAccess(true)
    try {
      setAccess(await api.getUserAccess(user.id))
    } catch (reason) {
      onError(userErrorMessage(reason, '无法加载登录信息。'))
    } finally {
      setLoadingAccess(false)
    }
  }

  async function toggleAccess() {
    const next = !expanded
    setExpanded(next)
    if (next && !access) await loadAccess()
  }

  async function saveProfile() {
    setBusy('profile')
    onError('')
    try {
      await api.updateUser(user.id, { username: username.trim(), role, disabled })
      onNotice(`账号“${username.trim()}”的信息已更新。`)
      await onChanged()
    } catch (reason) {
      onError(userErrorMessage(reason, '用户信息更新失败。'))
    } finally {
      setBusy('')
    }
  }

  async function toggleDisabled() {
    const action = disabled ? '启用' : '禁用'
    if (!disabled && !window.confirm(`禁用“${user.username}”后，该用户的所有会话会立即下线。继续吗？`)) return
    setBusy('status')
    onError('')
    try {
      await api.updateUser(user.id, { username: username.trim(), role, disabled: !disabled })
      setAccess(null)
      onNotice(`账号“${username.trim()}”已${action}。`)
      await onChanged()
    } catch (reason) {
      onError(userErrorMessage(reason, `${action}用户失败。`))
    } finally {
      setBusy('')
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault()
    if (isCurrent && !window.confirm('重置当前账号密码会立即退出本次登录。继续吗？')) return
    if (!isCurrent && !window.confirm(`重置“${user.username}”的密码并下线其所有设备吗？`)) return
    setBusy('password')
    onError('')
    try {
      await api.resetUserPassword(user.id, newPassword)
      setNewPassword('')
      onNotice(`账号“${user.username}”的密码已重置，所有旧会话已失效。`)
      if (isCurrent) {
        window.location.reload()
        return
      }
      setAccess(null)
      await onChanged()
    } catch (reason) {
      onError(userErrorMessage(reason, '密码重置失败。'))
    } finally {
      setBusy('')
    }
  }

  async function revokeAllSessions() {
    if (!window.confirm(`${isCurrent ? '这会退出当前管理会话。' : `这会下线“${user.username}”的所有设备。`}继续吗？`)) return
    setBusy('sessions')
    onError('')
    try {
      await api.revokeUserSessions(user.id)
      onNotice(`账号“${user.username}”的全部会话已撤销。`)
      if (isCurrent) {
        window.location.reload()
        return
      }
      setAccess({ sessions: [], recentLogins: access?.recentLogins ?? [] })
      await onChanged()
    } catch (reason) {
      onError(userErrorMessage(reason, '强制下线失败。'))
    } finally {
      setBusy('')
    }
  }

  async function revokeSession(session: UserSessionInfo) {
    if (!window.confirm(`下线这个${session.current ? '当前' : ''}会话吗？`)) return
    setBusy(`session-${session.id}`)
    onError('')
    try {
      await api.revokeUserSession(user.id, session.id)
      if (session.current) {
        window.location.reload()
        return
      }
      setAccess((current) => current ? { ...current, sessions: current.sessions.filter((item) => item.id !== session.id) } : current)
      onNotice('指定设备会话已下线。')
      await onChanged()
    } catch (reason) {
      onError(userErrorMessage(reason, '设备下线失败。'))
    } finally {
      setBusy('')
    }
  }

  async function deleteAccount() {
    const confirmation = window.prompt(`永久删除会清除“${user.username}”的阅读进度、时长和收藏。请输入用户名确认：`)
    if (confirmation !== user.username) return
    setBusy('delete')
    onError('')
    try {
      await api.deleteUser(user.id)
      onDeleted(user.id)
      onNotice(`账号“${user.username}”已永久删除；导入和安全审计记录已保留。`)
    } catch (reason) {
      onError(userErrorMessage(reason, '账号删除失败。'))
    } finally {
      setBusy('')
    }
  }

  return (
    <article className={`user-management-card${disabled ? ' disabled' : ''}`}>
      <header className="user-card-heading">
        <div className="user-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</div>
        <span className="auth-source-badge">{authSourceLabel(user.authSource)}</span>
        <div><strong>{user.username}</strong><span>{roleLabel(user.role)}{isCurrent ? ' · 当前账号' : ''}</span></div>
        <span className={`account-status ${disabled ? 'disabled' : 'active'}`}>{disabled ? '已禁用' : user.activeSessionCount > 0 ? `${user.activeSessionCount} 个会话` : '可登录'}</span>
      </header>

      <div className="user-activity-grid">
        <div><strong>{user.readingBookCount}</strong><span>读过书籍</span></div>
        <div><strong>{formatDuration(user.totalActiveSeconds)}</strong><span>累计阅读</span></div>
        <div><strong>{user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : '从未'}</strong><span>最近登录{user.lastLoginIp ? ` · ${user.lastLoginIp}` : ''}</span></div>
        <div><strong>{formatDateTime(user.createdAt)}</strong><span>创建时间</span></div>
      </div>

      <div className="user-profile-form">
        <label><span>用户名</span><input value={username} maxLength={64} onChange={(event) => setUsername(event.target.value)} /></label>
        <label><span>角色</span><select value={role} disabled={isCurrent} onChange={(event) => setRole(event.target.value as Role)}><option value="reader">阅读者</option><option value="admin">管理员</option></select></label>
        <button className="secondary" type="button" disabled={!profileChanged || Boolean(busy)} onClick={() => void saveProfile()}>{busy === 'profile' ? '保存中…' : '保存资料'}</button>
        <button className="secondary" type="button" disabled={isCurrent || Boolean(busy)} onClick={() => void toggleDisabled()}>{busy === 'status' ? '处理中…' : disabled ? '恢复登录' : '禁止登录'}</button>
      </div>

      <form className="user-password-form" onSubmit={resetPassword}>
        <label><span>重置密码</span><input type="password" autoComplete="new-password" minLength={12} placeholder="输入至少 12 位新密码" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
        <button className="secondary" type="submit" disabled={Boolean(busy)}>{busy === 'password' ? '重置中…' : '重置并下线'}</button>
      </form>

      <div className="user-card-actions">
        <button className="secondary" type="button" onClick={() => void toggleAccess()}>{expanded ? '收起登录信息' : '查看登录信息'}</button>
        <button className="secondary" type="button" disabled={Boolean(busy) || user.activeSessionCount === 0} onClick={() => void revokeAllSessions()}>{busy === 'sessions' ? '下线中…' : '全部设备下线'}</button>
        <button className="danger-button" type="button" disabled={isCurrent || Boolean(busy)} onClick={() => void deleteAccount()}>{busy === 'delete' ? '删除中…' : '永久删除'}</button>
      </div>

      {expanded && (
        <div className="user-access-panel">
          <div className="access-section-heading"><strong>有效会话</strong><button className="quiet" type="button" disabled={loadingAccess} onClick={() => void loadAccess()}>{loadingAccess ? '刷新中…' : '刷新'}</button></div>
          {loadingAccess && !access && <p className="muted">正在加载登录信息…</p>}
          {access && access.sessions.length === 0 && <p className="muted">当前没有有效会话。</p>}
          {access?.sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <span><strong>{deviceLabel(session.userAgent)}{session.current ? ' · 当前会话' : ''}</strong><small title={session.userAgent}>{session.clientIp || '未知地址'} · 登录于 {formatDateTime(session.createdAt)} · 活动于 {formatRelativeTime(session.lastSeenAt)}</small></span>
              <button className="quiet danger-text" type="button" disabled={Boolean(busy)} onClick={() => void revokeSession(session)}>{busy === `session-${session.id}` ? '下线中…' : '下线'}</button>
            </div>
          ))}

          <div className="access-section-heading recent-logins-heading"><strong>最近成功登录</strong><span>最多 20 条</span></div>
          {access && access.recentLogins.length === 0 && <p className="muted">暂无成功登录记录。</p>}
          {access?.recentLogins.map((login, index) => (
            <div className="login-event-row" key={`${login.createdAt}-${index}`}><span>{login.clientIp || '未知地址'}</span><time dateTime={login.createdAt}>{formatDateTime(login.createdAt)}</time></div>
          ))}
        </div>
      )}
    </article>
  )
}

function roleLabel(role: Role): string {
  return role === 'admin' ? '管理员' : '阅读者'
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function authSourceLabel(source?: ManagedUser['authSource']): string {
  if (source === 'oidc') return 'OIDC'
  if (source === 'ldap') return 'LDAP'
  return '本地'
}

function deviceLabel(userAgent: string): string {
  if (!userAgent) return '未知设备'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '浏览器'
  const system = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '未知系统'
  return `${browser} · ${system}`
}

function userErrorMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof APIError)) return fallback
  const messages: Record<string, string> = {
    invalid_username: '用户名只能包含字母、数字、中文、点、下划线或连字符，且不能以符号开头。',
    invalid_user: '用户名或角色不符合要求。',
    weak_password: '密码至少需要 12 位。',
    user_not_created: '用户名已存在，或输入不符合要求。',
    last_active_admin: '必须至少保留一个可登录的管理员。',
    cannot_change_current_admin: '当前管理员不能禁用或降级自己。',
    cannot_delete_current_user: '当前管理员不能删除自己的账号。',
    user_not_found: '该用户已不存在，请刷新列表。',
    session_not_found: '该会话已失效，请刷新登录信息。',
  }
  return messages[reason.code] ?? reason.message ?? fallback
}
