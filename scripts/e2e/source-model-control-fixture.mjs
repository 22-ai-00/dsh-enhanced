// Real control-plane fixture for model-facing source inspection/preparation
// smoke tests. It creates only owner-local trust and state inputs: no model,
// attestation, signing, release, registry, or network activity is simulated.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PluginControlPlaneService } from '../../plugins/plugin-control-plane/lib/service.js'

const installationId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00'
const ledgerId = '018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01'
const imagePattern = /^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/u

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  return realpath(path)
}

function publicKey(authority, keyId) {
  const pair = generateKeyPairSync('ed25519')
  return Object.freeze({ authority, keyId, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
}

/**
 * Mount a production PluginControlPlaneService with a minimal schema-v1 owner
 * trust root. The supplied Context remains owned by the caller, so dispose()
 * deliberately does not restart or dispose that Context.
 */
export async function createSourceModelControlFixture({ root, repository, image, ctx }) {
  if (ctx === undefined || ctx === null) throw new TypeError('createSourceModelControlFixture requires the caller Context')
  if (typeof root !== 'string' || typeof repository !== 'string' || typeof image !== 'string' || !imagePattern.test(image)) {
    throw new TypeError('createSourceModelControlFixture requires absolute root, repository, and immutable image')
  }
  const fixtureRoot = await privateDirectory(resolve(root))
  await realpath(resolve(repository))
  const dshHome = await privateDirectory(join(fixtureRoot, 'dsh-home'))
  const control = await privateDirectory(join(dshHome, 'plugin-control'))
  const statePath = await privateDirectory(join(control, 'plans'))
  const executorDirectory = await privateDirectory(join(fixtureRoot, 'executor'))
  const executorPath = join(executorDirectory, 'must-not-run')
  const executorBytes = Buffer.from('#!/bin/sh\necho executor must not run >&2\nexit 99\n', 'utf8')
  await writeFile(executorPath, executorBytes, { mode: 0o700 })
  await chmod(executorPath, 0o700)
  const canonicalExecutor = await realpath(executorPath)
  const catalogPath = join(control, 'catalog.json')
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, entries: [] }) + '\n', { mode: 0o600 })
  await chmod(catalogPath, 0o600)
  const trustPath = join(control, 'trust.json')
  const trust = {
    schemaVersion: 1,
    installationId,
    dshHome,
    ledger: { id: ledgerId, path: join(statePath, 'control.sqlite') },
    executor: {
      id: 'source-model-fixture-executor', version: '1.0.0', path: canonicalExecutor,
      sha256: createHash('sha256').update(executorBytes).digest('hex'), environmentAllowlist: [],
    },
    approvalKeys: [publicKey('source-model-fixture', 'approval')],
    hostAttestationKeys: [publicKey('source-model-fixture', 'host-attestation')],
  }
  await writeFile(trustPath, JSON.stringify(trust, null, 2) + '\n', { mode: 0o600 })
  await chmod(trustPath, 0o600)
  const service = new PluginControlPlaneService(ctx, {
    catalogPath: await realpath(catalogPath), statePath, trustPath: await realpath(trustPath),
    sourceBuild: {
      dockerPath: '/usr/bin/docker', image, timeoutMs: 60_000, memoryMiB: 512,
      cpus: 1, pidsLimit: 64, workspaceMiB: 256, outputBytes: 65_536,
    },
  })
  return Object.freeze({ ctx, service, statePath, trustPath: await realpath(trustPath), dispose: async () => {} })
}
