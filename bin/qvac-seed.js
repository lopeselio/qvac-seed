#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  openStore, openWritableDrive, openRemoteDrive, readManifest, publishFile, fetchFile,
  createSwarm, seedDrives, joinDrive, parsePearUrl, formatPearUrl, hashFile,
  parseMetaPairs, findEntry, defaultStoreDir
} from '../src/index.js'

const HELP = `qvac-seed — share local AI models and LoRA adapters peer-to-peer

Usage:
  qvac-seed publish <file...> [--collection name] [--meta key=value]... [--no-seed]
  qvac-seed seed [--collection name]...      keep your collections online
  qvac-seed ls <pear://key>                  list a drive's manifest
  qvac-seed fetch <pear://key/path> [-o out] [--no-verify]
  qvac-seed verify <file> <pear://key/path>  check a local copy against a manifest
  qvac-seed collections                      list your collections and their links

Links work directly as QVAC SDK sources:
  loadModel({ modelSrc: 'pear://<key>/model.gguf', modelType: 'llm' })

Options:
  --store <dir>   corestore location (default ${defaultStoreDir()}, or $QVAC_SEED_HOME)
  -h, --help      show this help
`

const COLLECTIONS_FILE = 'collections.json'

function fmtBytes (n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}

function progressLine (label) {
  let last = 0
  return ({ copied, downloaded, size }) => {
    const done = copied ?? downloaded
    const now = Date.now()
    if (now - last < 200 && done < size) return
    last = now
    const pct = size ? ((done / size) * 100).toFixed(1) : '?'
    process.stderr.write(`\r${label} ${pct}% (${fmtBytes(done)}/${fmtBytes(size)})   `)
    if (done >= size) process.stderr.write('\n')
  }
}

async function loadCollections (storeDir) {
  try {
    return JSON.parse(await readFile(resolve(storeDir, COLLECTIONS_FILE), 'utf8'))
  } catch {
    return []
  }
}

async function rememberCollection (storeDir, name) {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const names = new Set(await loadCollections(storeDir))
  names.add(name)
  await mkdir(storeDir, { recursive: true })
  await writeFile(resolve(storeDir, COLLECTIONS_FILE), JSON.stringify([...names].sort(), null, 2))
}

function waitForever (swarm, store) {
  const shutdown = async () => {
    process.stderr.write('\nStopping…\n')
    await swarm.destroy()
    await store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return new Promise(() => {})
}

async function main (argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      collection: { type: 'string', multiple: true },
      meta: { type: 'string', multiple: true },
      out: { type: 'string', short: 'o' },
      store: { type: 'string' },
      'no-seed': { type: 'boolean' },
      'no-verify': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  })
  const [cmd, ...args] = positionals
  if (values.help || !cmd) {
    process.stdout.write(HELP)
    return
  }

  const storeDir = resolve(values.store ?? defaultStoreDir())

  if (cmd === 'verify') {
    const [file, url] = args
    if (!file || !url) throw new Error('usage: qvac-seed verify <file> <pear://key/path>')
    const { key, path } = parsePearUrl(url)
    const store = openStore(storeDir)
    const swarm = createSwarm(store)
    try {
      const drive = await openRemoteDrive(store, key)
      await joinDrive(swarm, drive)
      const entry = findEntry(await readManifest(drive), path)
      if (!entry) throw new Error(`${path} is not in that drive's manifest`)
      const local = await hashFile(file)
      const ok = local.sha256 === entry.sha256 && local.size === entry.size
      console.log(ok ? `✔ ${file} matches ${url}` : `✖ ${file} does NOT match ${url}`)
      process.exitCode = ok ? 0 : 1
    } finally {
      await swarm.destroy()
      await store.close()
    }
    return
  }

  const store = openStore(storeDir)

  if (cmd === 'publish') {
    if (!args.length) throw new Error('usage: qvac-seed publish <file...>')
    const name = values.collection?.[0] ?? 'default'
    const meta = parseMetaPairs(values.meta)
    const drive = await openWritableDrive(store, name)
    await rememberCollection(storeDir, name)
    for (const file of args) {
      const { url, entry } = await publishFile(drive, resolve(file), {
        meta,
        onProgress: progressLine(`importing ${basename(file)}`)
      })
      console.log(`${url}  (${entry.kind}, ${fmtBytes(entry.size)}, sha256 ${entry.sha256.slice(0, 12)}…)`)
    }
    if (values['no-seed']) return store.close()
    const swarm = createSwarm(store, { onPeer: (p) => process.stderr.write(`peer connected ${p.remotePublicKey.slice(0, 8)}\n`) })
    await seedDrives(swarm, [drive])
    process.stderr.write(`Seeding collection "${name}" — Ctrl+C to stop.\n`)
    return waitForever(swarm, store)
  }

  if (cmd === 'seed') {
    const names = values.collection ?? await loadCollections(storeDir)
    if (!names.length) throw new Error('Nothing to seed yet — run `qvac-seed publish <file>` first.')
    const drives = await Promise.all(names.map((n) => openWritableDrive(store, n)))
    const swarm = createSwarm(store, { onPeer: (p) => process.stderr.write(`peer connected ${p.remotePublicKey.slice(0, 8)}\n`) })
    await seedDrives(swarm, drives)
    for (let i = 0; i < names.length; i++) console.log(`${names[i]}: ${formatPearUrl(drives[i].key)}`)
    process.stderr.write('Seeding — Ctrl+C to stop.\n')
    return waitForever(swarm, store)
  }

  if (cmd === 'collections') {
    for (const n of await loadCollections(storeDir)) {
      const d = await openWritableDrive(store, n)
      const m = await readManifest(d, { wait: false })
      console.log(`${n}\t${formatPearUrl(d.key)}\t${m?.files.length ?? 0} file(s)`)
    }
    return store.close()
  }

  if (cmd === 'ls' || cmd === 'fetch') {
    const [url] = args
    if (!url) throw new Error(`usage: qvac-seed ${cmd} <pear://key${cmd === 'fetch' ? '/path' : ''}>`)
    const { key, path } = parsePearUrl(url)
    const swarm = createSwarm(store)
    try {
      const drive = await openRemoteDrive(store, key)
      await joinDrive(swarm, drive)
      if (cmd === 'ls') {
        const m = await readManifest(drive)
        if (!m) throw new Error('No qvac-seed manifest found in that drive')
        for (const f of m.files) {
          const meta = Object.entries(f.meta).map(([k, v]) => `${k}=${v}`).join(' ')
          console.log(`${formatPearUrl(key, f.path)}\t${f.kind}\t${fmtBytes(f.size)}\t${meta}`)
        }
      } else {
        if (!path) throw new Error('fetch needs a file path: pear://<key>/<file>')
        const out = resolve(values.out ?? basename(path))
        const res = await fetchFile(drive, path, out, {
          requireManifest: !values['no-verify'],
          onProgress: progressLine(`fetching ${basename(path)}`)
        })
        console.log(`${res.verified ? '✔ verified' : '⚠ unverified'} ${res.path} (${fmtBytes(res.size)}, sha256 ${res.sha256})`)
      }
    } finally {
      await swarm.destroy()
      await store.close()
    }
    return
  }

  throw new Error(`Unknown command "${cmd}". Run qvac-seed --help.`)
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`✖ ${err.message}`)
  process.exit(1)
})
