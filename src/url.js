// pear:// links are what the QVAC SDK accepts as `modelSrc` / `assetSrc`:
//   pear://<64-hex-char hyperdrive key>/<path inside the drive>
// The SDK matches keys with /[a-f0-9]+/, so we always emit lowercase hex.

const KEY_RE = /^[a-f0-9]{64}$/

/**
 * @param {string} url
 * @returns {{ key: string, path: string }} path is '' for a bare drive link
 */
export function parsePearUrl (url) {
  if (typeof url !== 'string' || !url.startsWith('pear://')) {
    throw new TypeError(`Not a pear:// URL: ${url}`)
  }
  const rest = url.slice('pear://'.length)
  const slash = rest.indexOf('/')
  const key = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase()
  const path = slash === -1 ? '' : rest.slice(slash + 1)

  if (!KEY_RE.test(key)) {
    throw new TypeError(`Invalid drive key in ${url}: expected 64 hex characters`)
  }
  if (path.split('/').some((seg) => seg === '..')) {
    throw new TypeError(`Path traversal is not allowed: ${url}`)
  }
  return { key, path: path.replace(/\/+$/, '') }
}

/**
 * @param {Buffer | Uint8Array | string} key
 * @param {string} [path]
 */
export function formatPearUrl (key, path = '') {
  const hex = typeof key === 'string' ? key.toLowerCase() : Buffer.from(key).toString('hex')
  if (!KEY_RE.test(hex)) throw new TypeError('Drive key must be 32 bytes')
  const clean = path.replace(/^\/+/, '')
  return clean ? `pear://${hex}/${clean}` : `pear://${hex}`
}

/** Convert a drive path ("/model.gguf") to the form used in URLs and back. */
export function toDrivePath (path) {
  return '/' + path.replace(/^\/+/, '')
}
