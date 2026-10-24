import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseProgramUpgradeArgs } from '../scripts/install/upgrade-program.mjs'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(originalVersion = '0.2.0-rc.2') {
  const runtime = (version: string) => ({ version, root: `/private/hosts/${version}`,
    dshPath: `/private/hosts/${version}/node_modules/.bin/dsh`,
    binDirectory: `/private/hosts/${version}/node_modules/.bin`,
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, receiptDigest: digest(version) })
  const original = runtime(originalVersion), candidate = runtime('0.2.1-rc.2')
  const binding = (value: typeof original) => JSON.stringify({ schemaVersion: 1,
    cacheRoot: '/private/hosts', version: value.version, receiptDigest: value.receiptDigest }) + '\n'
  const plan = { schemaVersion: 1, status: originalVersion === candidate.version ? 'current' : 'update',
    canonicalHome: '/private/home', bindingPath: '/private/home/.dsh-rsi-host.json',
    originalBindingSource: binding(original), originalBindingDigest: digest(binding(original)),
    originalRuntime: original, candidateRuntime: candidate, candidateBindingSource: binding(candidate) }
  const coordinatorProfile = `rsi-assistant-${digest('assistant').slice(0, 12)}`
  const services = ['assistant', coordinatorProfile].map(profile => ({ profile,
    unit: `dsh-profile-${profile}.service`, wasActive: true }))
  return { plan, services, coordinatorProfile }
}

describe('program-only upgrade entry', () => {
  it('accepts a current owner pair for a newer or unchanged supported Host', () => {
    for (const original of ['0.2.0-rc.2', '0.2.1-rc.2']) {
      const setup = fixture(original)
      expect(lifecycleProfileTest.hostOwnerProgramSelection(setup.plan, setup.services, 'assistant'))
        .toEqual({ coordinatorProfile: setup.coordinatorProfile })
    }
  })
  it('rejects missing, inactive or unrelated services before starting a transaction', () => {
    const { plan, services } = fixture()
    for (const pair of [services.slice(0, 1), [...services, { profile: 'web' }],
      [services[0], { ...services[1], wasActive: false }],
      [services[0], { ...services[1], unit: 'unrelated.service' }]]) {
      expect(() => lifecycleProfileTest.hostOwnerProgramSelection(plan, pair, 'assistant')).toThrow()
    }
  })
  it('does not admit legacy ABI migration through the program-only path', () => {
    const { plan, services } = fixture('0.1.5-rc.3')
    expect(() => lifecycleProfileTest.hostOwnerProgramSelection(plan, services, 'assistant')).toThrow('bound supported 0.2 Host')
  })
  it('binds the plan to exact Host receipts instead of only version strings', () => {
    const { plan, services } = fixture()
    plan.candidateRuntime.receiptDigest = 'f'.repeat(64)
    expect(() => lifecycleProfileTest.hostOwnerProgramSelection(plan, services, 'assistant')).toThrow('receipt')
  })
  it('requires explicit Home/profile and rejects setup or permission-changing options', () => {
    const base = ['--dsh-home', '/private/home', '--profile', 'assistant']
    expect(parseProgramUpgradeArgs([...base, '--dry-run'])).toMatchObject({ home: '/private/home',
      profile: 'assistant', selector: 'latest', dryRun: true, recover: false })
    expect(parseProgramUpgradeArgs([...base, '--recover'])).toMatchObject({ recover: true })
    expect(parseProgramUpgradeArgs([...base, '--recover-readiness'])).toMatchObject({ recoverReadiness: true, recover: false })
    expect(parseProgramUpgradeArgs([...base, '--recover-rollback-readiness']))
      .toMatchObject({ recoverRollbackReadiness: true, recover: false, recoverReadiness: false })
    for (const args of [[], ['--dsh-home', 'relative', '--profile', 'assistant'],
      [...base, '--install-owner'], [...base, '--permission-preset', 'danger-full-access'],
      [...base, '--dsh-version', 'next'], [...base, '--profile', 'web'],
      [...base, '--recover-readiness', '--recover'], [...base, '--recover-readiness', '--dsh-version', 'latest'],
      [...base, '--recover-rollback-readiness', '--recover'],
      [...base, '--recover-rollback-readiness', '--recover-readiness'],
      [...base, '--recover-rollback-readiness', '--dsh-version', 'latest']]) {
      expect(() => parseProgramUpgradeArgs(args)).toThrow()
    }
  })
})
