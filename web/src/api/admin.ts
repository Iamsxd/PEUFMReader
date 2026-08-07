import type { AuditEvent, BackgroundJob, BatchMetadataPatch, BibliographyProbeResponse, BibliographySearchResult, BibliographySource, BibliographySourceInput, BookPermission, CalibreImportResult, CalibrePreview, Category, ClassificationRule, DuplicateCatalogGroup, GroupLibraryPermission, ImportBatch, ImportBatchDetail, ImportBatchPage, ImportJob, ImportSource, LibraryGroup, ManagedUser, OperationsOverview, ReviewInput, ReviewItem, ReviewQueuePage, ReviewQueueQuery, Role, StorageAuditReport, User, UserAccessInfo, UserGroup } from '../types'
import { querySuffix, transport } from './core'

export const adminAPI = {
  async listAdminCategories(): Promise<Category[]> {
    const result = await transport.request<{ items: Category[] }>('/api/v1/admin/categories')
    return result.items
  },
  createCategory(input: { slug: string; name: string; parentId?: number }): Promise<Category> {
    return transport.request('/api/v1/admin/categories', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  updateCategory(categoryID: number, input: { name: string; parentId?: number; active: boolean }): Promise<Category> {
    return transport.request(`/api/v1/admin/categories/${categoryID}`, { method: 'PATCH', body: JSON.stringify({ ...input, parentId: input.parentId ?? null }), headers: { 'Content-Type': 'application/json' } })
  },
  async listClassificationRules(): Promise<ClassificationRule[]> {
    const result = await transport.request<{ items: ClassificationRule[] }>('/api/v1/admin/classification-rules')
    return result.items
  },
  updateClassificationRule(ruleID: number, input: Pick<ClassificationRule, 'keywords' | 'strongKeywords' | 'enabled' | 'priority'>): Promise<ClassificationRule> {
    return transport.request(`/api/v1/admin/classification-rules/${ruleID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  reclassifyUnclassified(): Promise<{ job: BackgroundJob; created: boolean }> {
    return transport.request('/api/v1/admin/classification/reclassify', { method: 'POST', body: JSON.stringify({ scope: 'unclassified' }), headers: { 'Content-Type': 'application/json' } })
  },
  batchUpdateMetadata(input: BatchMetadataPatch): Promise<{ updated: number }> {
    return transport.request('/api/v1/admin/metadata/batch', { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  async listDuplicateCatalogGroups(): Promise<DuplicateCatalogGroup[]> {
    const result = await transport.request<{ items: DuplicateCatalogGroup[] }>('/api/v1/admin/catalog/duplicates')
    return result.items
  },
  mergeWorks(sourceId: number, targetId: number): Promise<void> {
    return transport.request('/api/v1/admin/catalog/merge-works', { method: 'POST', body: JSON.stringify({ sourceId, targetId }), headers: { 'Content-Type': 'application/json' } })
  },
  mergeEditions(sourceId: number, targetId: number): Promise<void> {
    return transport.request('/api/v1/admin/catalog/merge-editions', { method: 'POST', body: JSON.stringify({ sourceId, targetId }), headers: { 'Content-Type': 'application/json' } })
  },
  listReviewQueue(query: ReviewQueueQuery = {}): Promise<ReviewQueuePage> {
    return transport.request(`/api/v1/review-queue${querySuffix(query)}`)
  },
  async getReviewQueueCount(): Promise<number> {
    const result = await transport.request<{ total: number }>('/api/v1/review-queue/count')
    return result.total
  },
  getEditionReview(editionID: number): Promise<ReviewItem> {
    return transport.request(`/api/v1/editions/${editionID}/review`)
  },
  reviewEdition(editionID: number, input: ReviewInput): Promise<ReviewItem> {
    return transport.request(`/api/v1/editions/${editionID}/review`, { method: 'PUT', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  aiClassifyEdition(editionID: number): Promise<ReviewItem> {
    return transport.request(`/api/v1/editions/${editionID}/ai-classify`, { method: 'POST' })
  },
  searchBibliography(editionID: number): Promise<BibliographySearchResult> {
    return transport.request(`/api/v1/editions/${editionID}/bibliography-search`, { method: 'POST' })
  },
  async listBibliographySources(): Promise<BibliographySource[]> {
    const result = await transport.request<{ items: BibliographySource[] }>('/api/v1/admin/bibliography-sources')
    return result.items
  },
  updateBibliographySource(sourceID: number, input: BibliographySourceInput): Promise<BibliographySource> {
    return transport.request(`/api/v1/admin/bibliography-sources/${sourceID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  testBibliographySource(sourceID: number): Promise<BibliographyProbeResponse> {
    return transport.request(`/api/v1/admin/bibliography-sources/${sourceID}/test`, { method: 'POST' })
  },
  async listImportJobs(): Promise<ImportJob[]> {
    const result = await transport.request<{ items: ImportJob[] }>('/api/v1/import-jobs')
    return result.items
  },
  createImportBatch(totalItems: number): Promise<ImportBatch> {
    return transport.request('/api/v1/import-batches', { method: 'POST', body: JSON.stringify({ totalItems }), headers: { 'Content-Type': 'application/json' } })
  },
  listImportBatches(page = 1, pageSize = 12): Promise<ImportBatchPage> {
    return transport.request(`/api/v1/import-batches${querySuffix({ page, pageSize })}`)
  },
  getImportBatch(batchID: number): Promise<ImportBatchDetail> {
    return transport.request(`/api/v1/import-batches/${batchID}`)
  },
  deleteImportBatch(batchID: number): Promise<void> {
    return transport.request(`/api/v1/import-batches/${batchID}`, { method: 'DELETE' })
  },
  async listImportSources(): Promise<ImportSource[]> {
    const result = await transport.request<{ items: ImportSource[] }>('/api/v1/admin/import-sources')
    return result.items
  },
  async listBackgroundJobs(): Promise<BackgroundJob[]> {
    const result = await transport.request<{ items: BackgroundJob[] }>('/api/v1/background-jobs')
    return result.items
  },
  async listAuditEvents(): Promise<AuditEvent[]> {
    const result = await transport.request<{ items: AuditEvent[] }>('/api/v1/audit-events')
    return result.items
  },
  auditStorage(deep = false): Promise<StorageAuditReport> {
    return transport.request(`/api/v1/system/storage${deep ? '?deep=true' : ''}`)
  },
  getOperationsOverview(): Promise<OperationsOverview> {
    return transport.request('/api/v1/admin/operations/overview')
  },
  retryBackgroundJob(jobID: number): Promise<BackgroundJob> {
    return transport.request(`/api/v1/background-jobs/${jobID}/retry`, { method: 'POST' })
  },
  previewCalibre(): Promise<CalibrePreview> {
    return transport.request('/api/v1/calibre/preview')
  },
  importCalibre(sourcePaths: string[] = []): Promise<CalibreImportResult> {
    return transport.request('/api/v1/calibre/import', { method: 'POST', body: JSON.stringify({ sourcePaths }), headers: { 'Content-Type': 'application/json' } })
  },
  syncCalibreReferences(): Promise<{ job: BackgroundJob; created: boolean }> {
    return transport.request('/api/v1/calibre/references/sync', { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } })
  },
  async listUsers(): Promise<ManagedUser[]> {
    const result = await transport.request<{ items: ManagedUser[] }>('/api/v1/users')
    return result.items
  },
  createUser(username: string, password: string, role: 'admin' | 'reader'): Promise<User> {
    return transport.request('/api/v1/users', { method: 'POST', body: JSON.stringify({ username, password, role }), headers: { 'Content-Type': 'application/json' } })
  },
  updateUser(userID: number, input: { username: string; role: Role; disabled: boolean }): Promise<ManagedUser> {
    return transport.request(`/api/v1/users/${userID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  getUserAccess(userID: number): Promise<UserAccessInfo> {
    return transport.request(`/api/v1/users/${userID}/access`)
  },
  async listUserBookPermissions(userID: number): Promise<BookPermission[]> {
    const result = await transport.request<{ items: BookPermission[] }>(`/api/v1/users/${userID}/book-permissions`)
    return result.items
  },
  setUserBookPermission(userID: number, bookFileID: number, canRead: boolean): Promise<BookPermission> {
    return transport.request(`/api/v1/users/${userID}/book-permissions/${bookFileID}`, { method: 'PUT', body: JSON.stringify({ canRead }), headers: { 'Content-Type': 'application/json' } })
  },
  deleteUserBookPermission(userID: number, bookFileID: number): Promise<void> {
    return transport.request(`/api/v1/users/${userID}/book-permissions/${bookFileID}`, { method: 'DELETE' })
  },
  async listUserGroups(): Promise<UserGroup[]> {
    const result = await transport.request<{ items: UserGroup[] }>('/api/v1/admin/user-groups')
    return result.items
  },
  createUserGroup(input: Pick<UserGroup, 'name' | 'description'>): Promise<UserGroup> {
    return transport.request('/api/v1/admin/user-groups', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  updateUserGroup(groupID: number, input: Pick<UserGroup, 'name' | 'description'>): Promise<UserGroup> {
    return transport.request(`/api/v1/admin/user-groups/${groupID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  deleteUserGroup(groupID: number): Promise<void> {
    return transport.request(`/api/v1/admin/user-groups/${groupID}`, { method: 'DELETE' })
  },
  setUserGroupMember(groupID: number, userID: number, member: boolean): Promise<void> {
    return transport.request(`/api/v1/admin/user-groups/${groupID}/members/${userID}`, { method: member ? 'PUT' : 'DELETE' })
  },
  async listLibraryGroups(): Promise<LibraryGroup[]> {
    const result = await transport.request<{ items: LibraryGroup[] }>('/api/v1/admin/library-groups')
    return result.items
  },
  createLibraryGroup(input: Pick<LibraryGroup, 'name' | 'description' | 'defaultAccess'>): Promise<LibraryGroup> {
    return transport.request('/api/v1/admin/library-groups', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  updateLibraryGroup(groupID: number, input: Pick<LibraryGroup, 'name' | 'description' | 'defaultAccess'>): Promise<LibraryGroup> {
    return transport.request(`/api/v1/admin/library-groups/${groupID}`, { method: 'PATCH', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })
  },
  deleteLibraryGroup(groupID: number): Promise<void> {
    return transport.request(`/api/v1/admin/library-groups/${groupID}`, { method: 'DELETE' })
  },
  setLibraryGroupBook(groupID: number, bookFileID: number, member: boolean): Promise<void> {
    return transport.request(`/api/v1/admin/library-groups/${groupID}/books/${bookFileID}`, { method: member ? 'PUT' : 'DELETE' })
  },
  async listGroupLibraryPermissions(): Promise<GroupLibraryPermission[]> {
    const result = await transport.request<{ items: GroupLibraryPermission[] }>('/api/v1/admin/group-library-permissions')
    return result.items
  },
  setGroupLibraryPermission(userGroupID: number, libraryGroupID: number, canRead: boolean): Promise<GroupLibraryPermission> {
    return transport.request(`/api/v1/admin/user-groups/${userGroupID}/library-permissions/${libraryGroupID}`, { method: 'PUT', body: JSON.stringify({ canRead }), headers: { 'Content-Type': 'application/json' } })
  },
  deleteGroupLibraryPermission(userGroupID: number, libraryGroupID: number): Promise<void> {
    return transport.request(`/api/v1/admin/user-groups/${userGroupID}/library-permissions/${libraryGroupID}`, { method: 'DELETE' })
  },
  resetUserPassword(userID: number, password: string): Promise<void> {
    return transport.request(`/api/v1/users/${userID}/password`, { method: 'POST', body: JSON.stringify({ password }), headers: { 'Content-Type': 'application/json' } })
  },
  revokeUserSessions(userID: number): Promise<void> {
    return transport.request(`/api/v1/users/${userID}/sessions`, { method: 'DELETE' })
  },
  revokeUserSession(userID: number, sessionID: number): Promise<void> {
    return transport.request(`/api/v1/users/${userID}/sessions/${sessionID}`, { method: 'DELETE' })
  },
  deleteUser(userID: number): Promise<void> {
    return transport.request(`/api/v1/users/${userID}`, { method: 'DELETE' })
  },
}
