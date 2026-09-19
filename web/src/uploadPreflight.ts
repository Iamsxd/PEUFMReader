import type { UploadBookResult } from './api/catalog'

// Serialize local hashing to bound CPU/memory independently of upload parallelism.
let hashQueue: Promise<unknown> = Promise.resolve()
export function hashUpload(file: File, onProgress: (percent: number) => void): Promise<string> {
  const result = hashQueue.then(() => new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('./uploadHash.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => { clearTimeout(timeout); worker.terminate() }
    const timeout = setTimeout(() => { finish(); reject(new Error('本地校验超时')) }, 10 * 60 * 1000)
    worker.onerror = () => { finish(); reject(new Error('无法启动本地校验')) }
    worker.onmessage = (event: MessageEvent<{ hash?: string; progress?: number; error?: string }>) => {
      if (event.data.error) { finish(); reject(new Error(event.data.error)) }
      else if (event.data.hash) { finish(); resolve(event.data.hash) }
      else if (event.data.progress !== undefined) onProgress(event.data.progress)
    }
    try { worker.postMessage(file) } catch (reason) { finish(); reject(reason) }
  }))
  hashQueue = result.catch(() => {})
  return result
}

export interface QueuedUpload { id: string; file: File }
interface UploadDependencies {
  preflight(sizes: number[]): Promise<{ matchingSizes: number[] }>
  hash(file: File, progress: (percent: number) => void): Promise<string>
  skip(file: File, hash: string, itemKey: string): Promise<UploadBookResult | { duplicate: false }>
  upload(item: QueuedUpload): Promise<UploadBookResult>
  checking(item: QueuedUpload, progress: number): void
  fallback(item: QueuedUpload): void
  completed(item: QueuedUpload, result: UploadBookResult, skipped: boolean): void
  failed(item: QueuedUpload, reason: unknown): void
}

export async function runUploadQueue(items: QueuedUpload[], deps: UploadDependencies): Promise<void> {
  const groups = new Map<number, QueuedUpload[]>()
  for (const item of items) groups.set(item.file.size, [...(groups.get(item.file.size) ?? []), item])
  let matchingSizes: Set<number>
  let preflightAvailable = true
  try {
    matchingSizes = new Set((await deps.preflight([...groups.keys()])).matchingSizes)
  } catch {
    // Normal upload still verifies content on the server if preflight is unavailable.
    matchingSizes = new Set()
    preflightAvailable = false
    for (const item of items) deps.fallback(item)
  }
  const queue = [...groups.values()]
  let cursor = 0
  async function worker() {
    while (cursor < queue.length) {
      const group = queue[cursor++]
      // Equal-size files run sequentially so a duplicate in this batch can see
      // its predecessor's completed import, including renamed copies.
      for (const item of group) {
        try {
          if (preflightAvailable && (matchingSizes.has(item.file.size) || group.length > 1)) {
            let hash: string | undefined
            try {
              deps.checking(item, 0)
              hash = await deps.hash(item.file, (p) => deps.checking(item, p))
            } catch { deps.fallback(item) }
            // A lost confirmation response may already have saved a report.
            // Retry the same idempotent key; never start a second upload job.
            const skipped = hash ? await deps.skip(item.file, hash, item.id).catch(() => deps.skip(item.file, hash!, item.id)) : undefined
            if (skipped?.duplicate && 'bookFile' in skipped) {
              deps.completed(item, skipped, true)
              continue
            }
          }
          deps.completed(item, await deps.upload(item), false)
        } catch (reason) { deps.failed(item, reason) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, worker))
}
