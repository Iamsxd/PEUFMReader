import { describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { hashBlob, HASH_CHUNK_BYTES } from './uploadHash'
import { runUploadQueue } from './uploadPreflight'
import type { UploadBookResult } from './api/catalog'

const result = (duplicate = false) => ({ duplicate, bookFile: { id: 1 }, importJobId: 1 }) as UploadBookResult
const file = (name: string, content: string) => new File([content], name)
function dependencies(matchingSizes: number[] = []) {
  return {
    preflight: vi.fn(async () => ({ matchingSizes })),
    hash: vi.fn((file: File, progress: (percent: number) => void) => hashBlob(file, progress)),
    skip: vi.fn(async () => ({ duplicate: false as const } as UploadBookResult | { duplicate: false })),
    upload: vi.fn(async () => result()),
    checking: vi.fn(), fallback: vi.fn(), completed: vi.fn(), failed: vi.fn(),
  }
}

describe('upload preflight', () => {
  it('hashes bounded slices and matches a known SHA-256 vector', async () => {
    expect(await hashBlob(new Blob(['abc']), () => {})).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const bytes = new Uint8Array(HASH_CHUNK_BYTES * 2 + 13).fill(71)
    const blob = new Blob([bytes])
    const wholeRead = vi.spyOn(blob, 'arrayBuffer')
    const slice = vi.spyOn(blob, 'slice')
    const progress = vi.fn()
    expect(await hashBlob(blob, progress)).toBe(bytesToHex(sha256(bytes)))
    expect(wholeRead).not.toHaveBeenCalled()
    expect(slice).toHaveBeenCalledTimes(3)
    for (const [start, end] of slice.mock.calls) expect(end! - start!).toBeLessThanOrEqual(HASH_CHUNK_BYTES)
    expect(progress).toHaveBeenLastCalledWith(100)
  })

  it('does not read files when their size has no match', async () => {
    const deps = dependencies()
    await runUploadQueue([{ id: '0', file: file('new.pdf', 'abc') }], deps)
    expect(deps.hash).not.toHaveBeenCalled()
    expect(deps.upload).toHaveBeenCalledTimes(1)
  })

  it('skips an exact renamed duplicate without uploading bytes', async () => {
    const deps = dependencies([3])
    deps.skip.mockResolvedValue(result(true))
    await runUploadQueue([{ id: '0', file: file('renamed.pdf', 'abc') }], deps)
    expect(deps.upload).not.toHaveBeenCalled()
    expect(deps.completed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duplicate: true }), true)
  })

  it('uploads same-name/same-size different content and serializes in-batch copies', async () => {
    const deps = dependencies()
    const stored = new Set<string>()
    deps.skip.mockImplementation(async (...args: unknown[]) => stored.has(args[1] as string) ? result(true) : { duplicate: false })
    deps.upload.mockImplementation(async (...args: unknown[]) => {
      stored.add(await hashBlob((args[0] as { file: File }).file, () => {}))
      return result()
    })
    await runUploadQueue([
      { id: '0', file: file('same.pdf', 'abc') },
      { id: '1', file: file('same.pdf', 'def') },
      { id: '2', file: file('renamed.pdf', 'abc') },
    ], deps)
    expect(deps.upload).toHaveBeenCalledTimes(2)
    expect(deps.completed).toHaveBeenCalledTimes(3)
    expect(deps.completed).toHaveBeenLastCalledWith(expect.objectContaining({ id: '2' }), expect.objectContaining({ duplicate: true }), true)
  })

  it('falls back when local hashing is unavailable', async () => {
    const deps = dependencies([3])
    deps.hash.mockRejectedValue(new Error('worker unavailable'))
    await runUploadQueue([{ id: '0', file: file('new.pdf', 'abc') }], deps)
    expect(deps.fallback).toHaveBeenCalledTimes(1)
    expect(deps.upload).toHaveBeenCalledTimes(1)
  })

  it('falls back for the whole batch when preflight is unavailable', async () => {
    const deps = dependencies()
    deps.preflight.mockRejectedValue(new Error('preflight unavailable'))
    await runUploadQueue([{ id: '0', file: file('a.pdf', 'abc') }, { id: '1', file: file('b.pdf', 'abc') }], deps)
    expect(deps.hash).not.toHaveBeenCalled()
    expect(deps.skip).not.toHaveBeenCalled()
    expect(deps.upload).toHaveBeenCalledTimes(2)
    expect(deps.fallback).toHaveBeenCalledTimes(2)
  })

  it('retries a lost confirmation without uploading or duplicating the report key', async () => {
    const deps = dependencies([3])
    deps.skip.mockRejectedValueOnce(new Error('lost response')).mockResolvedValue(result(true))
    await runUploadQueue([{ id: '0', file: file('same.pdf', 'abc') }], deps)
    expect(deps.skip).toHaveBeenCalledTimes(2)
    expect(deps.skip.mock.calls[0]).toEqual(deps.skip.mock.calls[1])
    expect(deps.upload).not.toHaveBeenCalled()
  })
})
