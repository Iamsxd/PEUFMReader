import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const HASH_CHUNK_BYTES = 2 * 1024 * 1024

// This function runs in a worker in the app; Blob slices bound memory use even
// for very large PDFs. Incremental hashing also works on HTTP NAS origins.
export async function hashBlob(file: Blob, onProgress: (percent: number) => void): Promise<string> {
  const hash = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
      const end = Math.min(offset + HASH_CHUNK_BYTES, file.size)
      hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()))
      onProgress(Math.round(end / file.size * 100))
    }
    return bytesToHex(hash.digest())
  } finally {
    hash.destroy()
  }
}
