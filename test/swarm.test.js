import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Corestore from 'corestore'
import createTestnet from 'hyperdht/testnet.js'
import { createSwarm, seedDrives, joinDrive } from '../src/swarm.js'
import { openWritableDrive, openRemoteDrive, publishFile, fetchFile } from '../src/drive.js'
import { parsePearUrl } from '../src/url.js'

test('a seeder and a fetcher find each other over a local DHT', { timeout: 60_000 }, async (t) => {
  const testnet = await createTestnet(3)
  const dir = await mkdtemp(join(tmpdir(), 'qvac-seed-swarm-'))
  const seederStore = new Corestore(join(dir, 'seeder'))
  const fetcherStore = new Corestore(join(dir, 'fetcher'))
  const seeder = createSwarm(seederStore, { bootstrap: testnet.bootstrap })
  const fetcher = createSwarm(fetcherStore, { bootstrap: testnet.bootstrap })
  t.after(async () => {
    await seeder.destroy()
    await fetcher.destroy()
    await seederStore.close()
    await fetcherStore.close()
    await testnet.destroy()
    await rm(dir, { recursive: true, force: true })
  })

  const src = join(dir, 'model.gguf')
  await writeFile(src, 'pretend this is a quantised model')
  const drive = await openWritableDrive(seederStore, 'swarm-test')
  const { url } = await publishFile(drive, src)
  await seedDrives(seeder, [drive])

  const { key, path } = parsePearUrl(url)
  const remote = await openRemoteDrive(fetcherStore, key)
  await joinDrive(fetcher, remote)

  const out = join(dir, 'got.gguf')
  const res = await fetchFile(remote, path, out)
  assert.equal(res.verified, true)
  assert.equal(await readFile(out, 'utf8'), 'pretend this is a quantised model')
})
