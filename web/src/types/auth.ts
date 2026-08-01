export type Role = 'admin' | 'reader'

export interface User {
  id: number
  username: string
  role: Role
  authSource?: 'local' | 'oidc' | 'ldap'
}

export interface ManagedUser extends User {
  createdAt: string
  disabledAt?: string
  lastLoginAt?: string
  lastLoginIp: string
  lastSeenAt?: string
  activeSessionCount: number
  readingBookCount: number
  totalActiveSeconds: number
}

export interface UserSessionInfo {
  id: number
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  clientIp: string
  userAgent: string
  current: boolean
}

export interface UserLoginEvent {
  createdAt: string
  clientIp: string
  statusCode: number
}

export interface UserAccessInfo {
  sessions: UserSessionInfo[]
  recentLogins: UserLoginEvent[]
}

export interface AuthProviders {
  oidc: boolean
  ldap: boolean
}

export interface BookPermission {
  userId: number
  bookFileId: number
  title: string
  canRead: boolean
  updatedAt: string
}

export interface UserGroup {
  id: number
  name: string
  description: string
  memberIds: number[]
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface LibraryGroup {
  id: number
  name: string
  description: string
  defaultAccess: boolean
  bookFileIds: number[]
  bookCount: number
  createdAt: string
  updatedAt: string
}

export interface GroupLibraryPermission {
  userGroupId: number
  libraryGroupId: number
  canRead: boolean
  updatedAt: string
}

export interface Session {
  user: User
  csrfToken: string
}

export interface DeviceToken {
  id: number
  name: string
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  token?: string
}
