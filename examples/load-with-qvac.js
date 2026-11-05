// Load a model (and optionally a LoRA adapter) that someone shared with
// qvac-seed, straight from the swarm, using the QVAC SDK.
//
//   npm install @qvac/sdk
//   node examples/load-with-qvac.js pear://<key>/model.gguf [pear://<key>/adapter.gguf]
//
// The SDK downloads pear:// sources itself over Hyperswarm and caches them.
// We also fetch the manifest first so we can refuse a file the publisher
// did not list, and show what it is before pulling gigabytes.

import { resolve, basename } from 'node:path'
import { completion, loadModel, unloadModel } from '@qvac/sdk'
import {
  openStore, openRemoteDrive, createSwarm, joinDrive, readManifest, findEntry, parsePearUrl, fetchFile
} from '../src/index.js'

const [modelUrl, loraUrl] = process.argv.slice(2)
if (!modelUrl) {
  console.error('usage: node examples/load-with-qvac.js <pear://key/model.gguf> [pear://key/adapter.gguf]')
  process.exit(1)
}

async function describe (url, { downloadTo } = {}) {
  const { key, path } = parsePearUrl(url)
  const store = openStore()
  const swarm = createSwarm(store)
  try {
    const drive = await openRemoteDrive(store, key)
    await joinDrive(swarm, drive)
    const entry = findEntry(await readManifest(drive), path)
    if (!entry) throw new Error(`${url} is not listed in its drive's manifest`)
    console.log(`▸ ${path}: ${entry.kind}, ${(entry.size / 1e6).toFixed(1)} MB`, entry.meta)
    if (downloadTo) return (await fetchFile(drive, path, downloadTo)).path
    return entry
  } finally {
    await swarm.destroy()
    await store.close()
  }
}

await describe(modelUrl)
let lora
if (loraUrl) {
  // The LLM takes `modelConfig.lora` as a local file path, so fetch the
  // adapter with qvac-seed (sha256-verified against the manifest) first.
  const dest = resolve('adapters', basename(parsePearUrl(loraUrl).path))
  lora = await describe(loraUrl, { downloadTo: dest })
}

const modelId = await loadModel({
  modelSrc: modelUrl,
  modelType: 'llm',
  modelConfig: { ctx_size: 2048, ...(lora ? { lora } : {}) },
  onProgress: (p) => process.stderr.write(`\r▸ downloading ${p.percentage?.toFixed?.(1) ?? p.percentage}%`)
})
process.stderr.write('\n')

const run = completion({
  modelId,
  history: [{ role: 'user', content: 'Introduce yourself in one sentence.' }],
  stream: true
})
for await (const event of run.events) {
  if (event.type === 'contentDelta') process.stdout.write(event.text)
}
process.stdout.write('\n')
await unloadModel({ modelId, clearStorage: false })
