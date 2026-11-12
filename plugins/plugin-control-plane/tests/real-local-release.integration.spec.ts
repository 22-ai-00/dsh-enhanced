/**
 * D3a-0a: real local release adapter -> store release-complete (opt-in only).
 *
 * Opt-in preconditions (R6): Linux, DSH_REAL_LOCAL_E2E=1, DSH_REAL_LOCAL_DSH
 * pointing at a real dsh launcher, a pinned pnpm toolchain (prefers
 * DSH_TEST_PNPM_ROOT) and readable pnpm store metadata. Without both env
 * variables all cases are skipped; the default pnpm check is unchanged.
 *
 * Git environment (R4): the fixture creates its own disposable repository and
 * bare remote, and drives the shipped adapter with an explicit git executable,
 * author and GIT_CONFIG_NOSYSTEM=1/GIT_CONFIG_GLOBAL=/dev/null inside the
 * adapter. It still runs the host git binary, so the gate host's git version is
 * part of the environment, not something this test pins.
 *
 * Non-standard machines (R5): when DSH_TEST_PNPM_ROOT is absent the fixture
 * falls back to copying /usr/lib/node_modules/pnpm and seeding the store from
 * pnpm store path; that fallback is for developer machines only. The gate
 * environment must provide DSH_TEST_PNPM_ROOT, pnpm_config_store_dir and a
 * readable store index (index.db plus files/) for the real run.
 */
import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { loadCatalogWithMetadata } from '../src/catalog.ts'
import * as release from '../src/release.ts'
import { d3a0Enabled, realLocalReleaseFixture } from './helpers/real-local/release.ts'

const fixtures: Awaited<ReturnType<typeof realLocalReleaseFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close() })

test.skipIf(!d3a0Enabled)('runs all eight local release phases with real signed receipts and a local file registry', async () => {
  const f = await realLocalReleaseFixture(); fixtures.push(f)
  const completed = await f.advance()
  expect(completed.status).toBe('release-complete')
  expect(completed.release?.fence).toBe(1)
  const phases = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'] as const
  for (const phase of phases) {
    const operation = f.store.findSourceReleaseOperation(f.plan.id, phase, completed.release!.fence)
    expect(operation?.receipt, phase).toBeDefined()
    const receipt = operation!.receipt!
    expect(receipt.phase).toBe(phase)
    expect(receipt.outcome).toBe('passed')
    const key = f.trust.releaseKeys.find(item => item.authority === receipt.authority && item.keyId === receipt.keyId)!
    const { signature, ...unsigned } = receipt
    expect(verify(null, Buffer.from(release.sourceReleaseSigningPayload(unsigned)), createPublicKey(key.publicKeyPem), Buffer.from(signature, 'base64')), phase).toBe(true)
  }
  const build = f.store.findSourceReleaseOperation(f.plan.id, 'build', completed.release!.fence)!.receipt!
  expect(build.evidence.kind).toBe('build')
  if (build.evidence.kind !== 'build') throw new Error('build evidence missing')
  const registryBytes = await readFile(fileURLToPath(f.policy.registryReference))
  expect(build.evidence.tarballSha256).toMatch(/^[a-f0-9]{64}$/u)
  const catalog = await loadCatalogWithMetadata(f.policy.catalogPath)
  const entry = catalog.catalog.entries.find((item: { package: string }) => item.package === f.policy.packageName)
  expect(entry).toMatchObject({ package: f.policy.packageName, version: f.policy.packageVersion,
    registry: { locator: f.policy.registryLocator, reference: f.policy.registryReference } })
  expect(entry?.integrity).toMatch(/^sha512-/u)
  expect(registryBytes.length).toBe(build.evidence.tarballBytes)

  const operations = phases.map(phase => f.store.findSourceReleaseOperation(f.plan.id, phase, completed.release!.fence)!.operationId)
  const replay = await f.advance()
  expect(replay.revision).toBe(completed.revision)
  expect(phases.map(phase => f.store.findSourceReleaseOperation(f.plan.id, phase, completed.release!.fence)!.operationId)).toEqual(operations)
}, 600_000)

test.skipIf(!d3a0Enabled)('fails closed when the authorized source bytes change before the PR phase', async () => {
  const f = await realLocalReleaseFixture({ name: 'e2e-tampered' }); fixtures.push(f)
  const target = join(f.repository, 'plugins', 'e2e-tampered', 'lib', 'index.js')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(target, 'export function apply() { throw new Error("tampered") }\n', { mode: 0o600 })
  await expect(f.advanceOnce()).rejects.toThrow(/release-adapter\[pr:FAILED\]|source bytes changed|source change/u)
  expect(f.store.getSourcePlan(f.plan.id).status).not.toBe('release-complete')
  expect(f.store.findSourceReleaseOperation(f.plan.id, 'pr', 1)?.receipt).toBeUndefined()
}, 300_000)

test.skipIf(!d3a0Enabled)('fails closed on a tampered independent review decision', async () => {
  const f = await realLocalReleaseFixture({ name: 'e2e-tampered-review' }); fixtures.push(f)
  const first = await f.advanceOnce()
  expect(first.status).not.toBe('release-complete')
  const operation = f.store.findSourceReleaseOperation(f.plan.id, 'review', 1)!
  if (operation.request.phase !== 'review') throw new Error('review request missing')
  const input = operation.request.input as { prId: string; baseCommit: string; headCommit: string; prEvidenceDigest: string }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(f.root, 'review-decisions', input.prId + '.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'dsh-local-review-decision', ...input, baseCommit: '0'.repeat(40), decision: 'approved',
    reviewerPrincipal: 'd3a0-independent-reviewer' }), { mode: 0o600 })
  await expect(f.advanceRaw()).rejects.toThrow(/review decision is not bound|reviewed PR is not based|independent review decision does not match/u)
  expect(f.store.getSourcePlan(f.plan.id).status).not.toBe('release-complete')
}, 300_000)
