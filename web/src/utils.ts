export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  return `${minutes} 分钟`
}

export function formatRelativeTime(value: string | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000))
  if (!Number.isFinite(elapsedSeconds) || Number.isNaN(date.getTime())) return ''
  if (elapsedSeconds < 60) return '刚刚'
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)} 分钟前`
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)} 小时前`
  if (elapsedSeconds < 86400 * 30) return `${Math.floor(elapsedSeconds / 86400)} 天前`
  return date.toLocaleDateString('zh-CN')
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
