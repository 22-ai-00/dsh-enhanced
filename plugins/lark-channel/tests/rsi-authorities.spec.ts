import { afterEach, describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile, realpath } from 'node:fs/promises'
import { validateRsiAuthorities } from '../src/rsi-setup.js'
import { createRsiAuthorityFixture, type RsiAuthorityFixture } from './fixtures/rsi-authorities.js'
import { growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import type { RsiMemoryLearningSetup } from '../src/rsi-memory-learning.js'

const fixtures: RsiAuthorityFixture[] = []
const previousHostConfig = process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
afterEach(async () => {
  if (previousHostConfig === undefined) delete process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
  else process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = previousHostConfig
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()))
})
async function fixture(live = false): Promise<RsiAuthorityFixture> { const value = await createRsiAuthorityFixture(live); fixtures.push(value); return value }

describe('RSI finite authority deployment binding', () => {
  test('validates independent memory learning grants together with the existing owner deployment', async () => {
    const value = await fixture()
    const owner = value.manifest.sourceReviews.owner
    const expiresAt = value.manifest.sourceReviews.expiresAt
    const reviews: RsiMemoryLearningSetup['reviews'] = { authorityId: 'memory-review', owner,
      expiresAt, maxReviews: 10, policy: 'Independently check the actual owner source.',
      maxInputBytes: 65536, maxOutputTokens: 2048, timeoutMs: 120000 }
    const adoption: RsiMemoryLearningSetup['adoption'] = { authorityId: 'memory-adoption', owner,
      reviewAuthorityId: reviews.authorityId, reviewAuthorityDigest: growthObjectDigest(reviews),
      expiresAt, maxMutations: 10, maxTotalContentBytes: 40960, maxRecordTtlMs: 86400000,
      kinds: ['fact', 'experience'], operations: ['add', 'replace', 'remove'] }
    value.manifest.memoryLearning = { reviews, adoption, limits: { extractions: 7, scans: 1440 },
      learning: { authorityId: 'memory-extraction', owner, databasePath: join(value.root, 'memory-learning.sqlite'),
        expiresAt, maxExtractions: 10, maxPending: 10, lookbackMs: 86400000,
        policy: 'Learn explicit owner facts or source-bound experience.', maxInputBytes: 65536,
        maxOutputTokens: 2048, timeoutMs: 120000, budgetId: 'memory-extractions', budgetAmount: 1,
        scanBudgetId: 'memory-scans', scanBudgetAmount: 1,
        reviewAuthorityId: reviews.authorityId, reviewAuthorityDigest: growthObjectDigest(reviews),
        adoptionAuthorityId: adoption.authorityId, adoptionGrantDigest: growthObjectDigest(adoption) } }
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
    const original = structuredClone(value.manifest.memoryLearning)
    value.manifest.memoryLearning.learning.owner = { ...owner, principalVersion: owner.principalVersion + 1 }
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow('owner differs')
    value.manifest.memoryLearning = structuredClone(original)
    value.manifest.memoryLearning.learning.reviewAuthorityDigest = 'b'.repeat(64)
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow('digest binding')
    value.manifest.memoryLearning = structuredClone(original)
    value.manifest.memoryLearning.reviews.expiresAt = Date.now() - 1
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow('expiry')
    value.manifest.memoryLearning = original
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test('accepts four owner-private finite authority files pinned to schema-v4 trust', async () => {
    const value = await fixture()
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test('ignores ambient Host config when trust does not forward it', async () => {
    const value = await fixture()
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = `${value.root}/unused.json`
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test('accepts separately trusted finite live qualification and rejects changed window, key, and grant expiry', async () => {
    const value = await fixture(true)
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
    const original = await value.readAuthority('qualifications')
    for (const changed of [
      { ...original, grant: { ...original.grant, terms: { ...original.grant.terms, maximumWindowMs: 120_000 } } },
      { ...original, keyPath: (await value.readAuthority('observations')).keyPath },
      { ...original, grant: { ...original.grant, expiresAt: Date.now() - 1 } },
    ]) {
      await value.writeAuthority('qualifications', changed)
      await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow('live qualification authority')
    }
  })

  test.each([
    ['owner', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('approvals'); authority.grant.owner.principalRecordId = 'other-owner'; await value.writeAuthority('approvals', authority) }, 'authority owner/ledger mismatch'],
    ['ledger', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('releases'); authority.controlDatabasePath = `${value.root}/other-control.sqlite`; await value.writeAuthority('releases', authority) }, 'authority owner/ledger mismatch'],
    ['key', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('adoptions'); authority.keyPath = (await value.readAuthority('releases')).keyPath; await value.writeAuthority('adoptions', authority) }, 'authority key does not match registered trust'],
    ['expiry', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('observations'); const expiresAt = Date.now() - 1; authority.grant.policy.expiresAt = expiresAt; value.manifest.controlPlane.taskObservations!.policy.expiresAt = expiresAt; await value.writeAuthority('observations', authority) }, 'finite authority has expired'],
    ['allowlists', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('approvals'); authority.grant.plugins = ['other-plugin']; await value.writeAuthority('approvals', authority) }, 'observation package allowlist does not match'],
    ['executor', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('adoptions'); authority.grant.executor.id = 'other-executor'; await value.writeAuthority('adoptions', authority) }, 'authority deployment terms mismatch'],
  ])('rejects %s drift', async (_label, change, message) => {
    const value = await fixture()
    await change(value)
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow(message)
  })

  test('accepts a pinned schema-4 Host wrapper and matching finite resolver grant', async () => {
    const value = await fixture(true)
    const host = await value.standingHost()
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = host.wrapperPath
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test('accepts two Host grant packages in reverse adoption policy order', async () => {
    const value = await fixture(true)
    const host = await value.standingHost()
    for (const name of ['approvals', 'releases', 'adoptions', 'observations', 'qualifications'] as const) {
      const authority = await value.readAuthority(name)
      if (name === 'observations' || name === 'qualifications') authority.grant.packages.push('@dsh-enhanced/other-helper')
      else if (name === 'adoptions') authority.grant.policies.push({ ...authority.grant.policies[0],
        candidateId: 'other-helper', packageName: '@dsh-enhanced/other-helper' })
      else {
        authority.grant.plugins.push('other-helper')
        if (name === 'releases') authority.grant.policies.push({ ...authority.grant.policies[0],
          candidateId: 'other-helper', packageName: '@dsh-enhanced/other-helper', packagePath: 'plugins/other-helper' })
      }
      await value.writeAuthority(name, authority)
    }
    const reviewPlugins = value.manifest.sourceReviews.plugins as string[]
    reviewPlugins.push('other-helper')
    const config = await host.readResolver()
    config.grant.packages = ['@dsh-enhanced/other-helper', '@dsh-enhanced/health-helper']
    await host.writeResolver(config)
    const wrapper = await host.readWrapper()
    wrapper.resolver.configSha256 = createHash('sha256').update(await readFile(host.resolverConfigPath)).digest('hex')
    await host.writeWrapper(wrapper)
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = host.wrapperPath
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test.each([
    ['unknown wrapper schema', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const wrapper = await host.readWrapper(); wrapper.schemaVersion = 5; await host.writeWrapper(wrapper)
    }, 'unknown wrapper schema'],
    ['wrapper fields', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const wrapper = await host.readWrapper(); wrapper.unexpected = true; await host.writeWrapper(wrapper)
    }, 'wrapper fields differ from runtime contract'],
    ['resolver digest', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const config = await host.readResolver(); config.grant.maximumReloads = 3; await host.writeResolver(config)
    }, 'resolver config pin changed'],
    ['wrapper executable', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const wrapper = await host.readWrapper(); wrapper.template.executable.sha256 = '0'.repeat(64); await host.writeWrapper(wrapper)
    }, 'wrapper differs from trusted attestor'],
    ['resolver executable', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const wrapper = await host.readWrapper(); wrapper.resolver.executable.sha256 = '0'.repeat(64); await host.writeWrapper(wrapper)
    }, 'trusted executable identity or digest changed'],
    ['resolver interpreter', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const wrapper = await host.readWrapper(); const path = await realpath('/usr/bin/true')
      wrapper.resolver.interpreter = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
      await host.writeWrapper(wrapper)
    }, 'pinned interpreter cannot run shipped resolver'],
    ['owner grant', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const config = await host.readResolver(); config.grant.owner.principalRecordId = 'other-owner'; await host.writeResolver(config)
      const wrapper = await host.readWrapper(); wrapper.resolver.configSha256 = createHash('sha256').update(await readFile(host.resolverConfigPath)).digest('hex'); await host.writeWrapper(wrapper)
    }, 'grant deployment terms differ'],
    ['deployment inputs', async (host: Awaited<ReturnType<RsiAuthorityFixture['standingHost']>>) => {
      const config = await host.readResolver(); config.grant.hostDeploymentInputs = ['package.json']; await host.writeResolver(config)
      const wrapper = await host.readWrapper(); wrapper.resolver.configSha256 = createHash('sha256').update(await readFile(host.resolverConfigPath)).digest('hex'); await host.writeWrapper(wrapper)
    }, 'grant deployment terms differ'],
  ])('rejects schema-4 %s drift', async (_label, change, message) => {
    const value = await fixture(true)
    const host = await value.standingHost()
    process.env.DSH_SYSTEMD_HOST_ATTESTOR_CONFIG = host.wrapperPath
    await change(host)
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow(message)
  })
})
