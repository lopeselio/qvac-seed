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
