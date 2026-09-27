import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { ControlPlaneStore } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiOwnerConfiguration } from '../src/rsi-bootstrap.js'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'

describe.skipIf(process.platform !== 'linux')('owner configuration preparation', () => {
  test('creates validated complete configuration and preserves real ledger, key and authority state on retry', async () => {
    const f = await rsiBootstrapFixture()
    try {
      const result = await prepareRsiOwnerConfiguration(f.input, f)
      expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toEqual(f.input.manifest)
      expect((await lstat(result.manifestPath)).mode & 0o777).toBe(0o600)
      const observerKey = f.input.manifest.controlPlane.runtimeObserver!.keyPath
      const keyBefore = await readFile(observerKey), keyStat = await lstat(observerKey)
      const ledger = join(f.input.manifest.controlPlane.statePath, 'control.sqlite')
      const store = new ControlPlaneStore({ path: ledger })
      let gapId: string
      try { gapId = store.recordGap({ idempotencyKey: 'existing-owner-task', capability: 'task-result', context: 'ordinary feedback',
        expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 1 }).id } finally { store.close() }
      const statePath = join(f.input.resources.stateRoot, 'approval.json')
      await writeFile(statePath, '{"alreadyUsed":1}\n', { mode: 0o600 })
      expect(await prepareRsiOwnerConfiguration(f.input, f)).toEqual(result)
      expect(await readFile(observerKey)).toEqual(keyBefore)
      expect((await lstat(observerKey)).ino).toBe(keyStat.ino)
      expect(await readFile(statePath, 'utf8')).toBe('{"alreadyUsed":1}\n')
      const recovered = new ControlPlaneStore({ path: ledger })
      try { expect(recovered.getGap(gapId!).context).toBe('ordinary feedback') } finally { recovered.close() }
      expect(await readdir(f.input.resources.configRoot)).toContain('bootstrap.json')
      // Inspection consumes the same copied phase code and does not create a
      // release receipt, run a build, or make a registry publication.
      expect(await readdir(f.input.resources.registry.root)).toEqual([])
      for (const phase of Object.keys(f.input.runtime.releaseAdapters)) {
        expect(await readdir(join(f.input.resources.stateRoot, 'release', phase))).toEqual([])
      }
    } finally { await f.cleanup() }
  }, 120_000)

  test('owner drift during validation removes only newly prepared files and retains signing identities', async () => {
    const f = await rsiBootstrapFixture()
    try {
      const keyPath = f.input.resources.identities.approval.keyPath, key = await readFile(keyPath)
      const binding = { ...f.binding, owner: { ...f.binding.owner, version: f.binding.owner.version + 1 } }
      await expect(prepareRsiOwnerConfiguration(f.input, { ...f, binding })).rejects.toThrow(/owner/u)
      expect(await readdir(f.input.resources.configRoot)).toEqual([])
      await expect(lstat(join(f.input.manifest.controlPlane.statePath, 'control.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(keyPath)).toEqual(key)
      expect(await prepareRsiOwnerConfiguration(f.input, f)).toHaveProperty('manifestPath')
    } finally { await f.cleanup() }
  }, 120_000)

  test('does not overwrite unregistered owner configuration or create a ledger on cancellation', async () => {
    const f = await rsiBootstrapFixture()
    try {
      const path = join(f.input.resources.configRoot, 'operator.json')
      await writeFile(path, '{"retain":true}\n', { mode: 0o600 })
      await expect(prepareRsiOwnerConfiguration(f.input, f)).rejects.toThrow('unregistered configuration')
      expect(await readFile(path, 'utf8')).toBe('{"retain":true}\n')
      await expect(prepareRsiOwnerConfiguration(f.input, { ...f, signal: AbortSignal.abort() })).rejects.toThrow()
      await expect(lstat(join(f.input.manifest.controlPlane.statePath, 'control.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  }, 120_000)

  test('refuses grant and observer-key drift without renewing or rewriting the deployment', async () => {
    const f = await rsiBootstrapFixture()
    try {
      await prepareRsiOwnerConfiguration(f.input, f)
      const path = f.input.manifest.controlPlane.sourceApprovals!.configPath
      const source = await readFile(path, 'utf8'), changed = JSON.parse(source)
      changed.grant.maxApprovals++
      const changedSource = JSON.stringify(changed)
      await writeFile(path, changedSource)
      await expect(prepareRsiOwnerConfiguration(f.input, f)).rejects.toThrow('configuration changed')
      expect(await readFile(path, 'utf8')).toBe(changedSource)
      await writeFile(path, source)
      const key = f.input.manifest.controlPlane.runtimeObserver!.keyPath
      await writeFile(key, Buffer.alloc(32, 7))
      await expect(prepareRsiOwnerConfiguration(f.input, f)).rejects.toThrow('observer identity changed')
      expect(await readFile(key)).toEqual(Buffer.alloc(32, 7))
    } finally { await f.cleanup() }
  }, 120_000)

  test('read-only phase inspection rejects a mismatched phase and release authorization key reuse', async () => {
    const f = await rsiBootstrapFixture()
    try {
      await prepareRsiOwnerConfiguration(f.input, f)
      const module = await import(pathToFileURL(f.input.runtime.releaseAdapters.pr.path).href) as {
        inspectLocalReleaseAdapterConfiguration(environment: Record<string, string>, phase: string): unknown
      }
      const environment = f.input.manifest.serviceEnvironment!.target, path = environment.DSH_RELEASE_PR_CONFIG!
      const source = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...source, phase: 'review' }))
      expect(() => module.inspectLocalReleaseAdapterConfiguration(environment, 'pr')).toThrow('phase')
      await writeFile(path, JSON.stringify({ ...source, authorizationAuthority: {
        authority: source.authority, keyId: source.keyId,
        publicKeyPath: join(f.input.resources.configRoot, 'public-keys', 'pr.pem'),
      } }))
      expect(() => module.inspectLocalReleaseAdapterConfiguration(environment, 'pr')).toThrow('independent')
      expect(await readdir(join(f.input.resources.stateRoot, 'release', 'pr'))).toEqual([])
    } finally { await f.cleanup() }
  }, 120_000)
})
