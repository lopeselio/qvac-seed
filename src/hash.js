import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Hash a readable stream with SHA-256 without buffering it in memory.
 * Model files are multi-GB, so everything here is streaming.
 * @param {AsyncIterable<Buffer>} stream
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function hashStream (stream) {
  const h = createHash('sha256')
  let size = 0
  for await (const chunk of stream) {
    h.update(chunk)
    size += chunk.length
  }
  return { sha256: h.digest('hex'), size }
}

/** @param {string} file */
export function hashFile (file) {
  return hashStream(createReadStream(file))
}
