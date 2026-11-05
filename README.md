# qvac-seed

**Share local AI models and LoRA adapters peer-to-peer, as `pear://` links the [QVAC SDK](https://docs.qvac.tether.io/) loads directly.**

Think of it as BitTorrent for on-device AI. You publish a `.gguf` model, a fine-tuned LoRA adapter or a translation bundle once. Anyone with the link can download it from you or any other peer that has it: no Hugging Face account, no S3 bucket, no bandwidth bill.

```console
$ qvac-seed publish ./pirate-lora.gguf --meta base=QWEN3_600M_INST_Q4
pear://fd4ec0ea48…822a/pirate-lora.gguf  (lora, 1.9 MB, sha256 3b034103b34a…)
Seeding collection "default" — Ctrl+C to stop.
```

```js
// on any other machine
import { loadModel } from '@qvac/sdk'
const id = await loadModel({ modelSrc: 'pear://fd4ec0ea48…822a/model.gguf', modelType: 'llm' })
```

## Why

QVAC can already load `pear://` sources, but nothing helps you *create* them. qvac-seed fills that gap:

- **Publish** files into a named [Hyperdrive](https://github.com/holepunchto/hyperdrive) collection, and get stable links that survive restarts and re-publishes.
- **Seed** them over [Hyperswarm](https://github.com/holepunchto/hyperswarm). Connections are Noise-encrypted, NAT hole-punched, and need no server.
- **Verify.** Every drive carries a `/qvac-seed.json` manifest with each file's size, SHA-256, kind and free-form metadata (base model, quantisation, license…). `fetch` hashes as it downloads and refuses to keep a file that doesn't match.
- **Inspect before you download.** `ls` shows what a link contains without pulling gigabytes.

## Install

```bash
npm install -g github:lopeselio/qvac-seed
# or use the library
npm install github:lopeselio/qvac-seed
```

Requires Node.js 20+.

## CLI

| Command | What it does |
|---|---|
| `qvac-seed publish <file...> [--collection name] [--meta k=v]... [--no-seed]` | Import files into a collection, print their links, then keep seeding |
| `qvac-seed seed [--collection name]...` | Bring all (or some) of your collections online |
| `qvac-seed collections` | List your collections and their drive links |
| `qvac-seed ls <pear://key>` | Show a drive's manifest |
| `qvac-seed fetch <pear://key/path> [-o out] [--no-verify]` | Download with SHA-256 verification |
| `qvac-seed verify <file> <pear://key/path>` | Check a copy you got elsewhere against the publisher's manifest |

Data lives in `~/.qvac-seed/store` by default. Override it with `--store` or `$QVAC_SEED_HOME`.

### Sharing a translation model

The QVAC SDK finds Bergamot vocab files next to `pear://…/model.<pair>.intgemm.alphas.bin`. Publish the bundle into one collection with its original file names:

```bash
qvac-seed publish model.esen.intgemm.alphas.bin vocab.esen.spm --collection bergamot-es-en
```

## Library

```js
import {
  openStore, openWritableDrive, publishFile, createSwarm, seedDrives,
  openRemoteDrive, joinDrive, fetchFile
} from 'qvac-seed'

const store = openStore()
const drive = await openWritableDrive(store, 'my-adapters')
const { url } = await publishFile(drive, './adapter.gguf', { meta: { base: 'QWEN3_600M_INST_Q4' } })

const swarm = createSwarm(store)
await seedDrives(swarm, [drive])
console.log('share this:', url)
```

[`examples/load-with-qvac.js`](examples/load-with-qvac.js) loads a seeded base model and applies a seeded LoRA adapter with the QVAC SDK.

## Manifest format (v1)

```json
{
  "version": 1,
  "name": "my-adapters",
  "updatedAt": "2026-11-05T12:00:00.000Z",
  "files": [
    {
      "path": "/pirate-lora.gguf",
      "size": 1990000,
      "sha256": "3b03…2922",
      "kind": "lora",
      "meta": { "base": "QWEN3_600M_INST_Q4" }
    }
  ]
}
```

`kind` is inferred from the file name: `gguf`, `lora` (a `.gguf` whose name contains *lora* or *adapter*), `vocab`, `bin`, `onnx`, `safetensors`, `data` or `file`.

## Security notes

- A `pear://` key is the public key of the drive. Only its owner can write to it, and Hypercore checks every block against it, so peers can't serve modified bytes.
- The manifest guards against a *publisher* listing a hash that doesn't match the bytes. It also lets you verify copies from other sources.
- Anyone who has a link can download it, and the peers you connect to can see your IP address. Don't publish private data.
- Models are code-adjacent: a malicious GGUF can try to exploit parser bugs. Only load models from publishers you trust.

## Development

```bash
npm install
npm test   # unit tests, two-peer replication, and a swarm test on a local DHT testnet
```

## License

Apache-2.0
