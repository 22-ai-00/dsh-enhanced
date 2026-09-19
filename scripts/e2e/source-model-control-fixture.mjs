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
 * Mount a production PluginControlPlaneService with a minimal versioned owner
 * trust root. dispose() awaits only this service's Fiber; the supplied Context
 * remains owned by the caller.
 */
export async function createSourceModelControlFixture({ root, repository, image, ctx, trustSchemaVersion = 1, reuseTrust = false, serviceConfig }) {
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
  if (![1, 4].includes(trustSchemaVersion)) throw new TypeError('createSourceModelControlFixture supports trust schema 1 or 4')
  const catalogPath = join(control, 'catalog.json')
  if (!reuseTrust) {
    await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, entries: [] }) + '\n', { mode: 0o600 })
    await chmod(catalogPath, 0o600)
  }
  const trustPath = join(control, 'trust.json')
  const trust = {
    schemaVersion: trustSchemaVersion,
    installationId,
    dshHome,
    ledger: { id: ledgerId, path: join(statePath, 'control.sqlite') },
    executor: {
      id: 'source-model-fixture-executor', version: '1.0.0', path: canonicalExecutor,
      sha256: createHash('sha256').update(executorBytes).digest('hex'), environmentAllowlist: [],
    },
    approvalKeys: [publicKey('source-model-fixture', 'approval')],
    hostAttestationKeys: [publicKey('source-model-fixture', 'host-attestation')],
    ...(trustSchemaVersion === 4 ? {
      hostPolicy: { readinessMinimumChecks: 1, effectBlockedMinimumDeliveryAttempts: 1, effectBlockedMinimumToolExecutionAttempts: 1,
        shadowMinimumSamples: 1, shadowMaximumMismatches: 0, canaryMinimumSamples: 1, canaryMaximumFailures: 0,
        soakMinimumWindowMs: 60_000, soakMinimumSamples: 10, soakMaximumFailureRate: 0, healthMinimumChecks: 1,
        healthMaximumFailures: 0, receiptTtlMs: 30_000 },
      hostAttestor: null,
      catalog: { id: 'source-model-fixture-catalog', path: await realpath(catalogPath) },
      releaseRegistry: { id: 'source-model-fixture-registry', locator: 'https://registry.example.invalid' },
      releaseReceiptTtlMs: 30_000,
      releaseAdapters: { pr: null, review: null, merge: null, build: null, sign: null, publish: null, 'registry-verify': null, 'catalog-admission': null },
      releaseKeys: [publicKey('source-model-fixture', 'release')],
      releaseAuthorizationKeys: [publicKey('source-model-fixture', 'release-authorization')],
    } : {}),
  }
  if (!reuseTrust) {
    await writeFile(trustPath, JSON.stringify(trust, null, 2) + '\n', { mode: 0o600 })
    await chmod(trustPath, 0o600)
  }
  const defaults = {
    catalogPath: await realpath(catalogPath), statePath, trustPath: await realpath(trustPath),
    sourceBuild: {
      dockerPath: '/usr/bin/docker', image, timeoutMs: 60_000, memoryMiB: 512,
      cpus: 1, pidsLimit: 64, workspaceMiB: 256, outputBytes: 65_536,
    },
  }
  const fiber = ctx.plugin(PluginControlPlaneService, serviceConfig === undefined ? defaults : serviceConfig(defaults))
  await fiber
  const service = ctx.get('pluginControlPlane')
  return Object.freeze({ ctx, service, statePath, catalogPath: await realpath(catalogPath), trustPath: await realpath(trustPath), dispose: () => fiber.dispose() })
}
