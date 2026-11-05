import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import { hashFile } from './hash.js'
import {
  MANIFEST_PATH, emptyManifest, findEntry, parseManifest, serializeManifest, upsertEntry
} from './manifest.js'
import { formatPearUrl, toDrivePath } from './url.js'

export function defaultStoreDir () {
  return process.env.QVAC_SEED_HOME || join(homedir(), '.qvac-seed', 'store')
}

export function openStore (dir = defaultStoreDir()) {
  return new Corestore(dir)
}

/**
 * Open (or create) one of *your* writable drives. Each collection name maps
 * to a stable key derived from the store's primary key, so republishing to
 * the same name keeps the same pear:// links.
 */
const openDrives = new WeakMap()

export async function openWritableDrive (store, name = 'default') {
  // Opening a second Hyperdrive over the same namespace in one process
  // deadlocks on the underlying cores, so hand back the cached instance.
  let byName = openDrives.get(store)
  if (!byName) openDrives.set(store, (byName = new Map()))
  if (!byName.has(name)) {
    byName.set(name, (async () => {
      const drive = new Hyperdrive(store.namespace(`qvac-seed/${name}`))
      await drive.ready()
      return drive
    })())
  }
  return byName.get(name)
}

/** Open someone else's drive by key (read-only). */
export async function openRemoteDrive (store, key) {
  const drive = new Hyperdrive(store.session(), Buffer.from(key, 'hex'))
  await drive.ready()
  return drive
}

export async function readManifest (drive, { wait = true } = {}) {
  // A freshly opened remote drive has length 0 until it syncs with a peer.
  if (!drive.writable && wait) await drive.update({ wait: true })
  const buf = await drive.get(MANIFEST_PATH, { wait })
  return buf ? parseManifest(buf) : null
}

/**
 * Hash a local file, copy it into the drive and record it in the manifest.
 * @returns {Promise<{ url: string, entry: object }>}
 */
export async function publishFile (drive, file, { as, meta = {}, onProgress } = {}) {
  const path = toDrivePath(as ?? basename(file))
  const { size } = await stat(file)
  const { sha256 } = await hashFile(file)

  // Skip the copy if the drive already holds identical bytes.
  const current = (await readManifest(drive, { wait: false })) ?? emptyManifest(drive.name)
  const prev = findEntry(current, path)
  if (!prev || prev.sha256 !== sha256 || !(await drive.exists(path))) {
    let copied = 0
    const progress = new Transform({
      transform (chunk, _enc, cb) {
        copied += chunk.length
        onProgress?.({ path, copied, size })
        cb(null, chunk)
      }
    })
    await pipeline(createReadStream(file), progress, drive.createWriteStream(path))
  }

  const next = upsertEntry(current, { path, size, sha256, meta })
  await drive.put(MANIFEST_PATH, serializeManifest(next))
  return { url: formatPearUrl(drive.key, path), entry: findEntry(next, path) }
}

/**
 * Download a file from a drive to disk, verifying size and sha256 against the
 * manifest. Writes to a temp file and only renames on success, so a bad
 * download never leaves a plausible-looking model on disk.
 */
export async function fetchFile (drive, path, outFile, { onProgress, requireManifest = true } = {}) {
  const drivePath = toDrivePath(path)
  const manifest = await readManifest(drive)
  const entry = manifest && findEntry(manifest, drivePath)
  if (requireManifest && !entry) {
    throw new Error(`${drivePath} is not listed in the drive manifest (use --no-verify to skip)`)
  }
  const fileEntry = await drive.entry(drivePath, { wait: true })
  if (!fileEntry) throw new Error(`${drivePath} not found in drive`)

  await mkdir(dirname(outFile), { recursive: true })
  const tmp = `${outFile}.part`
  const h = createHash('sha256')
  let got = 0
  const total = entry?.size ?? fileEntry.value.blob?.byteLength ?? 0
  const tap = new Transform({
    transform (chunk, _enc, cb) {
      h.update(chunk)
      got += chunk.length
      onProgress?.({ path: drivePath, downloaded: got, size: total })
      cb(null, chunk)
    }
  })
  try {
    await pipeline(drive.createReadStream(drivePath, { wait: true }), tap, createWriteStream(tmp))
    const sha256 = h.digest('hex')
    if (entry && (entry.sha256 !== sha256 || entry.size !== got)) {
      throw new Error(`Integrity check failed for ${drivePath}: expected ${entry.sha256}, got ${sha256}`)
    }
    await rename(tmp, outFile)
    return { path: outFile, size: got, sha256, verified: Boolean(entry) }
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
