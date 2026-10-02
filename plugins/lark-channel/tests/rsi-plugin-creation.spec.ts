import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CreationCapabilityOwner } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { createRsiPluginCreationSetup, validateRsiPluginCreationSetup } from '../src/rsi-plugin-creation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'rsi-plugin-creation-'))
  roots.push(root)
  const resources = await prepareRsiAuthorityResources({ dshHome: root, profile: 'primary' })
  await mkdir(join(resources.stateRoot, 'creation-review-runner'), { mode: 0o700 })
  await mkdir(join(resources.stateRoot, 'creation-adoption-runner'), { mode: 0o700 })
  const owner: CreationCapabilityOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
    principalId: 'lark/account/tenant/owner', principalRecordId: 'principal-record', principalVersion: 3,
    workspace: root, agentPreset: 'primary' }
  const now = 100_000, expiresAt = 400_000
  const build = { schemaVersion: 1 as const, sourceCommit: 'a'.repeat(40), sourceImage: 'sha256:' + 'b'.repeat(64),
    image: 'sha256:' + 'c'.repeat(64), dockerPath: await realpath(process.execPath) }
  return { root, resources, owner, now, expiresAt, build }
}

describe('finite owner-bound plugin creation setup', () => {
  test('compiles one source, independent review, and signed adoption chain without mutating identities', async () => {
    const f = await fixture(), original = structuredClone(f.resources)
    const setup = createRsiPluginCreationSetup(f)
    expect(f.resources).toEqual(original)
    expect(validateRsiPluginCreationSetup(setup, f.owner, f.now)).toEqual(setup)
    expect(createRsiPluginCreationSetup(f)).toEqual(setup)
    expect(setup.creation.namePrefix).toBe(`owner-${f.resources.installationId.slice(0, 8)}-`)
    expect(setup.creation.expiresAt).toBe(f.expiresAt)
    expect(setup.reviews.maxVerifications).toBe(32)
    expect(setup.capabilities.maxAdoptions).toBe(32)
    expect(setup.capabilities.maxCallRecords).toBe(960)
    expect(setup.capabilities.runner.maxRuns).toBe(1_024)
    expect(setup.reviews.keyPath).toBe(f.resources.identities.review.keyPath)
    expect(setup.capabilities.keyPath).toBe(f.resources.identities.adoption.keyPath)
    expect(setup.verifications.publicKey).toBe(f.resources.identities.review.publicKeyPem)
    expect(setup.reviews.policy).toMatch(/current authenticated task and feedback/)
    expect(JSON.stringify(setup)).not.toContain('PRIVATE KEY')
  })

  test('rejects changed owner, namespace, expiry, and independent authority IDs', async () => {
    const f = await fixture(), setup = createRsiPluginCreationSetup(f)
    expect(() => validateRsiPluginCreationSetup(setup, { ...f.owner, principalVersion: 4 }, f.now)).toThrow('owner')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      owner: { ...f.owner, principalId: 'another' } } }, f.owner, f.now)).toThrow('owner')
    expect(() => validateRsiPluginCreationSetup({ ...setup, creation: { ...setup.creation,
      namePrefix: 'owner-deadbeef-' } }, f.owner, f.now)).toThrow('namespace')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      expiresAt: f.expiresAt + 1 } }, f.owner, f.now)).toThrow('expiry')
    expect(() => validateRsiPluginCreationSetup(setup, f.owner, f.expiresAt)).toThrow('finite source creation grant')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      authorityId: setup.reviews.authorityId } }, f.owner, f.now)).toThrow('independent')
    expect(() => validateRsiPluginCreationSetup({ ...setup, reviews: { ...setup.reviews,
      keyId: 'unscoped-key' } }, f.owner, f.now)).toThrow('independent')
  })

  test('rejects verifier digest, public key, and signing-key reuse', async () => {
    const f = await fixture(), setup = createRsiPluginCreationSetup(f)
    expect(() => validateRsiPluginCreationSetup({ ...setup, verifications: { ...setup.verifications,
      authority: { ...setup.verifications.authority, authorityDigest: '0'.repeat(64) } } }, f.owner, f.now)).toThrow('digest or key')
    expect(() => validateRsiPluginCreationSetup({ ...setup, verifications: { ...setup.verifications,
      publicKey: f.resources.identities.adoption.publicKeyPem } }, f.owner, f.now)).toThrow('digest or key')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      keyPath: setup.reviews.keyPath } }, f.owner, f.now)).toThrow('independent')
  })

  test('rejects widened or mismatched finite quotas and runner coverage', async () => {
    const f = await fixture(), setup = createRsiPluginCreationSetup(f)
    expect(() => validateRsiPluginCreationSetup({ ...setup, creation: { ...setup.creation,
      maxCreates: 33 } }, f.owner, f.now)).toThrow('finite source')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      maxCallsPerAdoption: 100 } }, f.owner, f.now)).toThrow('finite limits')
    expect(() => validateRsiPluginCreationSetup({ ...setup, reviews: { ...setup.reviews,
      runner: { ...setup.reviews.runner, maxRuns: 159 } } }, f.owner, f.now)).toThrow()
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      runner: { ...setup.capabilities.runner, maxRuns: 991 } } }, f.owner, f.now)).toThrow('runner')
    expect(() => validateRsiPluginCreationSetup({ ...setup, capabilities: { ...setup.capabilities,
      runner: { ...setup.capabilities.runner, stateRoot: f.resources.stateRoot } } }, f.owner, f.now)).toThrow('private roots')
  })

  test('rejects hidden fields and accessors before reading them', async () => {
    const f = await fixture(), setup = createRsiPluginCreationSetup(f)
    Object.defineProperty(setup, 'hidden', { value: true })
    expect(() => validateRsiPluginCreationSetup(setup, f.owner, f.now)).toThrow('setup fields')
    const clean = createRsiPluginCreationSetup(f)
    Object.defineProperty(clean.creation, 'maxCreates', { enumerable: true, get: () => { throw new Error('accessed') } })
    expect(() => validateRsiPluginCreationSetup(clean, f.owner, f.now)).toThrow('finite source')
    const hiddenAuthority = structuredClone(createRsiPluginCreationSetup(f))
    Object.defineProperty(hiddenAuthority.verifications.authority, 'hidden', { value: true })
    expect(() => validateRsiPluginCreationSetup(hiddenAuthority, f.owner, f.now)).toThrow('authority')
  })

  test('reports outdated optional peers explicitly', async () => {
    vi.resetModules()
    vi.doMock('node:module', async importOriginal => ({ ...(await importOriginal<typeof import('node:module')>()),
      createRequire: () => Object.assign((name: string) => name.includes('assistant-verifier')
        ? { compileCreationReviewConfig: undefined } : { validateCreationCapabilityConfig: () => {} },
      { resolve: (name: string) => name }) }))
    try {
      const { getRsiPluginCreationValidators } = await import('../src/rsi-plugin-creation.js')
      expect(() => getRsiPluginCreationValidators()).toThrow('installed creation validators are unavailable')
    } finally { vi.doUnmock('node:module'); vi.resetModules() }
  })
})
