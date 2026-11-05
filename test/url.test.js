import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePearUrl, formatPearUrl, toDrivePath } from '../src/url.js'

const KEY = 'ab'.repeat(32)

test('parses key and nested path', () => {
  assert.deepEqual(parsePearUrl(`pear://${KEY}/loras/pirate.gguf`), { key: KEY, path: 'loras/pirate.gguf' })
})

test('parses a bare drive link', () => {
  assert.deepEqual(parsePearUrl(`pear://${KEY}`), { key: KEY, path: '' })
  assert.deepEqual(parsePearUrl(`pear://${KEY}/`), { key: KEY, path: '' })
})

test('normalises key to lowercase', () => {
  assert.equal(parsePearUrl(`pear://${KEY.toUpperCase()}/a`).key, KEY)
})

test('rejects non-pear URLs, bad keys and traversal', () => {
  assert.throws(() => parsePearUrl('https://example.com/x.gguf'), /Not a pear/)
  assert.throws(() => parsePearUrl('pear://abc/x.gguf'), /64 hex/)
  assert.throws(() => parsePearUrl(`pear://${KEY}/../etc/passwd`), /traversal/)
})

test('formats from Buffer or hex and round-trips', () => {
  const buf = Buffer.from(KEY, 'hex')
  const url = formatPearUrl(buf, '/model.gguf')
  assert.equal(url, `pear://${KEY}/model.gguf`)
  assert.deepEqual(parsePearUrl(url), { key: KEY, path: 'model.gguf' })
  assert.equal(formatPearUrl(KEY), `pear://${KEY}`)
})

test('toDrivePath adds exactly one leading slash', () => {
  assert.equal(toDrivePath('a/b'), '/a/b')
  assert.equal(toDrivePath('///a'), '/a')
})
