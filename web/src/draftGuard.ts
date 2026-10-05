import { useCallback, useEffect, useRef } from 'react'

const guards = new Map<symbol, string>()
export function confirmLeaveDrafts(): boolean {
  if (!guards.size) return true
  if (!window.confirm('有未保存的草稿，确定放弃并离开吗？')) return false
  guards.clear()
  return true
}
export function useDraftGuard(dirty: boolean, description = '未保存的笔记') {
  const id = useRef(Symbol(description))
  useEffect(() => {
    if (!dirty) return
    const token = id.current
    guards.set(token, description)
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!guards.has(token)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { guards.delete(token); window.removeEventListener('beforeunload', beforeUnload) }
  // A confirmed replacement may keep the same component and dirty=true.
  // Re-register on its next render so the replacement draft remains guarded.
  })
  // A successful asynchronous save may navigate before React effect cleanup.
  // Release only this draft synchronously; do not suppress unrelated drafts.
  return useCallback(() => { guards.delete(id.current) }, [])
}
