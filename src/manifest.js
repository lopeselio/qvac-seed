// Every drive published by qvac-seed carries /qvac-seed.json describing its
// files. Hyperdrive already authenticates every block against the drive key,
// so the manifest's sha256 is an end-to-end check that the file you got is the
// file the publisher hashed on their own disk (and lets you verify a copy you
// obtained elsewhere, e.g. over HTTP).

export const MANIFEST_PATH = '/qvac-seed.json'
export const MANIFEST_VERSION = 1

const HEX64 = /^[a-f0-9]{64}$/

/** Kinds help consumers decide how to load a file with the QVAC SDK. */
export function inferKind (path) {
  const p = path.toLowerCase()
  if (p.endsWith('.gguf')) return /lora|adapter/.test(p) ? 'lora' : 'gguf'
  if (p.endsWith('.spm')) return 'vocab'
  if (p.endsWith('.bin')) return 'bin'
  if (p.endsWith('.onnx')) return 'onnx'
  if (p.endsWith('.safetensors')) return 'safetensors'
  if (p.endsWith('.json') || p.endsWith('.jsonl')) return 'data'
  return 'file'
}

export function emptyManifest (name = 'default') {
  return { version: MANIFEST_VERSION, name, updatedAt: new Date(0).toISOString(), files: [] }
}

/**
 * Insert or replace a file entry, keeping entries sorted by path.
 * @param {ReturnType<typeof emptyManifest>} manifest
 * @param {{ path: string, size: number, sha256: string, kind?: string, meta?: Record<string,string> }} entry
 */
export function upsertEntry (manifest, entry, now = new Date()) {
  const clean = {
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
    kind: entry.kind ?? inferKind(entry.path),
    meta: { ...(entry.meta ?? {}) }
  }
  validateEntry(clean)
  const files = manifest.files.filter((f) => f.path !== clean.path)
  files.push(clean)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { ...manifest, updatedAt: now.toISOString(), files }
}

export function removeEntry (manifest, path, now = new Date()) {
  return { ...manifest, updatedAt: now.toISOString(), files: manifest.files.filter((f) => f.path !== path) }
}

export function findEntry (manifest, path) {
  const p = '/' + path.replace(/^\/+/, '')
  return manifest.files.find((f) => f.path === p) ?? null
}

function validateEntry (e) {
  if (typeof e.path !== 'string' || !e.path.startsWith('/') || e.path.includes('..')) {
    throw new TypeError(`Invalid manifest path: ${e.path}`)
  }
  if (e.path === MANIFEST_PATH) throw new TypeError('Cannot publish over the manifest itself')
  if (!Number.isSafeInteger(e.size) || e.size < 0) throw new TypeError(`Invalid size for ${e.path}`)
  if (!HEX64.test(e.sha256)) throw new TypeError(`Invalid sha256 for ${e.path}`)
  for (const [k, v] of Object.entries(e.meta)) {
    if (typeof v !== 'string') throw new TypeError(`meta.${k} must be a string`)
  }
}

/** Parse and validate untrusted manifest bytes fetched from a peer. */
export function parseManifest (buf) {
  let m
  try {
    m = JSON.parse(buf.toString('utf8'))
  } catch {
    throw new Error('Manifest is not valid JSON')
  }
  if (!m || m.version !== MANIFEST_VERSION || !Array.isArray(m.files)) {
    throw new Error(`Unsupported manifest (expected version ${MANIFEST_VERSION})`)
  }
  for (const f of m.files) validateEntry({ ...f, meta: f.meta ?? {} })
  return m
}

export function serializeManifest (m) {
  return Buffer.from(JSON.stringify(m, null, 2) + '\n')
}

/** Parse repeated `--meta key=value` flags. */
export function parseMetaPairs (pairs = []) {
  const meta = {}
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i <= 0) throw new TypeError(`--meta expects key=value, got "${pair}"`)
    meta[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return meta
}
