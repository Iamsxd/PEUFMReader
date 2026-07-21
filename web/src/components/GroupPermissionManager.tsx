import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { APIError, api } from '../api'
import type { BookFile, GroupLibraryPermission, LibraryGroup, ManagedUser, UserGroup } from '../types'

interface Props {
  users: ManagedUser[]
  onError: (message: string) => void
  onNotice: (message: string) => void
}

export function GroupPermissionManager({ users, onError, onNotice }: Props) {
  const [userGroups, setUserGroups] = useState<UserGroup[]>([])
  const [libraryGroups, setLibraryGroups] = useState<LibraryGroup[]>([])
  const [permissions, setPermissions] = useState<GroupLibraryPermission[]>([])
  const [userGroupName, setUserGroupName] = useState('')
  const [libraryGroupName, setLibraryGroupName] = useState('')
  const [libraryDefaultAccess, setLibraryDefaultAccess] = useState(false)
  const [selectedLibraryGroupID, setSelectedLibraryGroupID] = useState(0)
  const [bookQuery, setBookQuery] = useState('')
  const [books, setBooks] = useState<BookFile[]>([])
  const [busy, setBusy] = useState('')

  async function refresh() {
    const [nextUserGroups, nextLibraryGroups, nextPermissions] = await Promise.all([
      api.listUserGroups(), api.listLibraryGroups(), api.listGroupLibraryPermissions(),
    ])
    setUserGroups(nextUserGroups)
    setLibraryGroups(nextLibraryGroups)
    setPermissions(nextPermissions)
    setSelectedLibraryGroupID((current) => nextLibraryGroups.some((group) => group.id === current) ? current : nextLibraryGroups[0]?.id || 0)
  }

  useEffect(() => {
    void refresh().catch((reason) => onError(errorMessage(reason)))
  }, [])

  async function createUserGroup(event: FormEvent) {
    event.preventDefault()
    await run('create-user-group', async () => {
      await api.createUserGroup({ name: userGroupName, description: '' })
      setUserGroupName('')
      await refresh()
      onNotice('用户组已创建。')
    })
  }

  async function createLibraryGroup(event: FormEvent) {
    event.preventDefault()
    await run('create-library-group', async () => {
      const created = await api.createLibraryGroup({ name: libraryGroupName, description: '', defaultAccess: libraryDefaultAccess })
      setLibraryGroupName('')
      setSelectedLibraryGroupID(created.id)
      await refresh()
      onNotice('书库组已创建。')
    })
  }

  async function editUserGroup(group: UserGroup) {
    const name = window.prompt('用户组名称', group.name)?.trim()
    if (!name) return
    const description = window.prompt('用户组说明', group.description) ?? group.description
    await run(`edit-user-${group.id}`, async () => {
      await api.updateUserGroup(group.id, { name, description })
      await refresh()
      onNotice('用户组资料已更新。')
    })
  }

  async function editLibraryGroup(group: LibraryGroup) {
    const name = window.prompt('书库组名称', group.name)?.trim()
    if (!name) return
    const description = window.prompt('书库组说明', group.description) ?? group.description
    await run(`edit-library-${group.id}`, async () => {
      await api.updateLibraryGroup(group.id, { name, description, defaultAccess: group.defaultAccess })
      await refresh()
      onNotice('书库组资料已更新。')
    })
  }

  async function toggleUser(group: UserGroup, userID: number) {
    const member = !group.memberIds.includes(userID)
    await run(`member-${group.id}-${userID}`, async () => {
      await api.setUserGroupMember(group.id, userID, member)
      await refresh()
      onNotice(member ? '用户已加入用户组。' : '用户已移出用户组。')
    })
  }

  async function toggleLibraryDefault(group: LibraryGroup) {
    await run(`default-${group.id}`, async () => {
      await api.updateLibraryGroup(group.id, {
        name: group.name, description: group.description, defaultAccess: !group.defaultAccess,
      })
      await refresh()
      onNotice(`“${group.name}”已设为${group.defaultAccess ? '默认受限' : '默认公开'}。`)
    })
  }

  async function removeUserGroup(group: UserGroup) {
    if (!window.confirm(`删除用户组“${group.name}”？其书库授权也会删除。`)) return
    await run(`delete-user-${group.id}`, async () => {
      await api.deleteUserGroup(group.id)
      await refresh()
      onNotice('用户组已删除。')
    })
  }

  async function removeLibraryGroup(group: LibraryGroup) {
    if (!window.confirm(`删除书库组“${group.name}”？书籍本身不会被删除。`)) return
    await run(`delete-library-${group.id}`, async () => {
      await api.deleteLibraryGroup(group.id)
      setSelectedLibraryGroupID(0)
      await refresh()
      onNotice('书库组已删除，书籍文件不受影响。')
    })
  }

  async function searchBooks() {
    await run('search-books', async () => {
      const result = await api.listBooks({ q: bookQuery, pageSize: 30, sort: bookQuery ? 'relevance' : 'title' })
      setBooks(result.items)
    })
  }

  async function toggleBook(bookID: number) {
    const group = libraryGroups.find((item) => item.id === selectedLibraryGroupID)
    if (!group) return
    const member = !group.bookFileIds.includes(bookID)
    await run(`book-${group.id}-${bookID}`, async () => {
      await api.setLibraryGroupBook(group.id, bookID, member)
      await refresh()
      onNotice(member ? '书籍已加入书库组。' : '书籍已移出书库组。')
    })
  }

  async function changePermission(userGroupID: number, libraryGroupID: number, value: string) {
    await run(`permission-${userGroupID}-${libraryGroupID}`, async () => {
      if (value === 'default') {
        await api.deleteGroupLibraryPermission(userGroupID, libraryGroupID).catch((reason) => {
          if (!(reason instanceof APIError) || reason.code !== 'group_permission_not_found') throw reason
        })
      } else {
        await api.setGroupLibraryPermission(userGroupID, libraryGroupID, value === 'allow')
      }
      await refresh()
      onNotice('用户组的书库权限已更新。')
    })
  }

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    onError('')
    try {
      await action()
    } catch (reason) {
      onError(errorMessage(reason))
    } finally {
      setBusy('')
    }
  }

  const selectedLibraryGroup = libraryGroups.find((group) => group.id === selectedLibraryGroupID)
  const permissionMap = useMemo(() => new Map(permissions.map((item) => [
    `${item.userGroupId}:${item.libraryGroupId}`, item.canRead ? 'allow' : 'deny',
  ])), [permissions])

  return (
    <section className="group-permission-panel" data-testid="group-permission-manager">
      <div className="section-title"><div><p className="eyebrow">分组权限</p><h3>书库组与用户组</h3><p className="muted">受限书库组默认隐藏；用户组规则按书库批量授权。发生冲突时：单书规则优先，其次拒绝、允许、书库默认值；管理员始终可见。</p></div></div>

      <div className="access-group-columns">
        <section className="access-group-section">
          <header><div><strong>用户组</strong><span>{userGroups.length} 组</span></div></header>
          <form className="inline-group-form" onSubmit={(event) => void createUserGroup(event)}>
            <input aria-label="新用户组名称" maxLength={80} placeholder="例如：家庭成员" value={userGroupName} onChange={(event) => setUserGroupName(event.target.value)} required />
            <button className="secondary" disabled={Boolean(busy)} type="submit">创建</button>
          </form>
          <div className="access-group-list">
            {userGroups.length === 0 && <p className="muted">尚未创建用户组。</p>}
            {userGroups.map((group) => <article key={group.id}>
              <header><div><strong>{group.name}</strong><small>{group.memberCount} 位成员{group.description ? ` · ${group.description}` : ''}</small></div><span><button className="quiet" type="button" onClick={() => void editUserGroup(group)}>编辑</button><button className="quiet danger-text" type="button" onClick={() => void removeUserGroup(group)}>删除</button></span></header>
              <div className="membership-chips" aria-label={`${group.name}成员`}>
                {users.map((user) => <button key={user.id} className={group.memberIds.includes(user.id) ? 'selected' : ''} disabled={busy === `member-${group.id}-${user.id}`} type="button" onClick={() => void toggleUser(group, user.id)}>{user.username}</button>)}
              </div>
            </article>)}
          </div>
        </section>

        <section className="access-group-section">
          <header><div><strong>书库组</strong><span>{libraryGroups.length} 组</span></div></header>
          <form className="inline-group-form library-group-form" onSubmit={(event) => void createLibraryGroup(event)}>
            <input aria-label="新书库组名称" maxLength={80} placeholder="例如：儿童书库" value={libraryGroupName} onChange={(event) => setLibraryGroupName(event.target.value)} required />
            <label><input type="checkbox" checked={libraryDefaultAccess} onChange={(event) => setLibraryDefaultAccess(event.target.checked)} />默认公开</label>
            <button className="secondary" disabled={Boolean(busy)} type="submit">创建</button>
          </form>
          <div className="access-group-list">
            {libraryGroups.length === 0 && <p className="muted">尚未创建书库组。</p>}
            {libraryGroups.map((group) => <article key={group.id}>
              <header><div><strong>{group.name}</strong><small>{group.bookCount} 本书{group.description ? ` · ${group.description}` : ''}</small></div><span><button className={`access-mode-badge ${group.defaultAccess ? 'public' : 'restricted'}`} type="button" onClick={() => void toggleLibraryDefault(group)}>{group.defaultAccess ? '默认公开' : '默认受限'}</button><button className="quiet" type="button" onClick={() => void editLibraryGroup(group)}>编辑</button><button className="quiet danger-text" type="button" onClick={() => void removeLibraryGroup(group)}>删除</button></span></header>
            </article>)}
          </div>
        </section>
      </div>

      <section className="permission-matrix-section">
        <header><div><strong>用户组 × 书库组</strong><span>默认表示采用书库组的公开/受限设置</span></div></header>
        {userGroups.length > 0 && libraryGroups.length > 0 ? <div className="permission-matrix-scroll"><table className="permission-matrix"><thead><tr><th>用户组</th>{libraryGroups.map((group) => <th key={group.id}>{group.name}<small>{group.defaultAccess ? '公开' : '受限'}</small></th>)}</tr></thead><tbody>{userGroups.map((userGroup) => <tr key={userGroup.id}><th>{userGroup.name}</th>{libraryGroups.map((libraryGroup) => {
          const key = `${userGroup.id}:${libraryGroup.id}`
          return <td key={libraryGroup.id}><select aria-label={`${userGroup.name}访问${libraryGroup.name}`} disabled={busy === `permission-${key}`} value={permissionMap.get(key) ?? 'default'} onChange={(event) => void changePermission(userGroup.id, libraryGroup.id, event.target.value)}><option value="default">采用默认</option><option value="allow">允许</option><option value="deny">拒绝</option></select></td>
        })}</tr>)}</tbody></table></div> : <p className="muted">创建至少一个用户组和书库组后即可配置批量权限。</p>}
      </section>

      <section className="library-group-books-section">
        <header><div><strong>书库组书籍</strong><span>搜索后勾选加入或移出</span></div></header>
        <div className="permission-toolbar">
          <label><span>书库组</span><select value={selectedLibraryGroupID} onChange={(event) => setSelectedLibraryGroupID(Number(event.target.value))}><option value={0}>请选择</option>{libraryGroups.map((group) => <option key={group.id} value={group.id}>{group.name}（{group.bookCount} 本）</option>)}</select></label>
          <label><span>搜索书籍</span><input value={bookQuery} onChange={(event) => setBookQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchBooks() }} placeholder="书名、作者、ISBN" /></label>
          <button className="secondary" disabled={!selectedLibraryGroupID || busy === 'search-books'} type="button" onClick={() => void searchBooks()}>查询</button>
        </div>
        {books.length > 0 && selectedLibraryGroup && <div className="permission-book-list">{books.map((book) => <label key={book.id}><input type="checkbox" checked={selectedLibraryGroup.bookFileIds.includes(book.id)} disabled={busy === `book-${selectedLibraryGroup.id}-${book.id}`} onChange={() => void toggleBook(book.id)} /><span><strong>{book.title}</strong><small>{book.authors.join('、') || book.originalFilename}</small></span></label>)}</div>}
      </section>
    </section>
  )
}

function errorMessage(reason: unknown): string {
  return reason instanceof APIError ? reason.message : '分组权限更新失败。'
}
