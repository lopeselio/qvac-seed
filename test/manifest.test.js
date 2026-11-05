import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { hashStream } from '../src/hash.js'
import {
  emptyManifest, upsertEntry, removeEntry, findEntry, parseManifest,
  serializeManifest, inferKind, parseMetaPairs, MANIFEST_PATH
} from '../src/manifest.js'

const SHA = 'a'.repeat(64)

test('hashStream matches known sha256 and counts bytes', async () => {
  const r = await hashStream(Readable.from([Buffer.from('hello '), Buffer.from('world')]))
  assert.equal(r.sha256, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
  assert.equal(r.size, 11)
})

test('inferKind recognises QVAC asset types', () => {
  assert.equal(inferKind('/qwen3-0.6b-q4_0.gguf'), 'gguf')
  assert.equal(inferKind('/my-lora-adapter.gguf'), 'lora')
  assert.equal(inferKind('/vocab.esen.spm'), 'vocab')
  assert.equal(inferKind('/model.esen.intgemm.alphas.bin'), 'bin')
})

test('upsert replaces by path and keeps order', () => {
  let m = emptyManifest('demo')
  m = upsertEntry(m, { path: '/b.gguf', size: 1, sha256: SHA })
  m = upsertEntry(m, { path: '/a.gguf', size: 2, sha256: SHA, meta: { base: 'QWEN3_600M_INST_Q4' } })
  m = upsertEntry(m, { path: '/b.gguf', size: 3, sha256: SHA })
  assert.deepEqual(m.files.map((f) => [f.path, f.size]), [['/a.gguf', 2], ['/b.gguf', 3]])
  assert.equal(findEntry(m, 'a.gguf').meta.base, 'QWEN3_600M_INST_Q4')
  assert.equal(removeEntry(m, '/a.gguf').files.length, 1)
})

test('rejects bad entries', () => {
  const m = emptyManifest()
  assert.throws(() => upsertEntry(m, { path: 'no-slash', size: 1, sha256: SHA }), /path/)
  assert.throws(() => upsertEntry(m, { path: '/../x', size: 1, sha256: SHA }), /path/)
  assert.throws(() => upsertEntry(m, { path: MANIFEST_PATH, size: 1, sha256: SHA }), /manifest/)
  assert.throws(() => upsertEntry(m, { path: '/x', size: -1, sha256: SHA }), /size/)
  assert.throws(() => upsertEntry(m, { path: '/x', size: 1, sha256: 'nope' }), /sha256/)
})

test('parseManifest round-trips and rejects junk from peers', () => {
  const m = upsertEntry(emptyManifest(), { path: '/x.gguf', size: 5, sha256: SHA })
  assert.deepEqual(parseManifest(serializeManifest(m)), m)
  assert.throws(() => parseManifest(Buffer.from('{')), /JSON/)
  assert.throws(() => parseManifest(Buffer.from('{"version":99,"files":[]}')), /Unsupported/)
  assert.throws(() => parseManifest(Buffer.from('{"version":1,"files":[{"path":"/x","size":1,"sha256":"z"}]}')), /sha256/)
})

test('parseMetaPairs', () => {
  assert.deepEqual(parseMetaPairs(['base=QWEN3', 'note=a=b']), { base: 'QWEN3', note: 'a=b' })
  assert.throws(() => parseMetaPairs(['oops']), /key=value/)
})
