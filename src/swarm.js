import Hyperswarm from 'hyperswarm'

/**
 * Create a swarm that replicates every connection through the corestore.
 * Connections are Noise-encrypted; peers only learn which drives you are
 * looking for if they already know the drive's discovery key.
 * @param {import('corestore')} store
 * @param {{ bootstrap?: any[], onPeer?: (info: { remotePublicKey: string }) => void }} [opts]
 */
export function createSwarm (store, { bootstrap, onPeer } = {}) {
  const swarm = new Hyperswarm(bootstrap ? { bootstrap } : {})
  swarm.on('connection', (conn, info) => {
    store.replicate(conn)
    onPeer?.({ remotePublicKey: info.publicKey.toString('hex') })
  })
  return swarm
}

/** Announce drives so others can download from you. Resolves once announced. */
export async function seedDrives (swarm, drives) {
  for (const drive of drives) {
    swarm.join(drive.discoveryKey, { server: true, client: true })
  }
  await swarm.flush()
}

/**
 * Look up peers for a remote drive. Hyperdrive's `findingPeers()` makes reads
 * wait while discovery is in flight instead of failing early.
 */
export async function joinDrive (swarm, drive) {
  const done = drive.findingPeers()
  swarm.join(drive.discoveryKey, { server: false, client: true })
  swarm.flush().then(done, done)
}
