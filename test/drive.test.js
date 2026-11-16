import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import Corestore from 'corestore'
import { openWritableDrive, openRemoteDrive, publishFile, fetchFile, readManifest } from '../src/drive.js'
import { parsePearUrl } from '../src/url.js'
import { MANIFEST_PATH, serializeManifest, upsertEntry } from '../src/manifest.js'

async function setup (t) {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-seed-'))
  const a = new Corestore(join(dir, 'a'))
  const b = new Corestore(join(dir, 'b'))
  // Replicate the two stores over an in-memory stream: same protocol as a
  // Hyperswarm connection, without touching the network.
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  t.after(async () => {
    await a.close()
    await b.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { dir, a, b }
}

test('publish then fetch a file across two peers with verification', async (t) => {
  const { dir, a, b } = await setup(t)
  const payload = randomBytes(300_000)
  const src = join(dir, 'tiny-lora-adapter.gguf')
  await writeFile(src, payload)

  const mine = await openWritableDrive(a, 'test')
  const { url, entry } = await publishFile(mine, src, { meta: { base: 'QWEN3_600M_INST_Q4' } })
  assert.equal(entry.kind, 'lora')
  assert.equal(entry.sha256, createHash('sha256').update(payload).digest('hex'))

  const { key, path } = parsePearUrl(url)
  assert.equal(path, 'tiny-lora-adapter.gguf')

  const theirs = await openRemoteDrive(b, key)
  const manifest = await readManifest(theirs)
  assert.equal(manifest.files[0].meta.base, 'QWEN3_600M_INST_Q4')

  const out = join(dir, 'out', 'adapter.gguf')
  const res = await fetchFile(theirs, path, out)
  assert.equal(res.verified, true)
  assert.deepEqual(await readFile(out), payload)
})

test('collection keys survive restarts; republish is idempotent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qvac-seed-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const src = join(dir, 'm.gguf')
  await writeFile(src, 'v1')

  const a = new Corestore(join(dir, 'store'))
  const d1 = await openWritableDrive(a, 'stable')
  assert.equal(await openWritableDrive(a, 'stable'), d1)
  const first = await publishFile(d1, src)
  const again = await publishFile(d1, src)
  assert.equal(first.url, again.url)
  const other = await openWritableDrive(a, 'other')
  assert.notEqual(other.key.toString('hex'), d1.key.toString('hex'))
  await a.close()

  const reopened = new Corestore(join(dir, 'store'))
  t.after(() => reopened.close())
  const d2 = await openWritableDrive(reopened, 'stable')
  assert.equal(d2.key.toString('hex'), d1.key.toString('hex'))
  assert.equal((await readManifest(d2)).files.length, 1)
})

test('fetch rejects a file whose bytes do not match the manifest', async (t) => {
  const { dir, a, b } = await setup(t)
  const mine = await openWritableDrive(a, 'tampered')
  await mine.put('/evil.gguf', Buffer.from('not what was promised'))
  const lie = upsertEntry({ version: 1, name: 'x', files: [] }, { path: '/evil.gguf', size: 21, sha256: 'f'.repeat(64) })
  await mine.put(MANIFEST_PATH, serializeManifest(lie))

  const theirs = await openRemoteDrive(b, mine.key.toString('hex'))
  const out = join(dir, 'evil.gguf')
  await assert.rejects(fetchFile(theirs, 'evil.gguf', out), /Integrity check failed/)
  await assert.rejects(access(out))
  await assert.rejects(access(out + '.part'))
})

test('fetch refuses unlisted files unless verification is disabled', async (t) => {
  const { dir, a, b } = await setup(t)
  const mine = await openWritableDrive(a, 'unlisted')
  await mine.put('/loose.bin', Buffer.from('abc'))
  await mine.put(MANIFEST_PATH, serializeManifest({ version: 1, name: 'x', files: [] }))
  const theirs = await openRemoteDrive(b, mine.key.toString('hex'))
  await assert.rejects(fetchFile(theirs, 'loose.bin', join(dir, 'l1')), /not listed/)
  const res = await fetchFile(theirs, 'loose.bin', join(dir, 'l2'), { requireManifest: false })
  assert.equal(res.verified, false)
})

test('fetch stops when a drive sends more than its manifest declares', async (t) => {
  const { dir, a, b } = await setup(t)
  const mine = await openWritableDrive(a, 'oversized')
  const payload = randomBytes(2_000_000)
  await mine.put('/big.gguf', payload)
  // The manifest claims 1000 bytes; the file is 2 MB.
  const lie = upsertEntry({ version: 1, name: 'x', files: [] }, { path: '/big.gguf', size: 1000, sha256: 'f'.repeat(64) })
  await mine.put(MANIFEST_PATH, serializeManifest(lie))

  const theirs = await openRemoteDrive(b, mine.key.toString('hex'))
  const out = join(dir, 'big.gguf')
  let seen = 0
  await assert.rejects(fetchFile(theirs, 'big.gguf', out, { onProgress: (p) => { seen = p.downloaded } }), /larger than the 1000 bytes its manifest declares/)
  assert.equal(seen, 0, 'no chunk past the declared size is accepted')
  await assert.rejects(access(out))
  await assert.rejects(access(out + '.part'))
})

test('fetch refuses a file over maxBytes before downloading it', async (t) => {
  const { dir, a, b } = await setup(t)
  const src = join(dir, 'model.gguf')
  await writeFile(src, randomBytes(300_000))
  const mine = await openWritableDrive(a, 'capped')
  await publishFile(mine, src)

  const theirs = await openRemoteDrive(b, mine.key.toString('hex'))
  const out = join(dir, 'out.gguf')
  let progressed = false
  await assert.rejects(fetchFile(theirs, 'model.gguf', out, { maxBytes: 100_000, onProgress: () => { progressed = true } }), /300000 bytes, over the 100000 byte limit/)
  assert.equal(progressed, false)
  await assert.rejects(access(out + '.part'))
  // Under the limit it downloads as usual.
  const res = await fetchFile(theirs, 'model.gguf', out, { maxBytes: 300_000 })
  assert.equal(res.verified, true)
})

test('fetch can be cancelled with an AbortSignal, before and during the transfer', async (t) => {
  const { dir, a, b } = await setup(t)
  const src = join(dir, 'model.gguf')
  await writeFile(src, randomBytes(3_000_000))
  const mine = await openWritableDrive(a, 'abortable')
  await publishFile(mine, src)
  const theirs = await openRemoteDrive(b, mine.key.toString('hex'))
  const out = join(dir, 'out.gguf')

  // Already aborted: nothing starts.
  await assert.rejects(fetchFile(theirs, 'model.gguf', out, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(access(out + '.part'))

  // Aborted on the first chunk: the transfer stops and the partial file goes.
  const ac = new AbortController()
  let chunks = 0
  await assert.rejects(fetchFile(theirs, 'model.gguf', out, { signal: ac.signal, onProgress: () => { if (++chunks === 1) ac.abort() } }), { name: 'AbortError' })
  await assert.rejects(access(out))
  await assert.rejects(access(out + '.part'))

  // The same drive still works afterwards.
  const res = await fetchFile(theirs, 'model.gguf', out)
  assert.equal(res.verified, true)
  assert.equal(res.size, 3_000_000)
})

test('fetch waiting for a peer that never comes can be cancelled', async (t) => {
  const { dir, b } = await setup(t)
  // A drive key nobody is serving: without a signal this would wait for ever.
  const nobody = await openRemoteDrive(b, 'ab'.repeat(32))
  const done = nobody.findingPeers()
  t.after(done)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  await assert.rejects(fetchFile(nobody, 'model.gguf', join(dir, 'never.gguf'), { signal: ac.signal }), { name: 'AbortError' })
  await assert.rejects(access(join(dir, 'never.gguf.part')))
})
