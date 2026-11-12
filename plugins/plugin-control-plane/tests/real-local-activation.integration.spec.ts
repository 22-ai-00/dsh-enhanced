/**
 * D3a-0b: real activation staging -> real dsh profile -> shipped runtime observer
 * -> test-only schema-2 Host attestor. Linux-only opt-in (DSH_REAL_LOCAL_E2E=1,
 * DSH_REAL_LOCAL_DSH), same env contract as D3a-0a.
 *
 * C semantics (deliberate, not a workaround): this plan has no owner-bound
 * source release, no handoff and no liveQualification. After a passed readiness
 * attestation the store therefore stops at `awaiting-effect-blocked-replay`:
 * without independent effect evidence the deployment must not advance to
 * `awaiting-live-tasks` or commit. liveQualification, bounded live tasks and
 * commit belong to D3a-1 and require an owner-bound prepared modify release +
 * handoff; D3a-0a's non-owner create release is not accepted there by design.
 *
 * Entry discovery: after `activatePluginPlan` swaps the profile, the fixture
 * reads the actual profile `cordis.patch.yml`, then (for a bundle installed by
 * `dsh plugin add`) the installed package's own `cordis.patch.yml`. The entry
 * id/name/config are read back, not guessed. On this gate dsh runtime the
 * profile manifest bundle list does not mount a local bundle, so the same
 * installed package is pinned through an `insert` group in the profile patch
 * before the Host starts; the entry still comes from the installed package.
 * The test-only Host attestor executable and its Ed25519 key live only in the
 * fixture temp root and never enter a shipped profile/trust config.
 */
import { afterEach, expect, test } from 'vitest'
import { d3a0Enabled } from './helpers/real-local/release.ts'
import { realLocalActivationFixture } from './helpers/real-local/activation.ts'

const fixtures: Awaited<ReturnType<typeof realLocalActivationFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close() })

test.skipIf(!d3a0Enabled)('activates a real profile, samples real Loader fibers and stops at awaiting-effect-blocked-replay', async () => {
  const f = await realLocalActivationFixture(); fixtures.push(f)
  expect(f.plan.status).toBe('awaiting-reload')
  expect(f.plan.dossier.liveQualification).toBeUndefined()

  const reloaded = await f.probe()
  expect(reloaded.status).toBe('awaiting-readiness')
  const sample = await f.sample()
  const target = f.targets[0]!
  const entry = sample.entries.find(item => item.entryId === target.entryId)
  expect(entry).toBeDefined()
  expect(entry?.active).toBe(true)
  expect(entry?.module).toBe(target.module)
  expect(entry?.configDigest).toBe(target.configDigest)
  expect(entry?.services.map(item => item.name).sort()).toEqual([...target.services].sort())
  expect([...(entry?.dependencies ?? []), ...(entry?.services ?? [])].every(item => item.instance !== null)).toBe(true)

  const ready = await f.probe()
  // C: without liveQualification the design deliberately stops here; it must not
  // continue to awaiting-live-tasks or commit without independent effect evidence.
  expect(ready.status).toBe('awaiting-effect-blocked-replay')
  expect(ready.status).not.toBe('awaiting-live-tasks')
}, 600_000)

test.skipIf(!d3a0Enabled)('rejects an altered/inactive runtime sample during readiness', async () => {
  const f = await realLocalActivationFixture(); fixtures.push(f)
  await f.probe()
  await f.writeHostConfig(true)
  let rejected = false
  try { await f.probe() } catch { rejected = true }
  const status = f.release.store.getPlan(f.plan.id).status
  expect(status).not.toBe('awaiting-effect-blocked-replay')
  expect(status).not.toBe('awaiting-live-tasks')
  expect(rejected || status === 'rollback-pending' || status === 'rolled-back').toBe(true)
}, 600_000)
